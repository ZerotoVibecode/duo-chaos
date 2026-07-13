import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/u
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const DEFAULT_INPUT_FILE_BYTES = 2_000_000
const DEFAULT_OUTPUT_BYTES = 256_000
const DEFAULT_MAX_FILES = 128
const MAX_DISCOVERED_FILES = 1_024

type JsonRecord = Record<string, unknown>
type Agent = 'claude' | 'codex'

export interface SupportBundleCapabilityInput {
  cliVersion?: string
  adapterVersion?: string
  streamFormat?: string
  structuredOutput?: boolean
  sessionResume?: boolean
}

export interface CreateSupportBundleInput {
  runtimePath: string
  workspacePath: string
  runId: string
  capabilities?: Partial<Record<Agent, SupportBundleCapabilityInput>>
  failureCode?: string
  sensitiveTerms?: string[]
  maxInputFileBytes?: number
  maxOutputBytes?: number
  maxFiles?: number
}

export interface SupportBundleUsageTotals {
  processedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  calls: number
  reportedCostUsd?: number
}

export interface SupportBundleFile {
  scope: 'runtime' | 'workspace'
  path: string
  sizeBytes: number
  sha256: string
  hashScope: 'full' | 'prefix'
}

export interface SupportBundleReport {
  schemaVersion: 1
  runId: string
  status: string
  phase?: string
  failureCode?: string
  pause?: {
    reason: string
    agent?: Agent
    detailCode?: string
    resetAt?: string
  }
  cursor?: {
    turnIndex: number
    stage: string
    attempt: number
  }
  capabilities?: Partial<Record<Agent, {
    cliVersion: string
    adapterVersion?: string
    streamFormat: string
    structuredOutput: boolean
    sessionResume: boolean
  }>>
  usage: Record<Agent | 'total', SupportBundleUsageTotals>
  events: {
    total: number
    invalidLines: number
    byType: Record<string, number>
    truncated: boolean
  }
  files: SupportBundleFile[]
  limits: {
    maxInputFileBytes: number
    maxOutputBytes: number
    maxFiles: number
    inputTruncated: boolean
    inventoryTruncated: boolean
    outputTruncated: boolean
  }
}

export interface SupportBundle {
  report: SupportBundleReport
  json: string
  text: string
}

export class SupportBundleIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SupportBundleIdentityError'
  }
}

interface BoundedFile {
  bytes: Buffer
  sizeBytes: number
  truncated: boolean
}

interface InventoryCandidate {
  scope: SupportBundleFile['scope']
  root: string
  absolutePath: string
  relativePath: string
}

function recordOf(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

async function assertRunDirectory(path: string, runId: string, label: string): Promise<string> {
  const expected = resolve(path)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(expected)
  } catch (error) {
    throw new SupportBundleIdentityError(`${label} is unavailable.`, { cause: error })
  }
  if (!info.isDirectory() || info.isSymbolicLink() || basename(expected) !== runId) {
    throw new SupportBundleIdentityError(`${label} does not match the requested run identity.`)
  }
  const canonical = await realpath(expected)
  if (comparablePath(canonical) !== comparablePath(expected)) {
    throw new SupportBundleIdentityError(`${label} must be a canonical, non-aliased directory.`)
  }
  return expected
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<BoundedFile | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.isSymbolicLink()) return undefined
  const bytesToRead = Math.min(info.size, maximumBytes)
  const bytes = Buffer.alloc(bytesToRead)
  const handle = await open(path, 'r')
  try {
    if (bytesToRead > 0) await handle.read(bytes, 0, bytesToRead, 0)
  } finally {
    await handle.close()
  }
  return { bytes, sizeBytes: info.size, truncated: info.size > maximumBytes }
}

function parseJsonFile(file: BoundedFile | undefined): JsonRecord | undefined {
  if (!file || file.truncated) return undefined
  try {
    return recordOf(JSON.parse(file.bytes.toString('utf8')) as unknown)
  } catch {
    return undefined
  }
}

