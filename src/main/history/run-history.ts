import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type {
  AgentContributionSummary,
  AgentId,
  DuoEvent,
  DuoTask,
  ExecutionMode,
  MissionProfile,
  RecentBuildProof,
  RecentBuildStatus,
  RecentBuildSummary,
  RevealPacket,
  RunPhase,
  RunPauseSnapshot,
  RunSnapshot,
  VisibilityMode
} from '@shared/types'
import { releaseVerificationPassCount } from '@shared/verification-evidence'
import { safeReadProtocolText } from '@main/workspace/safe-protocol-files'
import { parseProviderRuntimeObservation } from '@main/process/runtime-provenance'

const MAX_JSON_BYTES = 512_000
const MAX_TIMELINE_BYTES = 4_000_000
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/

export interface RecentBuildScanOptions {
  /** Supervisor-owned run records. Legacy in-workspace records are still scanned as a fallback. */
  runtimeRoot?: string
}

type JsonRecord = Record<string, unknown>

function recordOf(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

function isInside(candidate: string, root: string): boolean {
  const path = comparablePath(candidate)
  const parent = comparablePath(root)
  return path === parent || path.startsWith(`${parent}${sep}`)
}

async function safeRecordedWorkspacePath(value: unknown, runId: string): Promise<string | undefined> {
  const stored = stringOf(value)
  if (!stored || !isAbsolute(stored) || basename(stored) !== runId) return undefined
  const candidate = resolve(stored)
  try {
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    const canonical = await realpath(candidate)
    return comparablePath(canonical) === comparablePath(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function boundedText(value: unknown, maximum = 2_000): string | undefined {
  const text = stringOf(value)
  return text ? text.slice(0, maximum) : undefined
}

function boundedStrings(value: unknown, maximumItems = 64, maximumLength = 1_200): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = boundedText(entry, maximumLength)
        return text ? [text] : []
      }).slice(0, maximumItems)
    : []
}

function archivedRevealPacket(value: JsonRecord | undefined): RevealPacket | undefined {
  if (!value) return undefined
  const appName = boundedText(value.appName, 160)
  const idea = boundedText(value.idea, 4_000)
  const summary = boundedText(value.summary, 4_000)
  const runCommand = boundedText(value.runCommand, 2_000)
  const appPath = boundedText(value.appPath, 2_000)
  if (!appName || !idea || !summary || !runCommand || !appPath) return undefined
  const quotes = recordOf(value.agentQuotes)
  const status = value.status === 'ready' || value.status === 'failed' ? value.status : 'partial'
  let devUrl: string | undefined
  const requestedDevUrl = boundedText(value.devUrl, 2_000)
  if (requestedDevUrl) {
    try {
      const parsed = new URL(requestedDevUrl)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') devUrl = parsed.toString()
    } catch {
      devUrl = undefined
    }
  }
  return {
    appName,
    idea,
    summary,
    features: boundedStrings(value.features),
    runCommand,
    appPath,
    ...(devUrl ? { devUrl } : {}),
    status,
    whatWorked: boundedStrings(value.whatWorked),
    knownIssues: boundedStrings(value.knownIssues),
    agentDramaSummary: boundedStrings(value.agentDramaSummary),
    gitCheckpoints: boundedStrings(value.gitCheckpoints, 64, 160),
    agentQuotes: {
      claude: boundedText(quotes.claude, 2_000) ?? 'No final Claude quote was recorded.',
      codex: boundedText(quotes.codex, 2_000) ?? 'No final Codex quote was recorded.'
    }
  }
}

const TASK_STATUSES = new Set<DuoTask['status']>(['open', 'claimed', 'in-progress', 'review', 'done', 'blocked'])
const TASK_RISKS = new Set<DuoTask['risk']>(['low', 'medium', 'high'])
const TASK_CLAIMANTS = new Set<NonNullable<DuoTask['claimedBy']>>(['claude', 'codex', 'director', 'system', 'both', 'none'])

function archivedTask(value: unknown): DuoTask | undefined {
  const input = recordOf(value)
  const id = boundedText(input.id, 160)
  const publicTitle = boundedText(input.publicTitle, 400)
  if (!id || !publicTitle) return undefined
  const status = TASK_STATUSES.has(input.status as DuoTask['status']) ? input.status as DuoTask['status'] : 'open'
  const risk = TASK_RISKS.has(input.risk as DuoTask['risk']) ? input.risk as DuoTask['risk'] : 'medium'
  const claimedBy = TASK_CLAIMANTS.has(input.claimedBy as NonNullable<DuoTask['claimedBy']>)
    ? input.claimedBy as NonNullable<DuoTask['claimedBy']>
    : undefined
  return {
    id,
    publicTitle,
    ...(boundedText(input.publicDescription, 2_000) ? { publicDescription: boundedText(input.publicDescription, 2_000) } : {}),
    status,
    ...(claimedBy ? { claimedBy } : {}),
    risk,
    files: boundedStrings(input.files, 128, 500)
  }
}

const EVENT_AGENTS = new Set<AgentId>(['claude', 'codex', 'director', 'system'])

function archivedPublicEvent(value: JsonRecord, runId: string): DuoEvent | undefined {
  const id = boundedText(value.id, 200)
  const type = boundedText(value.type, 80)
  const timestamp = boundedText(value.timestamp, 80)
  const publicText = boundedText(value.publicText, 8_000)
  if (!id || !type || !timestamp || !publicText || value.runId !== runId) return undefined
  const agent = EVENT_AGENTS.has(value.agent as AgentId) ? value.agent as AgentId : 'system'
  const severity = value.severity === 'medium' || value.severity === 'high' || value.severity === 'critical'
    ? value.severity
    : 'low'
  const event: DuoEvent = {
    id,
    type: type as DuoEvent['type'],
    runId,
    round: Number.isFinite(value.round) ? Math.max(0, Math.trunc(value.round as number)) : 0,
    timestamp,
    agent,
    publicText,
    spoilerRisk: Number.isFinite(value.spoilerRisk) ? Math.min(1, Math.max(0, value.spoilerRisk as number)) : 0,
    severity
  }
  const publicStringFields = [
    'topic', 'tone', 'dispatchKind', 'claimKey', 'replyTo', 'publicTopic', 'claudePosition',
    'codexPosition', 'winner', 'resolution', 'impact', 'status', 'stream', 'category'
  ] as const
  for (const field of publicStringFields) {
    const text = boundedText(value[field], 2_000)
    if (text) Object.assign(event, { [field]: text })
  }
  if (EVENT_AGENTS.has(value.targetAgent as AgentId)) event.targetAgent = value.targetAgent as AgentId
  if (EVENT_AGENTS.has(value.source as AgentId)) event.source = value.source as AgentId
  if (Number.isFinite(value.heat)) event.heat = value.heat as number
  if (Number.isFinite(value.confidence)) event.confidence = value.confidence as number
  if (typeof value.rawAvailable === 'boolean') event.rawAvailable = value.rawAvailable
  event.evidenceFiles = boundedStrings(value.evidenceFiles, 128, 500)
  event.relatedTaskIds = boundedStrings(value.relatedTaskIds, 128, 160)
  const task = archivedTask(value.task)
  if (task) event.task = task
  return event
}

function executionModeOf(value: unknown): ExecutionMode {
  return value === 'simulation' || value === 'safe' || value === 'chaos' || value === 'yolo-sandbox'
    ? value
    : 'safe'
}

function visibilityModeOf(value: unknown): VisibilityMode {
  return value === 'blind' || value === 'spoiler-shield' || value === 'full-chaos'
    ? value
    : 'spoiler-shield'
}

function missionProfileOf(value: unknown): MissionProfile {
  return value === 'serious' ? 'serious' : 'surprise'
}

function phaseOf(value: unknown): RunPhase {
  const supported = new Set<RunPhase>([
    'idle', 'preflight', 'workspace.create', 'workspace.seed', 'round.pitch', 'round.critique',
    'round.conflict', 'round.consensus', 'round.tasking', 'round.claim', 'round.code',
    'round.cross-review', 'round.repair', 'round.verify', 'reveal.prepare', 'reveal.ready',
    'paused', 'complete', 'failed', 'cancelled'
  ])
  return supported.has(value as RunPhase) ? value as RunPhase : 'failed'
}

function historyStatusOf(value: unknown): RecentBuildStatus {
  if (value === 'complete' || value === 'paused' || value === 'reveal-ready' || value === 'cancelled' || value === 'failed') return value
  return 'interrupted'
}

async function readBoundedJson(path: string, limit = MAX_JSON_BYTES): Promise<JsonRecord | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return undefined
    return recordOf(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

async function readWorkspaceJson(workspacePath: string, path: string): Promise<JsonRecord | undefined> {
  try {
    const content = await safeReadProtocolText(resolve(workspacePath, '.duo'), path, MAX_JSON_BYTES)
    return content === undefined ? undefined : recordOf(JSON.parse(content) as unknown)
  } catch {
    return undefined
  }
}

async function readPublicTimeline(path: string, protocolRoot?: string): Promise<JsonRecord[]> {
  try {
    const content = protocolRoot
      ? await safeReadProtocolText(protocolRoot, path, MAX_TIMELINE_BYTES)
      : await (async () => {
          const stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TIMELINE_BYTES) return undefined
          return await readFile(path, 'utf8')
        })()
    if (content === undefined) return []
    return content
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [recordOf(JSON.parse(line) as unknown)]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function emptyContribution(): AgentContributionSummary {
  return { turns: 0, edits: 0, messages: 0, tasksDone: 0 }
}

function buildProof(
  board: JsonRecord | undefined,
  events: JsonRecord[],
  releaseStatus?: unknown
): RecentBuildProof {
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(recordOf) : []
  const proof: RecentBuildProof = {
    tasksDone: tasks.filter((task) => task.status === 'done').length,
    tasksTotal: tasks.length,
    checkpoints: events.filter((event) => event.type === 'git.checkpoint').length,
    buildPasses: releaseVerificationPassCount(events, releaseStatus),
    claude: emptyContribution(),
    codex: emptyContribution()
  }

  for (const agent of ['claude', 'codex'] as const) {
    const contribution = proof[agent]
    contribution.turns = events.filter((event) => event.agent === agent && event.type === 'agent.started').length
    contribution.edits = events.filter((event) => event.agent === agent && (
      event.type === 'file.changed' || (event.type === 'agent.activity' && event.category === 'file')
    )).length
    contribution.messages = events.filter((event) => event.agent === agent && (
      event.type === 'agent.dispatch' || event.type === 'opinion'
    )).length
    contribution.tasksDone = tasks.filter((task) => task.status === 'done' && task.claimedBy === agent).length
  }
  return proof
}

async function summaryFromPaths(
  root: string,
  workspacePath: string,
  runPath: string,
  timelinePath: string
): Promise<RecentBuildSummary | undefined> {
  const run = await readBoundedJson(runPath)
  if (!run) return undefined
  const runId = stringOf(run.runId)
  const startedAt = stringOf(run.createdAt)
  if (!runId || runId !== basename(workspacePath) || !RUN_ID.test(runId) || !startedAt) return undefined

  const status = historyStatusOf(run.status)
  const board = await readWorkspaceJson(workspacePath, resolve(workspacePath, '.duo', 'board.json'))
  const workspaceProtocolRoot = resolve(workspacePath, '.duo')
  const comparableTimeline = comparablePath(timelinePath)
  const comparableProtocolRoot = comparablePath(workspaceProtocolRoot)
  const events = await readPublicTimeline(
    timelinePath,
    comparableTimeline === comparableProtocolRoot || comparableTimeline.startsWith(`${comparableProtocolRoot}${sep}`)
      ? workspaceProtocolRoot
      : undefined
  )
  const reveal = status === 'complete'
    ? await readWorkspaceJson(workspacePath, resolve(workspacePath, '.duo', 'sealed', 'reveal_packet.json'))
    : undefined
  const appName = status === 'complete' ? stringOf(reveal?.appName)?.slice(0, 160) : undefined
  const supervisorReleaseStatus = run.releaseStatus === 'ready' || run.releaseStatus === 'partial' || run.releaseStatus === 'failed'
    ? run.releaseStatus
    : undefined
  const releaseStatus = supervisorReleaseStatus ?? (
    reveal?.status === 'partial' || reveal?.status === 'failed' ? reveal.status : undefined
  )
  const pause = recordOf(run.pause)
  const pauseReason = typeof pause?.reason === 'string' && [
    'provider-quota', 'usage-pressure', 'provider-auth', 'provider-unavailable', 'model-unavailable',
    'cli-incompatible', 'provider-protocol', 'session-lost', 'stage-timeout',
    'host-interrupted', 'workspace-drift', 'verification-failed', 'quality-repair', 'unknown'
  ].includes(pause.reason)
    ? pause.reason as RunPauseSnapshot['reason']
    : undefined
  const proof = buildProof(board, events, supervisorReleaseStatus)
  const finishedAt = status === 'complete' || status === 'cancelled' || status === 'failed'
    ? stringOf(run.updatedAt)
    : undefined

  return {
    runId,
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    status,
    phase: phaseOf(run.phase),
    executionMode: executionModeOf(run.executionMode),
    visibilityMode: visibilityModeOf(run.visibilityMode),
    missionProfile: missionProfileOf(run.missionProfile),
    prompt: stringOf(run.prompt)?.slice(0, 8_000) ?? '',
    workspacePath,
    workspaceRoot: root,
    appName,
    ...(releaseStatus ? { releaseStatus } : {}),
    ...(pauseReason ? { pauseReason } : {}),
    sealed: status !== 'complete',
    recoverable: status === 'paused' || status === 'interrupted' || status === 'cancelled' || status === 'failed',
    resumable: false,
    proof
  }
}

async function scanLegacyWorkspaceRecords(root: string): Promise<RecentBuildSummary[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map((entry) => {
        const workspacePath = resolve(root, entry.name)
        return summaryFromPaths(
          root,
          workspacePath,
          resolve(workspacePath, '.duo', 'run.json'),
          resolve(workspacePath, '.duo', 'public', 'timeline.jsonl')
        )
      }))
    return summaries.filter((summary): summary is RecentBuildSummary => Boolean(summary))
  } catch {
    return []
  }
}

async function scanExternalRuntimeRecords(root: string, runtimeRoot: string): Promise<RecentBuildSummary[]> {
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map(async (entry) => {
        const runtimePath = resolve(runtimeRoot, entry.name)
        const runPath = resolve(runtimePath, 'run.json')
        const run = await readBoundedJson(runPath)
        const workspacePath = await safeRecordedWorkspacePath(run?.workspacePath, entry.name) ??
          await safeRecordedWorkspacePath(resolve(root, entry.name), entry.name)
        if (!workspacePath) return undefined
        return summaryFromPaths(
          dirname(workspacePath),
          workspacePath,
          runPath,
          resolve(runtimePath, 'public', 'timeline.jsonl')
        )
      }))
    return summaries.filter((summary): summary is RecentBuildSummary => Boolean(summary))
  } catch {
    return []
  }
}

