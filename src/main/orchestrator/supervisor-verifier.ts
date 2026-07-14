import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { captureArtifactQualityEvidence } from '@main/preview/electron-artifact-capture'
import { ProcessRunner, type ProcessRunOptions, type ProcessRunResult } from '@main/process/process-runner'

export interface SupervisorProcessPort {
  run: (options: ProcessRunOptions) => Promise<ProcessRunResult>
}

export interface SupervisorVerificationCheck {
  id: string
  label: string
  outcome: 'passed' | 'failed' | 'skipped'
  exitCode?: number | null
  timedOut?: boolean
}

export type SupervisorBrowserViewportId = 'compact' | 'full'

export interface SupervisorBrowserViewportEvidence {
  id: SupervisorBrowserViewportId
  width: number
  height: number
  screenshotCaptured: boolean
  imageDataUrl: string
  visibleTextCharacters: number
  mainLandmark: boolean
  horizontalOverflow: boolean
  interactiveElementCount: number
  accessibleInteractiveElementCount: number
  interactionAttempted: boolean
  interactionSucceeded: boolean
  interactionObservedChanges?: string[]
  consoleErrors: string[]
  pageErrors: string[]
}

export interface SupervisorBrowserEvidence {
  viewports: SupervisorBrowserViewportEvidence[]
}

export interface SupervisorBrowserEvidenceRequest {
  entryPath: string
  resourceRoot: string
  abortSignal?: AbortSignal
}

export interface SupervisorBrowserEvidencePort {
  capture: (request: SupervisorBrowserEvidenceRequest) => Promise<SupervisorBrowserEvidence>
}

export interface SupervisorQualityCriterion {
  id: string
  label: string
  polarity: 'require' | 'forbid'
  evidenceTerms: string[]
}

export interface SupervisorQualityContract {
  consensusProvenance: {
    verified: boolean
    evidenceHandle?: string
  }
  criteria: SupervisorQualityCriterion[]
}

export interface SupervisorVerificationResult {
  outcome: 'passed' | 'failed'
  summary: string
  checks: SupervisorVerificationCheck[]
  browserEvidence?: SupervisorBrowserEvidence
}

export interface SupervisorVerificationRequest {
  appPath: string
  npmPath: string
  timeoutMs: number
  abortSignal?: AbortSignal
  qualityContract?: SupervisorQualityContract
}

export interface SupervisorVerifierPort {
  verify: (request: SupervisorVerificationRequest) => Promise<SupervisorVerificationResult>
}

const ALLOWED_PACKAGE_SCRIPTS = ['typecheck', 'lint', 'test', 'build'] as const
const BROWSER_OUTPUT_DIRECTORIES = ['dist', 'build', 'out', '.output/public'] as const
const BROWSER_PACKAGE_MARKERS = new Set([
  '@angular/core', '@sveltejs/kit', '@vitejs/plugin-react', '@vitejs/plugin-vue',
  'astro', 'next', 'nuxt', 'react', 'react-dom', 'react-scripts', 'svelte', 'vite', 'vue'
])
const BROWSER_SCRIPT_PATTERN = /(?:^|[\s&|])(?:astro|next|nuxt|react-scripts|svelte-kit|vite)(?:\s|$)|\bng\s+(?:build|serve)\b|\bwebpack(?:-dev-server)?\b/i
const ARTIFACT_EVIDENCE_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.svelte', '.ts', '.tsx', '.vue'
])
const ARTIFACT_EVIDENCE_EXCLUDED_DIRECTORIES = new Set([
  '.duo', '.git', '.github', '.next', 'coverage', 'node_modules', 'test-results', 'tests'
])
const ARTIFACT_EVIDENCE_MAX_FILES = 512
const ARTIFACT_EVIDENCE_MAX_BYTES = 4_000_000
const REQUIRED_VIEWPORTS: Readonly<Record<SupervisorBrowserViewportId, { width: number; height: number }>> = {
  compact: { width: 900, height: 640 },
  full: { width: 1600, height: 900 }
}
const RESTRICTION_CONTROL_TERMS = new Set([
  'add', 'allow', 'avoid', 'disable', 'do', 'don', 'dont', 'enable', 'include', 'must', 'never', 'no', 'not',
  'require', 'use', 'without'
])