function safeCode(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLocaleLowerCase()
  return CODE_PATTERN.test(normalized) ? normalized : fallback
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function versionOnly(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  return value.match(/\b\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?\b/u)?.[0] ?? 'unknown'
}

function usageOf(value: unknown): SupportBundleUsageTotals {
  const usage = recordOf(value)
  const reportedCostUsd = finiteNonNegative(usage?.reportedCostUsd)
  return {
    processedInputTokens: finiteNonNegative(usage?.processedInputTokens),
    cachedInputTokens: finiteNonNegative(usage?.cachedInputTokens),
    outputTokens: finiteNonNegative(usage?.outputTokens),
    reasoningTokens: finiteNonNegative(usage?.reasoningTokens),
    calls: finiteNonNegative(usage?.calls),
    ...(reportedCostUsd > 0 ? { reportedCostUsd } : {})
  }
}

function addUsage(left: SupportBundleUsageTotals, right: SupportBundleUsageTotals): SupportBundleUsageTotals {
  const reportedCostUsd = (left.reportedCostUsd ?? 0) + (right.reportedCostUsd ?? 0)
  return {
    processedInputTokens: left.processedInputTokens + right.processedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    calls: left.calls + right.calls,
    ...(reportedCostUsd > 0 ? { reportedCostUsd } : {})
  }
}

function usageReport(manifest: JsonRecord | undefined, run: JsonRecord | undefined): SupportBundleReport['usage'] {
  const source = recordOf(manifest?.usage) ?? recordOf(run?.agentUsage)
  const claude = usageOf(source?.claude)
  const codex = usageOf(source?.codex)
  return { claude, codex, total: addUsage(claude, codex) }
}

function capabilityReport(
  capabilities: CreateSupportBundleInput['capabilities']
): SupportBundleReport['capabilities'] {
  if (!capabilities) return undefined
  const output: NonNullable<SupportBundleReport['capabilities']> = {}
  for (const agent of ['claude', 'codex'] as const) {
    const capability = capabilities[agent]
    if (!capability) continue
    const streamFormat = safeCode(capability.streamFormat, 'unknown') ?? 'unknown'
    output[agent] = {
      cliVersion: versionOnly(capability.cliVersion),
      ...(safeCode(capability.adapterVersion) ? { adapterVersion: safeCode(capability.adapterVersion) } : {}),
      streamFormat,
      structuredOutput: capability.structuredOutput === true,
      sessionResume: capability.sessionResume === true
    }
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function privateTermPattern(value: string): RegExp | undefined {
  const parts = value.trim().split(/[\s_-]+/u).filter(Boolean)
  if (parts.length === 0) return undefined
  return new RegExp(parts.map(escapeRegex).join('[\\s_-]+'), 'giu')
}

async function loadPrivateTerms(
  workspacePath: string,
  supplied: string[] | undefined,
  maximumBytes: number
): Promise<{ terms: RegExp[]; truncated: boolean }> {
  const values = (supplied ?? []).filter((value) => value.trim().length >= 3)
  const file = await readBoundedFile(join(workspacePath, '.duo', 'sealed', 'redactions.json'), maximumBytes)
  const redactions = parseJsonFile(file)
  if (Array.isArray(redactions?.terms)) {
    for (const candidate of redactions.terms) {
      const value = recordOf(candidate)?.value
      if (typeof value === 'string' && value.trim().length >= 3) values.push(value)
    }
  }
  return {
    terms: values.flatMap((value) => {
      const pattern = privateTermPattern(value)
      return pattern ? [pattern] : []
    }),
    truncated: file?.truncated === true
  }
}

const SAFE_PATH_PARTS = new Set([
  '.duo', 'app', 'src', 'public', 'assets', 'styles', 'components',
  'index.html', 'index.js', 'index.ts', 'index.tsx', 'main.js', 'main.ts', 'main.tsx',
  'app.js', 'app.ts', 'app.tsx', 'package.json', 'package-lock.json', 'readme.md',
  'agents.md', 'claude.md', 'board.json', 'claims.json', 'locks.json', 'timeline.jsonl',
  'dispatches.jsonl', 'opinions.jsonl', 'conflicts.jsonl', 'decisions.jsonl', 'tasks.jsonl',
  'build.jsonl', 'run.json', 'run-manifest.json', 'run-journal.jsonl', 'tsconfig.json',
  'vite.config.js', 'vite.config.ts', 'runtime'
])

function sanitizePathPart(part: string, privateTerms: RegExp[]): string {
  let sanitized = part
  for (const pattern of privateTerms) sanitized = sanitized.replace(pattern, '[PRIVATE]')
  sanitized = sanitized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[PRIVATE]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/giu, '[PRIVATE]')
  if (sanitized.includes('[PRIVATE]')) return sanitized.slice(0, 120)
  if (SAFE_PATH_PARTS.has(sanitized.toLocaleLowerCase())) return sanitized.slice(0, 120)
  const extension = extname(sanitized).slice(0, 20).replace(/[^A-Za-z0-9.]/gu, '')
  const fingerprint = createHash('sha256').update(sanitized).digest('hex').slice(0, 10)
  return `file-${fingerprint}${extension}`
}

function sanitizeRelativePath(path: string, privateTerms: RegExp[]): string {
  return path
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map((part) => sanitizePathPart(part, privateTerms))
    .join('/')
}

function pathInside(candidate: string, parent: string): boolean {
  const comparableCandidate = comparablePath(candidate)
  const comparableParent = comparablePath(parent)
  return comparableCandidate === comparableParent || comparableCandidate.startsWith(`${comparableParent}${sep}`)
}

async function discoverWorkspaceFiles(workspacePath: string): Promise<{ files: InventoryCandidate[]; truncated: boolean }> {
  const files: InventoryCandidate[] = []
  let truncated = false
  let examined = 0
  const excludedDirectories = new Set(['.git', 'node_modules', 'out', 'release', 'coverage', 'private', 'sealed'])
  const roots = [
    'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'CLAUDE.md',
    '.duo/board.json', '.duo/claims.json', '.duo/locks.json', '.duo/public', 'app'
  ]

  const visit = async (absolutePath: string): Promise<void> => {
    if (examined >= MAX_DISCOVERED_FILES) {
      truncated = true
      return
    }
    examined += 1
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(absolutePath)
    } catch {
      return
    }
    if (info.isSymbolicLink()) return
    if (info.isFile()) {
      const relativePath = relative(workspacePath, absolutePath)
      if (relativePath.startsWith('..') || resolve(workspacePath, relativePath) !== resolve(absolutePath)) return
      files.push({ scope: 'workspace', root: workspacePath, absolutePath, relativePath })
      return
    }
    if (!info.isDirectory() || excludedDirectories.has(basename(absolutePath).toLocaleLowerCase())) return
    const entries = await readdir(absolutePath, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (examined >= MAX_DISCOVERED_FILES) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      await visit(join(absolutePath, entry.name))
    }
  }

  for (const root of roots) await visit(join(workspacePath, root))
  return { files, truncated }
}

async function inventoryFiles(
  runtimePath: string,
  workspacePath: string,
  maximumBytes: number,
  maximumFiles: number,
  privateTerms: RegExp[]
): Promise<{ files: SupportBundleFile[]; inputTruncated: boolean; inventoryTruncated: boolean }> {
  const runtimeFiles = ['run.json', 'run-manifest.json', 'run-journal.jsonl', 'public/timeline.jsonl']
    .map((relativePath): InventoryCandidate => ({
      scope: 'runtime',
      root: runtimePath,
      absolutePath: join(runtimePath, relativePath),
      relativePath: `runtime/${relativePath}`
    }))
  const workspace = await discoverWorkspaceFiles(workspacePath)
  const candidates = [...runtimeFiles, ...workspace.files]
  const files: SupportBundleFile[] = []
  let inputTruncated = false
  let limitReached = false
  for (const candidate of candidates) {
    if (files.length >= maximumFiles) {
      limitReached = true
      break
    }
    if (!pathInside(candidate.absolutePath, candidate.root)) continue
    const file = await readBoundedFile(candidate.absolutePath, maximumBytes)
    if (!file) continue
    inputTruncated ||= file.truncated
    files.push({
      scope: candidate.scope,
      path: sanitizeRelativePath(candidate.relativePath, privateTerms),
      sizeBytes: file.sizeBytes,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
      hashScope: file.truncated ? 'prefix' : 'full'
    })
  }
  return {
    files,
    inputTruncated,
    inventoryTruncated: workspace.truncated || limitReached
  }
}

function eventCounts(file: BoundedFile | undefined): SupportBundleReport['events'] {
  if (!file) return { total: 0, invalidLines: 0, byType: {}, truncated: false }
  const lines = file.bytes.toString('utf8').split(/\r?\n/u)
  if (file.truncated) lines.pop()
  const byType: Record<string, number> = {}
  let total = 0
  let invalidLines = 0
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const type = safeCode(recordOf(JSON.parse(line) as unknown)?.type)
      if (!type) {
        invalidLines += 1
        continue
      }
      byType[type] = (byType[type] ?? 0) + 1
      total += 1
    } catch {
      invalidLines += 1
    }
  }
  return {
    total,
    invalidLines,
    byType: Object.fromEntries(Object.entries(byType).sort(([left], [right]) => left.localeCompare(right))),
    truncated: file.truncated
  }
}