export async function scanRecentBuilds(
  workspaceRoot: string,
  limit = 8,
  options: RecentBuildScanOptions = {}
): Promise<RecentBuildSummary[]> {
  const root = resolve(workspaceRoot)
  const legacy = await scanLegacyWorkspaceRecords(root)
  const external = options.runtimeRoot?.trim()
    ? await scanExternalRuntimeRecords(root, resolve(options.runtimeRoot))
    : []
  const summaries = new Map<string, RecentBuildSummary>()
  for (const summary of external) summaries.set(summary.runId, summary)
  for (const summary of legacy) {
    if (!summaries.has(summary.runId)) summaries.set(summary.runId, summary)
  }
  return [...summaries.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(0, Math.min(50, Math.trunc(limit))))
}

async function readArchivedRuntime(
  runtimeRoot: string | undefined,
  runId: string,
  expectedWorkspacePath: string
): Promise<{ run?: JsonRecord; events: JsonRecord[] }> {
  if (!runtimeRoot?.trim()) return { events: [] }
  const root = resolve(runtimeRoot)
  const runtimePath = resolve(root, runId)
  if (!isInside(runtimePath, root)) return { events: [] }
  try {
    const info = await lstat(runtimePath)
    if (!info.isDirectory() || info.isSymbolicLink()) return { events: [] }
    if (comparablePath(await realpath(runtimePath)) !== comparablePath(runtimePath)) return { events: [] }
  } catch {
    return { events: [] }
  }
  const run = await readBoundedJson(resolve(runtimePath, 'run.json'))
  const recordedWorkspace = await safeRecordedWorkspacePath(run?.workspacePath, runId)
  if (
    !run ||
    run.runId !== runId ||
    run.status !== 'complete' ||
    !recordedWorkspace ||
    comparablePath(recordedWorkspace) !== comparablePath(expectedWorkspacePath)
  ) {
    return { events: [] }
  }
  return {
    run,
    events: await readPublicTimeline(resolve(runtimePath, 'public', 'timeline.jsonl'), runtimePath)
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : fallback
}

/**
 * Reconstructs a reveal-only snapshot from a validated completed archive. It
 * never creates an orchestration session and never reads private transcript or
 * raw-log files. The renderer supplies only a run id; all host paths are
 * resolved and checked here in the main process.
 */
export async function loadArchivedCompleteRunSnapshot(
  workspaceRoot: string,
  runId: string,
  options: RecentBuildScanOptions = {}
): Promise<RunSnapshot | undefined> {
  if (!RUN_ID.test(runId)) return undefined
  const root = resolve(workspaceRoot)
  const summary = (await scanRecentBuilds(root, 50, options))
    .find((candidate) => candidate.runId === runId && candidate.status === 'complete')
  if (!summary) return undefined

  const runtime = await readArchivedRuntime(
    options.runtimeRoot,
    runId,
    summary.workspacePath
  )
  // A workspace outside the current default root remains portable only when a
  // supervisor-owned runtime record binds this exact canonical directory to
  // the requested run id. Legacy workspace-only archives stay root-scoped.
  if (!isInside(summary.workspacePath, root) && !runtime.run) return undefined

  const reveal = archivedRevealPacket(await readWorkspaceJson(
    summary.workspacePath,
    resolve(summary.workspacePath, '.duo', 'sealed', 'reveal_packet.json')
  ))
  if (!reveal) return undefined

  const board = await readWorkspaceJson(
    summary.workspacePath,
    resolve(summary.workspacePath, '.duo', 'board.json')
  )
  const tasks = (Array.isArray(board?.tasks) ? board.tasks : [])
    .flatMap((candidate) => {
      const task = archivedTask(candidate)
      return task ? [task] : []
    })
  const fallbackEvents = runtime.events.length === 0
    ? await readPublicTimeline(
        resolve(summary.workspacePath, '.duo', 'public', 'timeline.jsonl'),
        resolve(summary.workspacePath, '.duo')
      )
    : []
  const events = (runtime.events.length > 0 ? runtime.events : fallbackEvents)
    .flatMap((candidate) => {
      const event = archivedPublicEvent(candidate, runId)
      return event ? [event] : []
    })
  const run = runtime.run ?? {}
  const persistedProviderRuntimes = recordOf(run.providerRuntimes)
  const claudeProviderRuntime = parseProviderRuntimeObservation(persistedProviderRuntimes.claude, 'claude')
  const codexProviderRuntime = parseProviderRuntimeObservation(persistedProviderRuntimes.codex, 'codex')
  const providerRuntimes = {
    ...(claudeProviderRuntime ? { claude: claudeProviderRuntime } : {}),
    ...(codexProviderRuntime ? { codex: codexProviderRuntime } : {})
  }
  const finishedAt = boundedText(run.finishedAt, 80) ?? summary.finishedAt

  return {
    runId,
    prompt: summary.prompt,
    executionMode: summary.executionMode,
    visibilityMode: summary.visibilityMode,
    missionProfile: summary.missionProfile ?? 'surprise',
    phase: 'complete',
    status: 'complete',
    round: positiveInteger(run.round, Math.max(1, events.reduce((highest, event) => Math.max(highest, event.round), 0))),
    totalTurns: positiveInteger(run.totalTurns, Math.max(1, events.filter((event) => event.type === 'agent.started').length)),
    startedAt: summary.startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    ...(Number.isFinite(run.activeTimeMs) ? { activeTimeMs: positiveInteger(run.activeTimeMs, 0) } : {}),
    ...(Object.keys(providerRuntimes).length > 0 ? { providerRuntimes } : {}),
    workspacePath: summary.workspacePath,
    appPath: resolve(summary.workspacePath, 'app'),
    releaseStatus: summary.releaseStatus ?? reveal.status,
    revealPacket: reveal,
    tasks,
    events
  }
}