interface DirectArtifact {
  path: string
  content: string
  valid: boolean
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

async function smallText(path: string, maximumBytes = 1_000_000): Promise<string | undefined> {
  try {
    const value = await readFile(path)
    if (value.length === 0 || value.length > maximumBytes) return undefined
    return value.toString('utf8')
  } catch {
    return undefined
  }
}

async function directArtifact(appPath: string): Promise<DirectArtifact | undefined> {
  const candidates: string[] = []
  const visitOutput = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > 3 || candidates.length >= 128) return
    let entries
    try {
      entries = await readdir(join(appPath, relativeDirectory), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.isFile() && /^index\.html?$/i.test(entry.name)) candidates.push(relativePath)
      else if (entry.isDirectory()) await visitOutput(relativePath, depth + 1)
      if (candidates.length >= 128) break
    }
  }
  for (const directory of BROWSER_OUTPUT_DIRECTORIES) await visitOutput(directory, 0)
  candidates.sort((left, right) => left.length - right.length || left.localeCompare(right))
  candidates.push('index.html')
  for (const relativePath of candidates) {
    const content = await smallText(join(appPath, relativePath))
    if (!content) continue
    const valid = /<!doctype\s+html|<html(?:\s|>)/i.test(content) &&
      /<(?:title|body|main|script|style)(?:\s|>)/i.test(content) &&
      !/^(?:\s*|\s*<!--.*?-->\s*)$/s.test(content)
    return { path: relativePath, content, valid }
  }
  return undefined
}

function nonInteractiveTest(script: string): boolean {
  return /\b(?:vitest\s+run|jest\b|node\s+--test|playwright\s+test|mocha\b|ava\b)/i.test(script)
}

function verificationScripts(scripts: Record<string, unknown>): string[] {
  const selected = typeof scripts.check === 'string' && scripts.check.trim()
    ? ['check']
    : ALLOWED_PACKAGE_SCRIPTS.filter((name) => {
      const command = scripts[name]
      if (typeof command !== 'string' || !command.trim()) return false
      return name !== 'test' || nonInteractiveTest(command)
    })
  return selected
}

function browserPackage(packageJson: Record<string, unknown>, scripts: Record<string, unknown>): boolean {
  const dependencies = {
    ...record(packageJson.dependencies),
    ...record(packageJson.devDependencies),
    ...record(packageJson.peerDependencies)
  }
  const hasBrowserDependency = Object.keys(dependencies).some((name) => BROWSER_PACKAGE_MARKERS.has(name))
  const scriptText = Object.values(scripts).filter((value): value is string => typeof value === 'string').join('\n')
  return BROWSER_SCRIPT_PATTERN.test(scriptText) || (hasBrowserDependency && /\b(?:build|dev|preview|start)\b/u.test(Object.keys(scripts).join(' ')))
}