function cursorOf(manifest: JsonRecord | undefined): SupportBundleReport['cursor'] {
  const cursor = recordOf(manifest?.cursor)
  const stage = safeCode(cursor?.stage)
  if (!cursor || !stage) return undefined
  return {
    turnIndex: boundedInteger(cursor.turnIndex, 0, 0, 10_000),
    stage,
    attempt: boundedInteger(cursor.attempt, 1, 1, 1_000)
  }
}

function pauseOf(manifest: JsonRecord | undefined): SupportBundleReport['pause'] {
  const pause = recordOf(manifest?.pause)
  const reason = safeCode(pause?.reason)
  if (!reason) return undefined
  const agent = pause?.agent === 'claude' || pause?.agent === 'codex' ? pause.agent : undefined
  const detailCode = safeCode(pause?.detailCode)
  const resetAt = safeTimestamp(pause?.resetAt)
  return {
    reason,
    ...(agent ? { agent } : {}),
    ...(detailCode ? { detailCode } : {}),
    ...(resetAt ? { resetAt } : {})
  }
}

function renderText(report: SupportBundleReport): string {
  const lines = [
    'Duo Chaos diagnostic support report',
    `Run: ${report.runId}`,
    `Status: ${report.status}`,
    ...(report.phase ? [`Phase: ${report.phase}`] : []),
    ...(report.failureCode ? [`Failure code: ${report.failureCode}`] : []),
    ...(report.pause ? [`Pause: ${report.pause.reason}${report.pause.agent ? ` (${report.pause.agent})` : ''}`] : []),
    ...(report.cursor ? [`Cursor: turn ${String(report.cursor.turnIndex)}, ${report.cursor.stage}, attempt ${String(report.cursor.attempt)}`] : []),
    `Events: ${String(report.events.total)} (${String(report.events.invalidLines)} invalid lines)`,
    `Usage: ${String(report.usage.total.processedInputTokens)} processed input, ${String(report.usage.total.outputTokens)} output, ${String(report.usage.total.calls)} calls`,
    `Files: ${String(report.files.length)} bounded fingerprints`,
    '',
    'Event types:',
    ...Object.entries(report.events.byType).map(([type, count]) => `- ${type}: ${String(count)}`),
    '',
    'File fingerprints:',
    ...report.files.map((file) => `- ${file.path} | ${String(file.sizeBytes)} bytes | ${file.hashScope} ${file.sha256}`)
  ]
  return `${lines.join('\n')}\n`
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return bytes.subarray(0, maximumBytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function fitReport(report: SupportBundleReport, maximumBytes: number): SupportBundleReport {
  let candidate = report
  while (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maximumBytes && candidate.files.length > 0) {
    candidate = {
      ...candidate,
      files: candidate.files.slice(0, -1),
      limits: { ...candidate.limits, inventoryTruncated: true, outputTruncated: true }
    }
  }
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maximumBytes) return candidate
  return {
    ...candidate,
    capabilities: undefined,
    events: { ...candidate.events, byType: {}, truncated: true },
    limits: { ...candidate.limits, outputTruncated: true }
  }
}

export async function createSupportBundle(input: CreateSupportBundleInput): Promise<SupportBundle> {
  if (!RUN_ID_PATTERN.test(input.runId)) throw new SupportBundleIdentityError('Invalid run identity.')
  const maximumInputBytes = boundedInteger(
    input.maxInputFileBytes,
    DEFAULT_INPUT_FILE_BYTES,
    256,
    8_000_000
  )
  const maximumOutputBytes = boundedInteger(input.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 2_048, 1_000_000)
  const maximumFiles = boundedInteger(input.maxFiles, DEFAULT_MAX_FILES, 1, 512)
  const [runtimePath, workspacePath] = await Promise.all([
    assertRunDirectory(input.runtimePath, input.runId, 'Runtime record'),
    assertRunDirectory(input.workspacePath, input.runId, 'Workspace')
  ])

  const [runFile, manifestFile, timelineFile, privateTermsResult] = await Promise.all([
    readBoundedFile(join(runtimePath, 'run.json'), maximumInputBytes),
    readBoundedFile(join(runtimePath, 'run-manifest.json'), maximumInputBytes),
    readBoundedFile(join(runtimePath, 'public', 'timeline.jsonl'), maximumInputBytes),
    loadPrivateTerms(workspacePath, input.sensitiveTerms, maximumInputBytes)
  ])
  const run = parseJsonFile(runFile)
  const manifest = parseJsonFile(manifestFile)
  if (!run && !manifest) {
    throw new SupportBundleIdentityError('No bounded run state is available for identity validation.')
  }
  for (const state of [run, manifest]) {
    if (state && state.runId !== input.runId) {
      throw new SupportBundleIdentityError('Run state does not match the requested run identity.')
    }
  }
  if (typeof run?.workspacePath === 'string' && comparablePath(run.workspacePath) !== comparablePath(workspacePath)) {
    throw new SupportBundleIdentityError('Run state does not match the requested workspace identity.')
  }

  const inventory = await inventoryFiles(
    runtimePath,
    workspacePath,
    maximumInputBytes,
    maximumFiles,
    privateTermsResult.terms
  )
  const status = safeCode(manifest?.status) ?? safeCode(run?.status) ?? 'unknown'
  const phase = safeCode(run?.phase)
  const capabilities = capabilityReport(input.capabilities)
  const failureCode = input.failureCode === undefined
    ? safeCode(run?.failureCode)
    : safeCode(input.failureCode, 'other')
  let report: SupportBundleReport = {
    schemaVersion: 1,
    runId: input.runId,
    status,
    ...(phase ? { phase } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(pauseOf(manifest) ? { pause: pauseOf(manifest) } : {}),
    ...(cursorOf(manifest) ? { cursor: cursorOf(manifest) } : {}),
    ...(capabilities ? { capabilities } : {}),
    usage: usageReport(manifest, run),
    events: eventCounts(timelineFile),
    files: inventory.files,
    limits: {
      maxInputFileBytes: maximumInputBytes,
      maxOutputBytes: maximumOutputBytes,
      maxFiles: maximumFiles,
      inputTruncated: inventory.inputTruncated || runFile?.truncated === true || manifestFile?.truncated === true ||
        timelineFile?.truncated === true || privateTermsResult.truncated,
      inventoryTruncated: inventory.inventoryTruncated,
      outputTruncated: false
    }
  }
  report = fitReport(report, maximumOutputBytes)
  const json = truncateUtf8(`${JSON.stringify(report, null, 2)}\n`, maximumOutputBytes)
  const text = truncateUtf8(renderText(report), maximumOutputBytes)
  return { report, json, text }
}