function stripMarkup(value: string): string {
  return value
    .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function namedByAttribute(tag: string): boolean {
  return Boolean(
    attribute(tag, 'aria-label')?.trim() ||
    attribute(tag, 'aria-labelledby')?.trim() ||
    attribute(tag, 'title')?.trim()
  )
}

function inaccessibleStaticElements(content: string): number {
  let failures = 0
  for (const image of content.match(/<img\b[^>]*>/gi) ?? []) {
    if (attribute(image, 'alt') === undefined) failures += 1
  }
  for (const match of content.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const tag = `<button ${match[1] ?? ''}>`
    if (!namedByAttribute(tag) && !stripMarkup(match[2] ?? '')) failures += 1
  }
  for (const match of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a ${match[1] ?? ''}>`
    if (!attribute(tag, 'href')) continue
    if (!namedByAttribute(tag) && !stripMarkup(match[2] ?? '')) failures += 1
  }
  const labels = [...content.matchAll(/<label\b[^>]*\bfor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((value): value is string => Boolean(value))
  const wrappedLabels = [...content.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)].map((match) => match[0])
  for (const control of content.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? []) {
    if (/^<input\b/i.test(control) && attribute(control, 'type')?.toLowerCase() === 'hidden') continue
    const id = attribute(control, 'id')
    const hasLabel = Boolean(id && labels.includes(id))
    const hasWrappedLabel = wrappedLabels.some((label) => label.includes(control) && Boolean(stripMarkup(label)))
    const inputType = attribute(control, 'type')?.toLowerCase()
    const hasButtonValue = /^<input\b/i.test(control) &&
      ['button', 'submit', 'reset'].includes(inputType ?? '') &&
      Boolean(attribute(control, 'value')?.trim())
    if (!namedByAttribute(control) && !hasLabel && !hasWrappedLabel && !hasButtonValue) failures += 1
  }
  return failures
}

function staticArtifactChecks(content: string): SupervisorVerificationCheck[] {
  const title = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const hasTitle = Boolean(title && stripMarkup(title))
  const hasLanguage = /<html\b[^>]*\blang\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(content)
  const hasViewport = /<meta\b[^>]*\bname\s*=\s*(?:"viewport"|'viewport'|viewport)(?:\s|\/|>)/i.test(content)
  const visibleCopy = stripMarkup(content)
  const hasPlaceholderCopy = /\b(?:(?:todo|fixme)[:\s-]+(?:replace|finish|implement|add|write|complete|content)|lorem ipsum|placeholder text|sample text|your (?:app|product|name) here)\b/i.test(visibleCopy)
  const inaccessible = inaccessibleStaticElements(content)
  const hasStaticMain = /<(?:main\b|[^>]+\brole\s*=\s*(?:"main"|'main'|main)\b)/i.test(content)
  const defersSemanticsToRuntime = /<script\b[^>]*\bsrc\s*=/i.test(content)

  return [
    { id: 'static:title', label: 'Non-empty document title', outcome: hasTitle ? 'passed' : 'failed' },
    { id: 'static:language', label: 'Document language metadata', outcome: hasLanguage ? 'passed' : 'failed' },
    { id: 'static:viewport', label: 'Responsive viewport metadata', outcome: hasViewport ? 'passed' : 'failed' },
    { id: 'static:placeholder-copy', label: 'No obvious unfinished placeholder copy', outcome: hasPlaceholderCopy ? 'failed' : 'passed' },
    { id: 'static:accessibility', label: 'Static interactive and image accessibility', outcome: inaccessible === 0 ? 'passed' : 'failed' },
    {
      id: 'static:landmark',
      label: 'Primary content landmark',
      outcome: hasStaticMain ? 'passed' : defersSemanticsToRuntime ? 'skipped' : 'failed'
    }
  ]
}

function criterionId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 64) || 'criterion'
}

interface ArtifactConstraintEvidence {
  text: string
  fileCount: number
}

function stripNonBehavioralSource(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:\\])\/\/[^\r\n]*/gmu, '$1 ')
}

function normalizedArtifactTerm(value: string): string {
  let term = value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')
  if (term === 'locally') return 'local'
  if (term.endsWith('ies') && term.length > 5) term = `${term.slice(0, -3)}y`
  else if (term.endsWith('s') && term.length > 4 && !term.endsWith('ss')) term = term.slice(0, -1)
  return term
}

function artifactTerms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [])
    .map(normalizedArtifactTerm)
    .filter((term) => term.length >= 3))
}

function artifactAffirmativelyContains(value: string, term: string): boolean {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return [...normalized.matchAll(new RegExp(`\\b${escaped}\\b`, 'giu'))].some((match) => {
    const prefix = normalized.slice(Math.max(0, (match.index ?? 0) - 120), match.index)
    const activeClause = prefix.split(/[.!?;]|\b(?:but|however|instead|yet)\b/iu).at(-1) ?? prefix
    return !/\b(?:avoid|disable|do not|don't|must not|never|no|without)\b/iu.test(activeClause)
  })
}

async function collectArtifactConstraintEvidence(appPath: string): Promise<ArtifactConstraintEvidence> {
  const contents: string[] = []
  let totalBytes = 0
  let fileCount = 0
  const visit = async (directory: string): Promise<void> => {
    if (fileCount >= ARTIFACT_EVIDENCE_MAX_FILES || totalBytes >= ARTIFACT_EVIDENCE_MAX_BYTES) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (fileCount >= ARTIFACT_EVIDENCE_MAX_FILES || totalBytes >= ARTIFACT_EVIDENCE_MAX_BYTES) break
      if (entry.isSymbolicLink()) continue
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(appPath, absolutePath).replace(/\\/gu, '/')
      if (entry.isDirectory()) {
        if (!ARTIFACT_EVIDENCE_EXCLUDED_DIRECTORIES.has(entry.name)) await visit(absolutePath)
        continue
      }
      const extension = extname(entry.name).toLocaleLowerCase()
      if (!entry.isFile() || !ARTIFACT_EVIDENCE_EXTENSIONS.has(extension) || extension === '.json') continue
      if (/\.(?:spec|test)\.[^.]+$/iu.test(entry.name) || /(?:^|\/)__tests__(?:\/|$)/iu.test(relativePath)) continue
      const remaining = ARTIFACT_EVIDENCE_MAX_BYTES - totalBytes
      const content = await smallText(absolutePath, remaining)
      if (!content) continue
      totalBytes += Buffer.byteLength(content, 'utf8')
      fileCount += 1
      // Metadata and comments can promise a feature without implementing it.
      // Keep this lexical trace limited to executable/UI source. Independent
      // browser/script proof and exact-current task receipts remain separate
      // release gates, so this scan is supporting evidence rather than a claim
      // that product behavior passed.
      contents.push(stripNonBehavioralSource(content))
    }
  }
  await visit(appPath)
  return { text: contents.join('\n'), fileCount }
}

function briefChecks(
  contract: SupervisorQualityContract | undefined,
  artifactEvidence: ArtifactConstraintEvidence
): SupervisorVerificationCheck[] {
  if (!contract) return []
  const provenancePassed = contract.consensusProvenance?.verified === true &&
    Boolean(contract.consensusProvenance.evidenceHandle?.trim())
  const checks: SupervisorVerificationCheck[] = [{
    id: 'brief:consensus-provenance',
    label: 'Sealed consensus provenance',
    outcome: provenancePassed ? 'passed' : 'failed'
  }]
  const terms = artifactTerms(artifactEvidence.text)
  for (const criterion of contract.criteria.slice(0, 64)) {
    const evidenceTerms = [...new Set(criterion.evidenceTerms
      .map(normalizedArtifactTerm)
      .filter((term) => term.length >= 3 && (
        criterion.polarity !== 'forbid' || !RESTRICTION_CONTROL_TERMS.has(term)
      )))].slice(0, 16)
    const matchedTerms = evidenceTerms.filter((term) => terms.has(term))
    const requiredMatches = Math.min(3, Math.max(1, Math.ceil(evidenceTerms.length * 0.4)))
    const artifactBacked = criterion.polarity === 'forbid'
      ? evidenceTerms.length > 0 && !evidenceTerms.some((term) => artifactAffirmativelyContains(artifactEvidence.text, term))
      : evidenceTerms.length > 0 && matchedTerms.length >= requiredMatches
    checks.push({
      id: `brief:${criterionId(criterion.id)}`,
      label: `Supporting implementation trace: ${criterion.label.trim().slice(0, 150) || 'brief acceptance criterion'}`,
      outcome: artifactEvidence.fileCount > 0 && artifactBacked ? 'passed' : 'failed'
    })
  }
  return checks
}

function runtimeBrowserPort(): SupervisorBrowserEvidencePort | null {
  return 'electron' in process.versions
    ? { capture: captureArtifactQualityEvidence }
    : null
}

function browserChecks(
  evidence: SupervisorBrowserEvidence,
  interactionRequired: boolean
): SupervisorVerificationCheck[] {
  const checks: SupervisorVerificationCheck[] = []
  const byViewport = new Map(evidence.viewports.map((viewport) => [viewport.id, viewport]))
  for (const id of ['compact', 'full'] as const) {
    const viewport = byViewport.get(id)
    const required = REQUIRED_VIEWPORTS[id]
    const passed = Boolean(
      viewport &&
      viewport.screenshotCaptured &&
      /^data:image\/(?:png|jpeg|webp);base64,/i.test(viewport.imageDataUrl) &&
      viewport.width >= required.width &&
      viewport.height >= required.height &&
      viewport.visibleTextCharacters > 0 &&
      viewport.mainLandmark &&
      !viewport.horizontalOverflow
    )
    checks.push({ id: `browser:${id}`, label: `${id === 'compact' ? 'Compact' : 'Full-screen'} viewport render`, outcome: passed ? 'passed' : 'failed' })
  }

  const allViewports = [...byViewport.values()]
  const consoleHealthy = allViewports.length === 2 && allViewports.every((viewport) =>
    viewport.consoleErrors.length === 0 && viewport.pageErrors.length === 0
  )
  checks.push({ id: 'browser:console', label: 'Browser console and page health', outcome: consoleHealthy ? 'passed' : 'failed' })

  const accessibilityPassed = allViewports.length === 2 && allViewports.every((viewport) =>
    viewport.accessibleInteractiveElementCount === viewport.interactiveElementCount
  )
  checks.push({ id: 'browser:accessibility', label: 'Rendered controls have accessible names', outcome: accessibilityPassed ? 'passed' : 'failed' })

  const interactiveViewports = allViewports.filter((viewport) => viewport.interactiveElementCount > 0)
  const interactionPassed = interactiveViewports.every((viewport) =>
    viewport.interactionAttempted && viewport.interactionSucceeded
  )
  checks.push({
    id: 'browser:interaction',
    label: 'Rendered interaction smoke',
    outcome: interactiveViewports.length === 0
      ? interactionRequired ? 'failed' : 'skipped'
      : interactionPassed ? 'passed' : 'failed'
  })
  return checks
}

export class SupervisorVerifier implements SupervisorVerifierPort {
  constructor(
    private readonly processPort: SupervisorProcessPort = new ProcessRunner(),
    private readonly browserPort: SupervisorBrowserEvidencePort | null = runtimeBrowserPort()
  ) {}

  async verify(request: SupervisorVerificationRequest): Promise<SupervisorVerificationResult> {
    const checks: SupervisorVerificationCheck[] = []
    const cancelled = (): SupervisorVerificationResult => ({
      outcome: 'failed',
      summary: 'Supervisor verification was cancelled before completion.',
      checks
    })
    if (request.abortSignal?.aborted) return cancelled()
    const packageText = await smallText(join(request.appPath, 'package.json'))
    if (request.abortSignal?.aborted) return cancelled()
    let packageJson: Record<string, unknown> = {}
    let scripts: Record<string, unknown> = {}
    let hasRunnablePackageCommand = false
    if (packageText) {
      try {
        packageJson = record(JSON.parse(packageText) as unknown)
        scripts = record(packageJson.scripts)
        hasRunnablePackageCommand = ['dev', 'start', 'preview'].some((name) => {
          const command = scripts[name]
          return typeof command === 'string' && Boolean(command.trim())
        })
      } catch {
        return {
          outcome: 'failed',
          summary: 'Supervisor verification rejected an invalid app/package.json.',
          checks: [{ id: 'package-json', label: 'Parse package metadata', outcome: 'failed' }]
        }
      }
    }

    const isBrowserPackage = browserPackage(packageJson, scripts)
    const scriptsToRun = verificationScripts(scripts)
    if (isBrowserPackage && typeof scripts.build === 'string' && scripts.build.trim() && !scriptsToRun.includes('build')) {
      scriptsToRun.push('build')
    }
    const timeoutPerCheck = Math.max(1_000, Math.floor(request.timeoutMs / Math.max(1, scriptsToRun.length)))
    for (const script of scriptsToRun) {
      if (request.abortSignal?.aborted) return cancelled()
      const result = await this.processPort.run({
        id: `supervisor-${script}-${Date.now().toString(36)}`,
        command: { bin: request.npmPath, args: ['run', script], cwd: request.appPath },
        timeoutMs: timeoutPerCheck,
        stdoutPath: process.platform === 'win32' ? 'NUL' : '/dev/null',
        stderrPath: process.platform === 'win32' ? 'NUL' : '/dev/null',
        abortSignal: request.abortSignal,
        onLine: () => undefined
      })
      if (request.abortSignal?.aborted) return cancelled()
      const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.outputLimitExceeded && !result.rawLogWriteFailed
      checks.push({
        id: `script:${script}`,
        label: `npm run ${script}`,
        outcome: passed ? 'passed' : 'failed',
        exitCode: result.exitCode,
        ...(result.timedOut ? { timedOut: true } : {})
      })
      if (!passed) {
        return {
          outcome: 'failed',
          summary: `Supervisor verification failed at npm run ${script}.`,
          checks
        }
      }
    }

    const artifactConstraintEvidence = await collectArtifactConstraintEvidence(request.appPath)
    if (request.abortSignal?.aborted) return cancelled()
    const contractChecks = briefChecks(request.qualityContract, artifactConstraintEvidence)
    checks.push(...contractChecks)
    if (contractChecks.some((check) => check.outcome === 'failed')) {
      return {
        outcome: 'failed',
        summary: 'Supervisor verification found missing evidence for the frozen quality brief.',
        checks
      }
    }

    const artifact = await directArtifact(request.appPath)
    const buildScriptExpectedOutput = isBrowserPackage && typeof scripts.build === 'string' && Boolean(scripts.build.trim())
    if (isBrowserPackage && (!artifact || (buildScriptExpectedOutput && artifact.path === 'index.html'))) {
      checks.push({ id: 'browser:artifact', label: 'Built browser artifact discovery', outcome: 'failed' })
      return {
        outcome: 'failed',
        summary: 'Supervisor verification could not locate a built browser artifact without launching a dev server.',
        checks
      }
    }
    if (artifact) {
      checks.push({
        id: 'artifact',
        label: `Loadable HTML artifact: ${artifact.path}`,
        outcome: artifact.valid ? 'passed' : 'failed'
      })
      if (!artifact.valid) {
        return {
          outcome: 'failed',
          summary: 'Supervisor verification found an incomplete HTML entrypoint.',
          checks
        }
      }

      const staticChecks = staticArtifactChecks(artifact.content)
      checks.push(...staticChecks)
      if (staticChecks.some((check) => check.outcome === 'failed')) {
        return {
          outcome: 'failed',
          summary: 'Supervisor verification found unfinished product or accessibility evidence in the HTML entrypoint.',
          checks
        }
      }

      if (!this.browserPort) {
        checks.push(
          { id: 'browser:compact', label: 'Compact viewport render', outcome: 'failed' },
          { id: 'browser:full', label: 'Full-screen viewport render', outcome: 'failed' },
          { id: 'browser:console', label: 'Browser console and page health', outcome: 'failed' },
          { id: 'browser:accessibility', label: 'Rendered controls have accessible names', outcome: 'failed' },
          { id: 'browser:interaction', label: 'Rendered interaction smoke', outcome: 'failed' }
        )
        return {
          outcome: 'failed',
          summary: 'Supervisor verification requires isolated browser evidence before a browser artifact can ship.',
          checks
        }
      } else {
        if (request.abortSignal?.aborted) return cancelled()
        let browserEvidence: SupervisorBrowserEvidence
        try {
          const absoluteEntryPath = join(request.appPath, artifact.path)
          browserEvidence = await this.browserPort.capture({
            entryPath: absoluteEntryPath,
            resourceRoot: dirname(absoluteEntryPath),
            abortSignal: request.abortSignal
          })
        } catch {
          if (request.abortSignal?.aborted) return cancelled()
          checks.push({ id: 'browser:capture', label: 'Isolated browser evidence capture', outcome: 'failed' })
          return {
            outcome: 'failed',
            summary: 'Supervisor verification could not capture isolated browser evidence.',
            checks
          }
        }
        const interactionRequired = /<(?:script\b|button\b|input\b|select\b|textarea\b|a\b[^>]*\bhref\s*=|[^>]+\brole\s*=\s*(?:"button"|'button'|button))/i.test(artifact.content)
        const renderedChecks = browserChecks(browserEvidence, interactionRequired)
        checks.push(...renderedChecks)
        if (renderedChecks.some((check) => check.outcome === 'failed')) {
          return {
            outcome: 'failed',
            summary: 'Supervisor verification found a compact, full-screen, interaction, accessibility, or console defect.',
            checks,
            browserEvidence
          }
        }
        const passedCount = checks.filter((check) => check.outcome === 'passed').length
        return {
          outcome: 'passed',
          summary: `Supervisor independently passed ${String(passedCount)} release checks.`,
          checks,
          browserEvidence
        }
      }
    }

    const runnable = hasRunnablePackageCommand
    if (!runnable) {
      checks.push({ id: 'runnable', label: 'Runnable artifact discovery', outcome: 'failed' })
      return {
        outcome: 'failed',
        summary: 'Supervisor verification could not discover a runnable artifact.',
        checks
      }
    }

    if (scriptsToRun.length === 0) {
      checks.push({ id: 'verification-command', label: 'Independent verification command', outcome: 'failed' })
      return {
        outcome: 'failed',
        summary: 'A package runner exists, but no allowlisted non-interactive verification command is available.',
        checks
      }
    }

    checks.push({
      id: 'browser:not-applicable',
      label: 'Browser proof not applicable to non-UI package',
      outcome: 'skipped'
    })

    return {
      outcome: 'passed',
      summary: `Supervisor independently passed ${String(checks.filter((check) => check.outcome === 'passed').length)} release check${checks.length === 1 ? '' : 's'}.`,
      checks
    }
  }
}
