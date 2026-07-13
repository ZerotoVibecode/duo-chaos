import { randomBytes, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  AppSettings,
  AgentEffort,
  BroadcastSnapshot,
  CodexEffort,
  DuoEvent,
  DuoTask,
  RevealPacket,
  RunPhase,
  RunPauseSnapshot,
  RunSnapshot,
  StartRunRequest,
  StartRunResult,
  TurnStageName,
  ToolHealth
} from '@shared/types'
import { appendRunEvent } from '@main/events/event-store'
import { VisibleActivityBudget } from '@main/events/activity-budget'
import {
  normalizeCliActivity,
  normalizeCliLine,
  parseCliQuotaSignal,
  type CliActivityState,
  type CliQuotaSignal
} from '@main/events/normalizer'
import { GitManager, type GitResult } from '@main/git/git-manager'
import { checkAllTools } from '@main/health/health-check'
import { resolveAgentRuntimeProfiles } from '@main/health/runtime-profile'
import { buildAgentCommand } from '@main/process/command-builder'
import { extractAgentSessionId } from '@main/process/session-continuity'
import { decodeProviderEnvelope, type ProviderRecord } from '@main/process/provider-envelope'
import {
  ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult
} from '@main/process/process-runner'
import { buildRedactionTerms, type RedactionTerm } from '@main/security/redaction'
import { validateRunRequest } from '@main/security/run-policy'
import { projectEventForRenderer, projectTaskForRenderer } from '@main/security/visibility'
import { createRunWorkspace, type RunWorkspace } from '@main/workspace/workspace-manager'
import {
  safeAppendProtocolText,
  safeListProtocolFiles,
  safeReadProtocolText,
  safeWriteProtocolText
} from '@main/workspace/safe-protocol-files'
import {
  sealSeriousMissionGuard,
  validateSeriousMissionContract
} from '@main/workspace/serious-mission-contract'
import { DurableRunStateStore, type DurableRunManifest } from '@main/persistence/durable-run-state'
import {
  classifyProviderFailure,
  type ProviderFailureClassification
} from '@main/providers/provider-failure'
import {
  buildRunPreflightReport,
  type ExpectedProviderCliContract,
  type RunPreflightReport
} from '@main/providers/provider-compatibility-preflight'
import { enrichRevealPacket } from '@shared/drama'
import { latestVerificationEvidence, verificationOutcomeOf } from '@shared/verification-evidence'
import { normalizeBoard, parseProtocolJsonl } from './protocol-sync'
import { buildBroadcastState } from './broadcast-director'
import {
  buildLegacyRealTurnPlan,
  buildRealTurnPlan,
  contributionNeedsFreshSource,
  type RealTurn,
  type RealTurnPlanVersion
} from './real-turn-plan'
import { buildSimulationScript, SIMULATION_ARTIFACT_HTML } from './simulation-script'
import { hasCompletedOwnedTask, hasReciprocalReviewEvidence } from './collaboration-evidence'
import {
  assessTurnAcceptance,
  hasDurableWorkEvidence,
  reusableDurableWorkEvidence,
  type TurnAcceptance
} from './turn-acceptance'
import { resolveStageBudgetSeconds, type TurnBudgetPolicy } from './turn-budget'
import { composeTurnStagePrompt } from './turn-prompts'
import { RunUsageTracker } from './usage-telemetry'
import { StageEventLedger } from './stage-event-ledger'
import { SupervisorVerifier, type SupervisorVerifierPort } from './supervisor-verifier'
import {
  DIALOGUE_CAPSULE_JSON_SCHEMA,
  dialogueCapsuleJsonSchemaForTurn,
  DialogueCapsuleError,
  extractDialogueCapsuleFromCliLine,
  selectDialogueStatementForTurn,
  validateDialogueCapsuleForTurn,
  writeDialogueCapsuleProtocol,
  type DialogueCapsule
} from './dialogue-capsule'
import {
  RecoveryCapsuleError,
  extractRecoveryCapsuleFromCliLine,
  recoveryCapsuleJsonSchema,
  writeRecoveryCapsuleProtocol,
  type RecoveryCapsule,
  type RecoveryOriginStage
} from './recovery-capsule'

interface RunOrchestratorOptions {
  getSettings: () => Promise<AppSettings>
  onSnapshot: (snapshot: RunSnapshot) => void
  runtimeRoot?: string
  onEvent?: (event: DuoEvent) => void
  simulationDelayScale?: number
  protocolPollMs?: number
  broadcastBeatMs?: number
  healthProvider?: (settings: AppSettings) => Promise<ToolHealth[]>
  processRunner?: ProcessRunnerPort
  supervisorVerifier?: SupervisorVerifierPort
  now?: () => number
  /** Legacy staged executor is retained only for durable-run compatibility and focused regression tests. */
  planVersion?: RealTurnPlanVersion
  /** Test-only escape hatch for deterministic shortened plans. The desktop app must never set this. */
  testOnlyMinimumTurns?: 2
}

export interface ProcessRunnerPort {
  run: (options: ProcessRunOptions) => Promise<ProcessRunResult>
  cancelAll: () => Promise<void>
}

interface RunSession {
  request: StartRunRequest
  settings: AppSettings
  workspace: RunWorkspace
  snapshot: RunSnapshot
  privateRevealPacket?: RevealPacket
  redactionTerms: RedactionTerm[]
  revealed: boolean
  controller: AbortController
  settled: Promise<void>
  resolveSettled: () => void
  runnerActive: boolean
  eventQueue: Promise<void>
  stageEventLedger: StageEventLedger
  seenProtocolEvents: Set<string>
  protocolSyncPending: boolean
  boardSignature?: string
  lastStateSignature?: string
  turnPlan: RealTurn[]
  planVersion: RealTurnPlanVersion
  activeTurnIndex: number
  broadcastTick: number
  acceptedCodeAgents: Set<Extract<DuoEvent['agent'], 'claude' | 'codex'>>
  acceptedReviewAgents: Set<Extract<DuoEvent['agent'], 'claude' | 'codex'>>
  usageTracker: RunUsageTracker
  runDeadlineMs: number
  activeSinceMs: number
  accumulatedActiveMs: number
  pausedAtMs?: number
  resumePhase?: RunPhase
  resumeStage?: TurnStageName
  resumeRecoveryOriginStage?: Exclude<TurnStageName, 'recovery'>
  resumeRecoveryReasons?: string[]
  durableStore: DurableRunStateStore
  durableRevision: number
  providerSessions: Partial<Record<Extract<DuoEvent['agent'], 'claude' | 'codex'>, string>>
  preflightReport?: RunPreflightReport
  appEvidenceRevision: number
  verifiedAppEvidenceRevision: number
  gitHead?: string
  appFingerprint?: string
  quotaConstrainedAgents: Set<Extract<DuoEvent['agent'], 'claude' | 'codex'>>
  providerPressure: Partial<Record<Extract<DuoEvent['agent'], 'claude' | 'codex'>, CliQuotaSignal>>
  supervisorVerificationAttempt?: { revision: number; passed: boolean }
  lastPrivateDialogue?: {
    agent: Extract<DuoEvent['agent'], 'claude' | 'codex'>
    round: number
    text: string
  }
}

interface ExecutedTurnStage {
  assessment: TurnAcceptance
  durableSourceChanged: boolean
  sessionId?: string
  quotaRejected?: boolean
  quotaResetAt?: string
  failure?: ProviderFailureClassification
}

class RunPauseError extends Error {
  constructor(readonly pause: Omit<RunPauseSnapshot, 'pausedAt' | 'round'>) {
    super(pause.message)
    this.name = 'RunPauseError'
  }
}

class RunTerminalError extends Error {
  constructor(message: string, readonly reason: 'workspace-drift' | 'safety-violation') {
    super(message)
    this.name = 'RunTerminalError'
  }
}

function hasCompletedVerificationEvidence(events: DuoEvent[]): boolean {
  return latestVerificationEvidence(events)?.outcome === 'passed'
}

const SIMULATION_REDACTIONS = [
  { value: 'Afterglow Atlas', label: 'APP_NAME' },
  { value: 'memory constellation', label: 'FEATURE' },
  { value: 'memory atlas', label: 'APP_IDEA' },
  { value: 'constellation canvas', label: 'FEATURE' }
]

const EXPECTED_PROVIDER_CONTRACTS: ExpectedProviderCliContract[] = [
  {
    agent: 'claude',
    evidence: 'verified',
    transportFormats: ['json', 'stream-json'],
    structuredOutput: true,
    sessionResume: true,
    toolDisable: true,
    quotaResetAvailable: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    requiredStructuredTransports: ['json', 'stream-json'],
    requireStructuredOutput: true,
    sessionResumeRequirement: 'warning',
    toolDisableRequirement: 'warning'
  },
  {
    agent: 'codex',
    evidence: 'verified',
    transportFormats: ['jsonl'],
    structuredOutput: true,
    sessionResume: true,
    toolDisable: true,
    quotaResetAvailable: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    requiredStructuredTransports: ['jsonl'],
    requireStructuredOutput: true,
    sessionResumeRequirement: 'warning',
    toolDisableRequirement: 'warning'
  }
]

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `duo-run-${timestamp}-${randomBytes(2).toString('hex')}`
}

function phaseForEvent(event: DuoEvent, current: RunPhase): RunPhase {
  const explicitPhase = event.metadata?.phase
  if (typeof explicitPhase === 'string' && explicitPhase.startsWith('round.')) return explicitPhase as RunPhase
  if (event.type === 'run.started') return 'preflight'
  if (event.type === 'conflict') return 'round.conflict'
  if (event.type === 'file.changed') return 'round.code'
  if (event.type.startsWith('build.')) return 'round.verify'
  if (event.type.startsWith('repair.')) return 'round.repair'
  if (event.type === 'reveal.ready') return 'reveal.ready'
  if (event.type === 'run.completed') return 'complete'
  if (event.type === 'run.paused') return 'paused'
  if (event.type === 'run.failed') return 'failed'
  if (event.type === 'run.cancelled') return 'cancelled'
  return current
}

function createDirectorEvent(
  session: RunSession,
  type: DuoEvent['type'],
  publicText: string,
  additions: Partial<DuoEvent> = {}
): DuoEvent {
  return {
    id: crypto.randomUUID(),
    type,
    runId: session.snapshot.runId,
    round: session.snapshot.round,
    timestamp: new Date().toISOString(),
    agent: 'director',
    publicText,
    spoilerRisk: 0.1,
    severity: 'low',
    ...additions
  }
}

const EFFORT_RANK: Record<Exclude<CodexEffort, 'default'>, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5
}

function capStageEffort(
  selected: AgentEffort | CodexEffort,
  cap: Extract<AgentEffort, 'low' | 'medium' | 'high'>
): AgentEffort | CodexEffort {
  if (selected === 'default') return cap
  return EFFORT_RANK[selected] <= EFFORT_RANK[cap] ? selected : cap
}

function privateDialogueContext(
  agent: 'claude' | 'codex',
  capsule: DialogueCapsule,
  contract: { kind: RealTurn['kind']; phase: RunPhase },
  replyTo?: string
): string {
  const statement = selectDialogueStatementForTurn(capsule, contract, replyTo)
  const pitches = capsule.pitches?.map((pitch, index) =>
    `Pitch ${String(index + 1)} — ${pitch.title}: ${pitch.idea} Appeal: ${pitch.appeal} Risk: ${pitch.risk}`
  ).join('\n')
  const consensus = capsule.consensus
    ? `Sealed consensus — ${capsule.consensus.appName}: ${capsule.consensus.idea}\n${capsule.consensus.summary}`
    : undefined
  return [
    `${agent === 'claude' ? 'Claude' : 'Codex'} private ${statement.kind}:`,
    statement.speech.privateText,
    `Opinion: ${capsule.opinion.privateText}`,
    pitches,
    consensus
  ].filter((value): value is string => Boolean(value)).join('\n')
}

function hasPreservedOpeningSource(
  events: readonly DuoEvent[],
  agent: Extract<DuoEvent['agent'], 'claude' | 'codex'>,
  round: number
): boolean {
  return events.some((event) =>
    event.type === 'decision' &&
    event.topic === 'early-work-preserved' &&
    event.round === round &&
    (
      event.metadata?.agent === agent ||
      event.targetAgent === agent ||
      event.publicText.startsWith(agent === 'claude' ? 'Claude moved' : 'Codex moved') ||
      event.publicText.startsWith(agent === 'claude' ? 'Claude wrote' : 'Codex wrote')
    )
  )
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('Run cancelled.'))
      },
      { once: true }
    )
  })
}

interface WorkspaceRevealEvidence {
  appName?: string
  idea?: string
  features: string[]
  directEntrypoint?: string
  runCommand?: string
  completedWork: string[]
  hasRunnableArtifact: boolean
  hasRecordedVerification: boolean
}

function revealText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function revealStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(revealText).filter((item): item is string => Boolean(item))
    : []
}

function uniqueRevealStrings(values: Array<string | undefined>, maximum = 8): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, maximum)
}

async function readSmallText(rootPath: string, path: string, maximumBytes = 256_000): Promise<string | undefined> {
  try {
    return await safeReadProtocolText(rootPath, path, maximumBytes)
  } catch {
    return undefined
  }
}

function htmlTitle(content: string): string | undefined {
  const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function humanizePackageName(value: string): string {
  const name = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim()
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

async function appendWorkspaceProtocolEvent(
  protocolRoot: string,
  publicPath: string,
  privatePath: string,
  event: DuoEvent,
  projected: DuoEvent
): Promise<void> {
  const publicEvent = { ...projected }
  delete publicEvent.privateText
  delete publicEvent.metadata
  await Promise.all([
    safeAppendProtocolText(protocolRoot, publicPath, `${JSON.stringify(publicEvent)}\n`),
    safeAppendProtocolText(protocolRoot, privatePath, `${JSON.stringify(event)}\n`)
  ])
}

function comparableResolvedPath(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

async function inspectWorkspaceRevealEvidence(
  workspace: RunWorkspace,
  tasks: DuoTask[],
  events: DuoEvent[] = [],
  hasCurrentVerification?: boolean
): Promise<WorkspaceRevealEvidence> {
  let appName: string | undefined
  let idea: string | undefined
  const specFeatures: string[] = []

  try {
    const entries = (await safeListProtocolFiles(workspace.duoPath, join(workspace.duoPath, 'sealed'), 24))
      .filter((entry) => entry.endsWith('.json') && !entry.startsWith('reveal_packet'))
      .slice(0, 24)
    for (const entry of entries) {
      const content = await safeReadProtocolText(workspace.duoPath, join(workspace.duoPath, 'sealed', entry), 256_000)
      if (!content) continue
      try {
        const source = record(JSON.parse(content) as unknown)
        appName ??= revealText(source.appName) ?? revealText(source.productName) ?? revealText(source.selection) ?? revealText(source.title)
        idea ??= revealText(source.idea) ?? revealText(source.concept) ?? revealText(source.description)
        specFeatures.push(...revealStrings(source.features), ...revealStrings(source.spec), ...revealStrings(source.capabilities))
      } catch {
        // Other sealed records can still provide product evidence.
      }
    }
  } catch {
    // A missing sealed directory is handled by app artifact discovery below.
  }

  const preferredEntrypoints = ['app/dist/index.html', 'app/build/index.html', 'app/index.html']
  let directEntrypoint: string | undefined
  let entryContent: string | undefined
  for (const candidate of preferredEntrypoints) {
    const content = await readSmallText(workspace.workspacePath, join(workspace.workspacePath, candidate))
    if (!content) continue
    directEntrypoint = candidate
    entryContent = content
    break
  }
  if (!directEntrypoint) {
    try {
      const html = (await safeListProtocolFiles(workspace.workspacePath, workspace.appPath))
        .find((entry) => entry.toLowerCase().endsWith('.html'))
      if (html) {
        directEntrypoint = `app/${html}`
        entryContent = await readSmallText(workspace.workspacePath, join(workspace.appPath, html))
      }
    } catch {
      // The app may use a package runner instead of a direct HTML entrypoint.
    }
  }
  if (entryContent) appName ??= htmlTitle(entryContent)

  const packageContent = await readSmallText(workspace.workspacePath, join(workspace.appPath, 'package.json'))
  let packageRunCommand: string | undefined
  if (packageContent) {
    try {
      const packageJson = record(JSON.parse(packageContent) as unknown)
      const packageName = revealText(packageJson.productName) ?? revealText(packageJson.displayName) ?? revealText(packageJson.name)
      if (packageName) appName ??= humanizePackageName(packageName)
      const scripts = record(packageJson.scripts)
      if (revealText(scripts.dev)) packageRunCommand = 'npm install && npm run dev'
      else if (revealText(scripts.start)) packageRunCommand = 'npm install && npm start'
    } catch {
      // Invalid package metadata must not hide a directly runnable artifact.
    }
  }

  if (packageRunCommand && directEntrypoint && !/^app\/(?:dist|build)\/index\.html$/i.test(directEntrypoint)) {
    directEntrypoint = undefined
  }

  const readme = await readSmallText(workspace.workspacePath, join(workspace.appPath, 'README.md'))
  if (readme) {
    appName ??= revealText(readme.match(/^#\s+(.+)$/m)?.[1])
    idea ??= revealText(readme.match(/^(?!#)(\S.+)$/m)?.[1])
  }

  const completedWork = uniqueRevealStrings(tasks
    .filter((task) => task.status === 'done')
    .map((task) => task.privateDescription ?? task.publicDescription ?? task.privateTitle ?? task.publicTitle))
  const features = uniqueRevealStrings(completedWork.length > 0 ? completedWork : specFeatures)
  idea ??= uniqueRevealStrings(specFeatures, 1)[0] ?? features[0]

  return {
    ...(appName ? { appName } : {}),
    ...(idea ? { idea } : {}),
    features,
    ...(directEntrypoint ? { directEntrypoint } : {}),
    ...(packageRunCommand
      ? { runCommand: packageRunCommand }
      : directEntrypoint ? { runCommand: `Open ${directEntrypoint} directly in a browser.` } : {}),
    completedWork,
    hasRunnableArtifact: Boolean(directEntrypoint || packageRunCommand),
    hasRecordedVerification: hasCurrentVerification ?? hasCompletedVerificationEvidence(events)
  }
}

function alternateQuote(input: Record<string, unknown>, agent: 'claude' | 'codex'): string | undefined {
  const direct = record(input.agentQuotes)
  const directQuote = revealText(direct[agent])
  if (directQuote) return directQuote
  if (!Array.isArray(input.quotes)) return undefined
  for (const candidate of input.quotes) {
    const quote = record(candidate)
    if (quote.agent === agent) return revealText(quote.text) ?? revealText(quote.quote)
  }
  return undefined
}

function safeRevealPacket(value: unknown, workspace: RunWorkspace, evidence: WorkspaceRevealEvidence): RevealPacket | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  if (!revealText(input.appName) && !revealText(input.idea) && !revealText(input.summary) && !revealText(input.runCommand) && !revealText(input.status)) return undefined

  const workspaceName = basename(workspace.workspacePath)
  const providedAppName = revealText(input.appName)
  const providedIdea = revealText(input.idea)
  const providedSummary = revealText(input.summary)
  const providedRunCommand = revealText(input.runCommand)
  const legacyFallback = providedAppName === workspaceName &&
    /turn limit before writing a complete reveal packet/i.test(providedIdea ?? '') &&
    /inspect the generated readme and package\.json/i.test(providedRunCommand ?? '')
  const appName = legacyFallback
    ? evidence.appName ?? providedAppName
    : providedAppName ?? evidence.appName ?? workspaceName
  const summary = legacyFallback
    ? `${appName} was recovered from the generated workspace; the original release metadata was incomplete.`
    : providedSummary ?? providedIdea ?? evidence.idea ?? 'A generated workspace is ready for inspection.'
  const providedAppPath = revealText(input.appPath)
  const usesAppDirectory = !providedAppPath || providedAppPath === 'app' || providedAppPath === workspace.appPath
  const features = revealStrings(input.features)
  const checks = revealStrings(input.checks)
  const providedWork = revealStrings(input.whatWorked)
  const factualDrama = revealText(input.factualDrama)
  const status = input.status === 'failed'
    ? 'failed'
    : input.status === 'ready' && evidence.hasRunnableArtifact && evidence.hasRecordedVerification
      ? 'ready'
      : 'partial'
  return {
    appName,
    idea: legacyFallback ? evidence.idea ?? summary : providedIdea ?? evidence.idea ?? summary,
    summary,
    features: features.length > 0 ? uniqueRevealStrings(features) : evidence.features,
    runCommand: legacyFallback
      ? evidence.runCommand ?? 'Open the generated workspace for inspection.'
      : providedRunCommand ?? evidence.runCommand ?? 'Open the generated workspace for inspection.',
    appPath: usesAppDirectory && evidence.directEntrypoint
      ? evidence.directEntrypoint
      : providedAppPath ?? evidence.directEntrypoint ?? workspace.appPath,
    ...(revealText(input.devUrl) ? { devUrl: revealText(input.devUrl) } : {}),
    status,
    whatWorked: !legacyFallback && providedWork.length > 0
      ? uniqueRevealStrings(providedWork)
      : uniqueRevealStrings([...checks, ...evidence.completedWork]),
    knownIssues: revealStrings(input.knownIssues).length > 0
      ? uniqueRevealStrings(revealStrings(input.knownIssues))
      : uniqueRevealStrings(revealStrings(input.remainingCaveats)),
    agentDramaSummary: legacyFallback
      ? []
      : uniqueRevealStrings([...revealStrings(input.agentDramaSummary), factualDrama]),
    gitCheckpoints: uniqueRevealStrings(revealStrings(input.gitCheckpoints)),
    agentQuotes: {
      claude: legacyFallback ? 'Claude completed the final turn.' : alternateQuote(input, 'claude') ?? 'Claude completed the final turn.',
      codex: legacyFallback ? 'Codex completed the final turn.' : alternateQuote(input, 'codex') ?? 'Codex completed the final turn.'
    }
  }
}

export class RunOrchestrator {
  private readonly sessions = new Map<string, RunSession>()
  private readonly processRunner: ProcessRunnerPort
  private readonly supervisorVerifier: SupervisorVerifierPort
  private readonly simulationDelayScale: number
  private readonly protocolPollMs: number
  private readonly broadcastBeatMs: number
  private readonly healthProvider: (settings: AppSettings) => Promise<ToolHealth[]>
  private readonly nowMs: () => number
  private lifecycleAdmissionInProgress = false

  constructor(private readonly options: RunOrchestratorOptions) {
    this.simulationDelayScale = options.simulationDelayScale ?? 1
    this.protocolPollMs = options.protocolPollMs ?? 450
    this.broadcastBeatMs = options.broadcastBeatMs ?? 5_000
    this.healthProvider = options.healthProvider ?? checkAllTools
    this.processRunner = options.processRunner ?? new ProcessRunner()
    this.supervisorVerifier = options.supervisorVerifier ?? new SupervisorVerifier()
    this.nowMs = options.now ?? Date.now
  }

  async start(value: unknown): Promise<StartRunResult> {
    return await this.withLifecycleAdmission(() => this.startAdmitted(value))
  }

  private async withLifecycleAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifecycleAdmissionInProgress) {
      throw new Error('Another battle lifecycle transition is already being admitted. Try again in a moment.')
    }
    this.lifecycleAdmissionInProgress = true
    try {
      return await operation()
    } finally {
      this.lifecycleAdmissionInProgress = false
    }
  }

  private async startAdmitted(value: unknown): Promise<StartRunResult> {
    const request = validateRunRequest(value, {
      minimumTurns: this.options.testOnlyMinimumTurns
    })
    const active = [...this.sessions.values()].find((session) => session.snapshot.status === 'running')
    if (active) throw new Error('A run is already active. Stop it before starting another.')

    const settings = await this.options.getSettings()
    const agentRuntimes = await resolveAgentRuntimeProfiles(settings)
    const runId = createRunId()
    const planVersion = this.options.planVersion ?? 'lean-collaboration-v2'
    const turnPlan = planVersion === 'balanced-hybrid-v1'
      ? buildLegacyRealTurnPlan(runId, {
          maxTurns: request.maxTurns,
          maxRepairLoops: request.maxRepairLoops
        })
      : buildRealTurnPlan(runId, {
          maxTurns: request.maxTurns,
          maxRepairLoops: request.maxRepairLoops
        })
    const workspace = await createRunWorkspace({
      root: request.workspaceRoot,
      ...(this.options.runtimeRoot ? { runtimeRoot: this.options.runtimeRoot } : {}),
      runId,
      prompt: request.prompt,
      executionMode: request.executionMode,
      visibilityMode: request.visibilityMode,
      missionProfile: request.missionProfile ?? 'surprise'
    })
    const now = new Date().toISOString()
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const session: RunSession = {
      request,
      settings,
      workspace,
      snapshot: {
        runId,
        prompt: request.prompt,
        executionMode: request.executionMode,
        visibilityMode: request.visibilityMode,
        missionProfile: request.missionProfile ?? 'surprise',
        phase: 'workspace.create',
        status: 'running',
        round: 0,
        totalTurns: request.executionMode === 'simulation'
          ? 8
          : turnPlan.length,
        startedAt: now,
        workspacePath: workspace.workspacePath,
        appPath: workspace.appPath,
        agentRuntimes,
        tasks: [],
        events: []
      },
      redactionTerms:
        request.executionMode === 'simulation' ? buildRedactionTerms(SIMULATION_REDACTIONS) : [],
      revealed: false,
      controller: new AbortController(),
      settled,
      resolveSettled,
      runnerActive: false,
      eventQueue: Promise.resolve(),
      stageEventLedger: new StageEventLedger(),
      seenProtocolEvents: new Set(),
      protocolSyncPending: false,
      turnPlan,
      planVersion,
      activeTurnIndex: 0,
      broadcastTick: 0,
      acceptedCodeAgents: new Set(),
      acceptedReviewAgents: new Set(),
      usageTracker: new RunUsageTracker(),
      runDeadlineMs: this.nowMs() + request.runTimeoutSeconds * 1_000,
      activeSinceMs: this.nowMs(),
      accumulatedActiveMs: 0,
      durableStore: new DurableRunStateStore(workspace.runtimePath, { runId, workspaceId: runId }),
      durableRevision: 0,
      providerSessions: {},
      appEvidenceRevision: 0,
      verifiedAppEvidenceRevision: -1,
      gitHead: undefined,
      appFingerprint: undefined,
      quotaConstrainedAgents: new Set(),
      providerPressure: {}
    }
    this.sessions.set(runId, session)
    this.publishSnapshot(session)

    const git = new GitManager(settings.gitPath, join(workspace.runtimePath, 'supervisor-git'))
    const gitResult = await git.initialize(workspace.workspacePath)
    if (gitResult.ok) {
      await this.createGitCheckpoint(session, git, 'chore(duo): initialize run workspace')
    }

    this.launchSessionRunner(session, git, false)

    return { runId, workspacePath: workspace.workspacePath }
  }

  private launchSessionRunner(session: RunSession, git: GitManager, resuming: boolean): void {
    let resolveSettled: () => void = () => undefined
    session.settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    session.resolveSettled = resolveSettled
    session.runnerActive = true
    const broadcastTimer = setInterval(() => {
      if (session.snapshot.status !== 'running') return
      session.broadcastTick += 1
      this.publishSnapshot(session)
    }, this.broadcastBeatMs)
    const runner = session.request.executionMode === 'simulation'
      ? this.runSimulation(session, git)
      : this.runReal(session, git, resuming ? session.activeTurnIndex : 0, resuming)
    void runner
      .catch(async (error: unknown) => {
        // An explicit lifecycle transition owns the reason. Do not let the
        // cancelled in-flight stage overwrite a shutdown/quota pause while it
        // unwinds after the child process has been terminated.
        if (session.snapshot.status === 'cancelled' || session.snapshot.status === 'paused') return
        if (error instanceof RunTerminalError) {
          this.freezeActiveClock(session)
          session.snapshot.status = 'failed'
          session.snapshot.phase = 'failed'
          session.snapshot.finishedAt = new Date().toISOString()
          session.snapshot.activeAgent = undefined
          session.snapshot.pause = undefined
          if (session.snapshot.turnStage?.status === 'running') {
            session.snapshot.turnStage = { ...session.snapshot.turnStage, status: 'completed' }
          }
          await this.emitEvent(session, createDirectorEvent(session, 'run.failed', error.message, {
            severity: 'critical', topic: error.reason
          }))
          return
        }
        const pause = error instanceof RunPauseError
          ? error.pause
          : {
              reason: 'unknown' as const,
              message: error instanceof Error ? error.message : 'The supervisor could not safely classify the interruption.',
              resumable: true,
              action: 'Inspect diagnostics, then resume the same preserved battle.'
            }
        await this.pauseSession(session, pause)
      })
      .finally(async () => {
        clearInterval(broadcastTimer)
        session.runnerActive = false
        if (session.snapshot.status !== 'running') this.freezeActiveClock(session)
        await this.persistRunState(session).catch(() => undefined)
        resolveSettled()
      })
  }

  private freezeActiveClock(session: RunSession): void {
    if (session.activeSinceMs > 0) {
      session.accumulatedActiveMs += Math.max(0, this.nowMs() - session.activeSinceMs)
      session.activeSinceMs = 0
    }
    session.snapshot.activeTimeMs = session.accumulatedActiveMs
  }

  private async pauseSession(
    session: RunSession,
    input: Omit<RunPauseSnapshot, 'pausedAt' | 'round'>
  ): Promise<void> {
    if (session.snapshot.status === 'cancelled' || session.snapshot.status === 'complete') return
    const pausedAt = new Date().toISOString()
    session.resumePhase = session.snapshot.phase === 'paused'
      ? session.resumePhase
      : session.snapshot.phase
    session.resumeStage = input.stage ?? session.snapshot.turnStage?.stage
    session.pausedAtMs = this.nowMs()
    this.freezeActiveClock(session)
    const pauseStage = input.stage ?? session.snapshot.turnStage?.stage
    session.snapshot.status = 'paused'
    session.snapshot.phase = 'paused'
    session.snapshot.activeAgent = undefined
    session.snapshot.finishedAt = undefined
    session.snapshot.pause = {
      ...input,
      pausedAt,
      round: session.snapshot.round,
      ...(pauseStage ? { stage: pauseStage } : {})
    }
    if (session.snapshot.turnStage?.status === 'running') {
      session.snapshot.turnStage = { ...session.snapshot.turnStage, status: 'paused' }
    }
    await this.emitEvent(session, createDirectorEvent(
      session,
      'run.paused',
      input.message,
      {
        severity: input.reason === 'provider-quota' ? 'high' : 'critical',
        topic: input.reason,
        metadata: {
          pauseReason: input.reason,
          resumable: input.resumable,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.resetAt ? { resetAt: input.resetAt } : {})
        }
      }
    ))
  }

  async resume(runId: string): Promise<RunSnapshot> {
    return await this.withLifecycleAdmission(() => this.resumeAdmitted(runId))
  }

  private async resumeAdmitted(runId: string): Promise<RunSnapshot> {
    const session = this.requireSession(runId)
    const active = [...this.sessions.values()].find((candidate) =>
      candidate.snapshot.runId !== runId && candidate.snapshot.status === 'running'
    )
    if (active) throw new Error('Another battle is already live. Stop or pause it before resuming this one.')
    if (session.snapshot.status !== 'paused' || !session.snapshot.pause?.resumable) {
      throw new Error('This battle is not paused in a resumable state.')
    }
    if (session.runnerActive) throw new Error('The battle is still settling. Try Resume again in a moment.')
    const now = this.nowMs()
    if (session.pausedAtMs !== undefined) {
      session.runDeadlineMs += Math.max(0, now - session.pausedAtMs)
    }
    session.settings = await this.options.getSettings()
    const git = new GitManager(session.settings.gitPath, join(session.workspace.runtimePath, 'supervisor-git'))
    const initialized = await git.initialize(session.workspace.workspacePath)
    if (!initialized.ok) throw new Error(initialized.detail ?? 'The preserved Git checkpoint could not be reopened.')
    const currentFingerprint = await git.appStateFingerprint(session.workspace.workspacePath)
    if (session.appFingerprint && currentFingerprint !== session.appFingerprint) {
      throw new Error('The generated app changed outside the preserved battle. Use the prompt again or restore the recorded workspace before resuming.')
    }
    if (!session.appFingerprint) {
      // One-time migration for battles paused before supervisor-owned fingerprints
      // existed. Preserve the current source, but require fresh verification.
      const migrated = await this.createGitCheckpoint(session, git, 'chore(duo): migrate preserved workspace checkpoint')
      if (!migrated.ok || !session.appFingerprint) {
        throw new Error(migrated.detail ?? 'The preserved workspace could not be sealed by Git.')
      }
      session.verifiedAppEvidenceRevision = -1
    }
    session.snapshot.agentRuntimes = await resolveAgentRuntimeProfiles(session.settings)
    session.controller = new AbortController()
    session.quotaConstrainedAgents.clear()
    session.providerPressure = {}
    session.snapshot.status = 'running'
    session.snapshot.phase = session.resumePhase ?? session.turnPlan[session.activeTurnIndex]?.phase ?? 'reveal.ready'
    session.snapshot.finishedAt = undefined
    session.snapshot.activeAgent = undefined
    session.snapshot.turnStage = undefined
    session.snapshot.pause = undefined
    session.activeSinceMs = now
    session.pausedAtMs = undefined
    await this.emitEvent(session, createDirectorEvent(
      session,
      'run.resumed',
      'The preserved battle resumed from its last durable turn boundary.',
      { severity: 'high', topic: 'run-resumed', metadata: { turnIndex: session.activeTurnIndex } }
    ))
    this.launchSessionRunner(session, git, true)
    return this.publicSnapshot(session)
  }

  async restore(): Promise<number> {
    const runtimeRoot = this.options.runtimeRoot?.trim()
    if (!runtimeRoot) return 0
    const settings = await this.options.getSettings()
    let entries: Dirent[]
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true })
    } catch {
      return 0
    }
    let restored = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^duo-run-[A-Za-z0-9_-]+$/u.test(entry.name)) continue
      const runId = entry.name
      const runtimePath = resolve(runtimeRoot, runId)
      try {
        const store = new DurableRunStateStore(runtimePath, { runId, workspaceId: runId })
        const manifest = await store.reconstruct()
        let legacy: Record<string, unknown> = {}
        try {
          legacy = record(JSON.parse(await readFile(join(runtimePath, 'run.json'), 'utf8')) as unknown)
        } catch {
          legacy = {}
        }
        const workspaceValue = manifest.workspacePath ?? revealText(legacy.workspacePath)
        if (!workspaceValue || !isAbsolute(workspaceValue)) continue
        const workspacePath = resolve(workspaceValue)
        if (basename(workspacePath) !== runId) continue
        const workspaceInfo = await lstat(workspacePath)
        if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) continue
        if (comparableResolvedPath(await realpath(workspacePath)) !== comparableResolvedPath(workspacePath)) continue
        if (!['paused', 'running', 'pausing', 'resuming', 'reveal-ready'].includes(manifest.status)) continue
        const revealReady = manifest.status === 'reveal-ready'
        // Dangerous-mode consent is deliberately ephemeral. Finished sealed work can be
        // revealed without executing an agent, but an active YOLO battle must be started
        // again so the user explicitly reconfirms its disposable environment.
        if (manifest.request.executionMode === 'yolo-sandbox' && !revealReady) continue
        if (revealReady && manifest.request.missionProfile === 'serious') {
          const seriousContractValid = await validateSeriousMissionContract(
            join(workspacePath, '.duo', 'sealed'),
            manifest.request.prompt,
            join(runtimePath, 'private', 'serious_mission_guard.json')
          )
          if (!seriousContractValid) continue
        }
        if (manifest.git.appFingerprint) {
          const git = new GitManager(settings.gitPath, join(runtimePath, 'supervisor-git'))
          const currentFingerprint = await git.appStateFingerprint(workspacePath)
          if (!currentFingerprint || currentFingerprint !== manifest.git.appFingerprint) continue
        }
        const planVersion: RealTurnPlanVersion = manifest.planVersion === 'balanced-hybrid-v1'
          ? 'balanced-hybrid-v1'
          : 'lean-collaboration-v2'
        const turnPlan = planVersion === 'balanced-hybrid-v1'
          ? buildLegacyRealTurnPlan(runId, {
              maxTurns: manifest.request.maxTurns,
              maxRepairLoops: manifest.request.maxRepairLoops
            })
          : buildRealTurnPlan(runId, {
          maxTurns: manifest.request.maxTurns,
          maxRepairLoops: manifest.request.maxRepairLoops
            })
        // A cursor equal to the plan length is the durable "all turns complete"
        // sentinel. Preserve it so a crash during reveal assembly does not replay
        // the final (and often most expensive) provider turn.
        const activeTurnIndex = Math.min(Math.max(0, manifest.cursor.turnIndex), turnPlan.length)
        const activeRound = Math.min(activeTurnIndex + 1, Math.max(1, turnPlan.length))
        const events = await this.readRestoredPublicEvents(runtimePath, runId)
        let tasks: DuoTask[] = []
        try {
          const boardContent = await safeReadProtocolText(
            join(workspacePath, '.duo'),
            join(workspacePath, '.duo', 'board.json')
          )
          if (boardContent !== undefined) tasks = normalizeBoard(JSON.parse(boardContent) as unknown)
        } catch {
          tasks = []
        }
        const interrupted = !revealReady && manifest.status !== 'paused'
        const restoredReason = manifest.pause?.detailCode
        const supportedReasons = new Set<RunPauseSnapshot['reason']>([
          'provider-quota', 'provider-auth', 'provider-unavailable', 'model-unavailable',
          'cli-incompatible', 'provider-protocol', 'session-lost', 'stage-timeout',
          'host-interrupted', 'workspace-drift', 'verification-failed', 'unknown'
        ])
        const reason = interrupted
          ? 'host-interrupted' as const
          : supportedReasons.has(restoredReason as RunPauseSnapshot['reason'])
            ? restoredReason as RunPauseSnapshot['reason']
            : manifest.pause?.reason === 'other'
              ? 'unknown' as const
              : manifest.pause?.reason as RunPauseSnapshot['reason'] ?? 'unknown'
        const pausedAt = interrupted ? new Date().toISOString() : manifest.pause?.pausedAt ?? manifest.updatedAt
        const provider = manifest.pause?.agent
        const pause: RunPauseSnapshot = {
          reason,
          ...(provider ? { provider } : {}),
          message: interrupted
            ? 'Duo Chaos closed while this battle was active. The durable turn boundary was recovered.'
            : reason === 'provider-quota'
              ? `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'A provider'} reached a usage boundary. The balanced battle remains preserved.`
              : 'The battle is preserved at a recoverable provider boundary.',
          pausedAt,
          ...(manifest.pause?.resetAt ? { resetAt: manifest.pause.resetAt } : {}),
          resumable: true,
          round: activeRound,
          stage: manifest.cursor.stage,
          action: reason === 'provider-quota'
            ? 'Resume when usage is available again.'
            : 'Resume the same preserved turn.'
        }
        let resolveSettled: () => void = () => undefined
        const settled = new Promise<void>((resolvePromise) => {
          resolveSettled = resolvePromise
          resolvePromise()
        })
        const claudeResolvedEffort = manifest.loadout.claude.resolvedEffort
        const codexResolvedEffort = manifest.loadout.codex.resolvedEffort
        const claudeEffort = claudeResolvedEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(claudeResolvedEffort)
          ? claudeResolvedEffort as Exclude<AgentEffort, 'default'>
          : undefined
        const codexEffort = codexResolvedEffort && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(codexResolvedEffort)
          ? codexResolvedEffort as Exclude<CodexEffort, 'default'>
          : undefined
        const agentRuntimes: RunSnapshot['agentRuntimes'] = {
          claude: {
            ...(manifest.loadout.claude.resolvedModel ? { model: manifest.loadout.claude.resolvedModel } : {}),
            ...(claudeEffort ? { effort: claudeEffort } : {}),
            source: 'studio'
          },
          codex: {
            ...(manifest.loadout.codex.resolvedModel ? { model: manifest.loadout.codex.resolvedModel } : {}),
            ...(codexEffort ? { effort: codexEffort } : {}),
            source: 'studio'
          }
        }
        const request: StartRunRequest = {
          ...manifest.request,
          workspaceRoot: dirname(workspacePath),
          dangerousModeConfirmed: false,
          unsafeWorkspaceRootConfirmed: false
        }
        const session: RunSession = {
          request,
          settings,
          workspace: {
            workspacePath,
            appPath: join(workspacePath, 'app'),
            duoPath: join(workspacePath, '.duo'),
            runtimePath
          },
          snapshot: {
            runId,
            prompt: manifest.request.prompt,
            executionMode: manifest.request.executionMode,
            visibilityMode: manifest.request.visibilityMode,
            missionProfile: manifest.request.missionProfile,
            phase: revealReady ? 'reveal.ready' : 'paused',
            status: revealReady ? 'reveal-ready' : 'paused',
            round: activeRound,
            totalTurns: turnPlan.length,
            startedAt: revealText(legacy.createdAt) ?? manifest.updatedAt,
            activeTimeMs: manifest.timing.accumulatedActiveMs,
            workspacePath,
            appPath: join(workspacePath, 'app'),
            agentRuntimes,
            ...(!revealReady ? { pause } : {}),
            tasks,
            events
          },
          redactionTerms: [],
          revealed: false,
          controller: new AbortController(),
          settled,
          resolveSettled,
          runnerActive: false,
          eventQueue: Promise.resolve(),
          stageEventLedger: new StageEventLedger(events),
          seenProtocolEvents: new Set(events.map((event) => event.id)),
          protocolSyncPending: false,
          turnPlan,
          planVersion,
          activeTurnIndex,
          broadcastTick: 0,
          acceptedCodeAgents: new Set(manifest.evidence.acceptedCodeAgents),
          acceptedReviewAgents: new Set(manifest.evidence.acceptedReviewAgents),
          usageTracker: new RunUsageTracker({
            claude: { ...manifest.usage.claude, largestRawLineBytes: 0 },
            codex: { ...manifest.usage.codex, largestRawLineBytes: 0 }
          }),
          runDeadlineMs: this.nowMs() + Math.max(
            1_000,
            manifest.request.runTimeoutSeconds * 1_000 - manifest.timing.accumulatedActiveMs
          ),
          activeSinceMs: 0,
          accumulatedActiveMs: manifest.timing.accumulatedActiveMs,
          // The restored deadline is already reconstructed from active time;
          // do not count app downtime a second time when Resume is clicked.
          ...(revealReady ? {} : { pausedAtMs: this.nowMs() }),
          resumePhase: turnPlan[activeTurnIndex]?.phase ?? 'reveal.ready',
          resumeStage: manifest.cursor.stage,
          resumeRecoveryOriginStage: manifest.cursor.recoveryOriginStage,
          resumeRecoveryReasons: manifest.cursor.recoveryReasons,
          durableStore: store,
          durableRevision: manifest.revision,
          providerSessions: { ...manifest.providerSessions },
          appEvidenceRevision: manifest.evidence.appRevision,
          verifiedAppEvidenceRevision: manifest.evidence.verifiedAppRevision,
          ...(manifest.git.head ? { gitHead: manifest.git.head } : {}),
          ...(manifest.git.appFingerprint ? { appFingerprint: manifest.git.appFingerprint } : {}),
          quotaConstrainedAgents: new Set(!revealReady && provider ? [provider] : []),
          providerPressure: {}
        }
        this.sessions.set(runId, session)
        await this.loadRedactionDictionary(session)
        if (revealReady) {
          const packet = await this.readExistingRevealPacket(session)
          if (!packet) {
            this.sessions.delete(runId)
            continue
          }
          session.privateRevealPacket = packet
          session.snapshot.releaseStatus = packet.status
          session.snapshot.finishedAt = revealText(legacy.updatedAt) ?? manifest.updatedAt
          this.publishSnapshot(session)
        } else if (interrupted) {
          await this.emitEvent(session, createDirectorEvent(
            session,
            'run.paused',
            pause.message,
            { severity: 'high', topic: 'host-interrupted', metadata: { resumable: true } }
          ))
        } else {
          this.publishSnapshot(session)
        }
        restored += 1
      } catch {
        // A damaged or mismatched run is left in history for diagnostics; it is never auto-resumed.
      }
    }
    return restored
  }

  private async readRestoredPublicEvents(runtimePath: string, runId: string): Promise<DuoEvent[]> {
    try {
      const path = join(runtimePath, 'public', 'timeline.jsonl')
      const info = await stat(path)
      if (!info.isFile() || info.size > 4_000_000) return []
      const events: DuoEvent[] = []
      for (const line of (await readFile(path, 'utf8')).split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const candidate = record(JSON.parse(line) as unknown)
          if (candidate.runId !== runId || typeof candidate.id !== 'string' || typeof candidate.type !== 'string') continue
          const event = candidate as unknown as DuoEvent
          // Runtime public history may contain agent-authored workspace speech
          // recorded before a restart (or before a stronger redaction build).
          // Reapply the same untrusted provenance used by live protocol polling
          // so Spoiler Shield cannot be bypassed merely by restoring a battle.
          events.push(
            (event.type === 'agent.dispatch' || event.type === 'opinion') &&
            (event.agent === 'claude' || event.agent === 'codex')
              ? {
                  ...event,
                  metadata: {
                    ...event.metadata,
                    protocolOrigin: 'workspace-public-protocol',
                    protocolSourceKey: 'runtime/public/timeline.jsonl'
                  }
                }
              : event
          )
        } catch {
          // A truncated final line is ignored; the durable event cursor prevents invented state.
        }
      }
      return events.slice(-650)
    } catch {
      return []
    }
  }

  getSnapshot(runId: string): RunSnapshot | undefined {
    const session = this.sessions.get(runId)
    return session ? this.publicSnapshot(session) : undefined
  }

  listSnapshots(): RunSnapshot[] {
    return [...this.sessions.values()].map((session) => this.publicSnapshot(session))
  }

  async waitForSettled(runId: string): Promise<void> {
    const session = this.sessions.get(runId)
    if (!session) throw new Error('Run not found.')
    await session.settled
  }

  async stop(runId: string): Promise<RunSnapshot> {
    const session = this.requireSession(runId)
    if (session.snapshot.status !== 'running' && session.snapshot.status !== 'paused') return this.publicSnapshot(session)
    session.controller.abort()
    this.freezeActiveClock(session)
    session.snapshot.status = 'cancelled'
    session.snapshot.phase = 'cancelled'
    session.snapshot.finishedAt = new Date().toISOString()
    session.snapshot.activeAgent = undefined
    session.snapshot.pause = undefined
    if (session.snapshot.turnStage?.status === 'running') {
      session.snapshot.turnStage = { ...session.snapshot.turnStage, status: 'completed' }
    }
    await this.processRunner.cancelAll()
    await this.emitEvent(session, createDirectorEvent(session, 'run.cancelled', 'Run stopped. Active agent processes were terminated.', { severity: 'high' }))
    return this.publicSnapshot(session)
  }

  async suspendForShutdown(): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.snapshot.status === 'running')
    for (const session of running) {
      await this.pauseSession(session, {
        reason: 'host-interrupted',
        message: 'Duo Chaos is closing. The active battle is stopping at a durable boundary and its workspace will be checkpointed before exit.',
        resumable: true,
        action: 'Reopen Duo Chaos and resume the preserved battle.'
      })
      session.controller.abort()
    }
    if (running.length === 0) return
    await this.processRunner.cancelAll()
    await Promise.all(running.map((session) => session.settled))
    await Promise.all(running.map(async (session) => {
      const git = new GitManager(session.settings.gitPath, join(session.workspace.runtimePath, 'supervisor-git'))
      const initialized = await git.initialize(session.workspace.workspacePath)
      let checkpoint: GitResult | undefined
      if (initialized.ok) {
        checkpoint = await this.createGitCheckpoint(session, git, 'chore(duo): checkpoint before app shutdown')
      }
      if (!initialized.ok || !checkpoint?.ok || !session.appFingerprint) {
        session.appFingerprint = undefined
        session.snapshot.pause = {
          reason: 'cli-incompatible',
          message: `Duo Chaos closed after Git could not seal the final shutdown boundary (${checkpoint?.detail ?? initialized.detail ?? 'app fingerprint unavailable'}). The source remains on disk.`,
          pausedAt: new Date().toISOString(),
          resumable: true,
          round: session.snapshot.round,
          action: 'Restore Git, reopen Duo Chaos, and resume; the workspace will be migrated into a fresh durable checkpoint.'
        }
      }
      await this.persistRunState(session)
    }))
  }

  async reveal(runId: string): Promise<RunSnapshot> {
    const session = this.requireSession(runId)
    if (session.snapshot.status !== 'reveal-ready' || !session.privateRevealPacket) {
      throw new Error('Reveal is not ready yet.')
    }
    session.revealed = true
    this.freezeActiveClock(session)
    session.snapshot.status = 'complete'
    session.snapshot.phase = 'complete'
    session.snapshot.finishedAt ??= new Date().toISOString()
    session.snapshot.activeAgent = undefined
    await this.emitEvent(session, createDirectorEvent(session, 'run.completed', `${session.privateRevealPacket.appName} is revealed.`, { severity: 'high', spoilerRisk: 1 }))
    return this.publicSnapshot(session)
  }

  private requireSession(runId: string): RunSession {
    const session = this.sessions.get(runId)
    if (!session) throw new Error('Run not found.')
    return session
  }

  private publicSnapshot(session: RunSession): RunSnapshot {
    const tasks = session.snapshot.tasks.map((task) => projectTaskForRenderer(
      task,
      session.request.visibilityMode,
      session.revealed,
      session.redactionTerms
    ))
    const events = session.snapshot.events.map((event) =>
      projectEventForRenderer(event, session.request.visibilityMode, session.revealed, session.redactionTerms)
    )
    const state = buildBroadcastState({
      runId: session.snapshot.runId,
      now: new Date().toISOString(),
      tick: session.broadcastTick,
      activeTurnIndex: session.activeTurnIndex,
      plan: session.turnPlan,
      events,
      tasks
    })
    const nextAgent = session.turnPlan[session.activeTurnIndex + 1]?.agent
    const broadcast: BroadcastSnapshot = {
      ...state,
      queue: state.beats,
      ...(state.responseDue?.agent || nextAgent
        ? { responseDueAgent: state.responseDue?.agent ?? nextAgent }
        : {}),
      ...(nextAgent ? { nextAgent } : {}),
      generatedAt: new Date().toISOString()
    }
    return {
      ...session.snapshot,
      activeTimeMs: session.accumulatedActiveMs + (session.activeSinceMs > 0
        ? Math.max(0, this.nowMs() - session.activeSinceMs)
        : 0),
      tasks,
      events,
      broadcast,
      agentUsage: session.usageTracker.snapshot(),
      ...(session.revealed && session.privateRevealPacket
        ? { revealPacket: session.privateRevealPacket }
        : { revealPacket: undefined })
    }
  }

  private publishSnapshot(session: RunSession): void {
    this.options.onSnapshot(this.publicSnapshot(session))
  }

  private async emitEvent(session: RunSession, event: DuoEvent, options: { protocolOrigin?: boolean } = {}): Promise<void> {
    if (event.type === 'reveal.ready' && !this.runIsActive(session)) return
    if (session.seenProtocolEvents.has(event.id)) return
    session.seenProtocolEvents.add(event.id)
    // The supervisor owns the scheduled round. Provider-authored protocol
    // records are stamped at ingestion and may not advance the run counter.
    if (!options.protocolOrigin) {
      session.snapshot.round = Math.max(session.snapshot.round, event.round)
    }
    session.snapshot.phase = phaseForEvent(event, session.snapshot.phase)
    if (event.type === 'agent.started') {
      session.snapshot.activeAgent = event.agent
      session.activeTurnIndex = Math.min(
        Math.max(0, event.round - 1),
        Math.max(0, session.turnPlan.length - 1)
      )
    }
    if (
      event.type === 'agent.dispatch' ||
      event.type === 'opinion' ||
      event.type === 'conflict' ||
      event.type === 'decision' ||
      event.type.startsWith('task.') ||
      event.type.startsWith('build.') ||
      event.type.startsWith('repair.') ||
      event.type === 'reveal.ready'
    ) {
      session.broadcastTick = 0
    }
    if (event.task) {
      const index = session.snapshot.tasks.findIndex((task) => task.id === event.task?.id)
      if (index >= 0) session.snapshot.tasks[index] = event.task
      else session.snapshot.tasks.push(event.task)
    }
    if (event.type === 'reveal.ready' && event.revealPacket) {
      session.privateRevealPacket = event.revealPacket
      event.status = event.revealPacket.status
      session.snapshot.releaseStatus = event.revealPacket.status
      session.snapshot.status = 'reveal-ready'
      session.snapshot.phase = 'reveal.ready'
      session.snapshot.activeAgent = undefined
      session.snapshot.finishedAt ??= new Date().toISOString()
      if (session.snapshot.turnStage?.status === 'running') {
        session.snapshot.turnStage = { ...session.snapshot.turnStage, status: 'completed' }
      }
    }
    if (event.type === 'build.failed' && event.topic !== 'supervisor-verification') {
      session.verifiedAppEvidenceRevision = -1
      session.supervisorVerificationAttempt = undefined
      if (session.snapshot.status === 'reveal-ready' && session.privateRevealPacket) {
        const issue = 'A recorded verification failure arrived after the preliminary ready signal. The artifact is preserved, but readiness requires a fresh supervisor pass.'
        session.privateRevealPacket = {
          ...session.privateRevealPacket,
          status: 'partial',
          knownIssues: uniqueRevealStrings([...session.privateRevealPacket.knownIssues, issue])
        }
        session.snapshot.releaseStatus = 'partial'
      }
    }
    session.snapshot.events.push(event)
    session.stageEventLedger.append(event)
    while (session.snapshot.events.length > 650) {
      const disposable = session.snapshot.events.findIndex((candidate) => candidate.type === 'cli.log')
      session.snapshot.events.splice(disposable >= 0 ? disposable : 0, 1)
    }

    // Keep the on-camera war room responsive while the crash-safe journal is
    // flushed. The exact same canonical event is persisted immediately below.
    this.publishSnapshot(session)
    await this.persistRunState(session)

    const projected = projectEventForRenderer(
      event,
      session.request.visibilityMode,
      session.revealed,
      session.redactionTerms
    )
    const runtimePublicRoot = join(session.workspace.runtimePath, 'public')
    const runtimePrivateRoot = join(session.workspace.runtimePath, 'private')
    const protocolPublicRoot = join(session.workspace.duoPath, 'public')
    const protocolPrivateRoot = join(session.workspace.duoPath, 'private')
    await appendRunEvent(
      { publicPath: join(runtimePublicRoot, 'timeline.jsonl'), privatePath: join(runtimePrivateRoot, 'transcript.jsonl') },
      event,
      projected
    )
    if (event.type === 'opinion' && !options.protocolOrigin) {
      await appendWorkspaceProtocolEvent(
        session.workspace.duoPath,
        join(protocolPublicRoot, 'opinions.jsonl'),
        join(protocolPrivateRoot, 'opinions.jsonl'),
        event,
        projected
      )
    }
    if (event.type === 'agent.dispatch' && !options.protocolOrigin) {
      await appendWorkspaceProtocolEvent(
        session.workspace.duoPath,
        join(protocolPublicRoot, 'dispatches.jsonl'),
        join(protocolPrivateRoot, 'dispatches.jsonl'),
        event,
        projected
      )
    }
    if (event.type === 'conflict' && !options.protocolOrigin) {
      await appendWorkspaceProtocolEvent(
        session.workspace.duoPath,
        join(protocolPublicRoot, 'conflicts.jsonl'),
        join(protocolPrivateRoot, 'conflicts.jsonl'),
        event,
        projected
      )
    }
    if (event.type.startsWith('task.') && !options.protocolOrigin) {
      await appendWorkspaceProtocolEvent(
        session.workspace.duoPath,
        join(protocolPublicRoot, 'tasks.jsonl'),
        join(protocolPrivateRoot, 'tasks.jsonl'),
        event,
        projected
      )
    }
    this.options.onEvent?.(projected)
    this.publishSnapshot(session)
  }

  private enqueueEvent(session: RunSession, event: DuoEvent): void {
    session.eventQueue = session.eventQueue.then(() => this.emitEvent(session, event))
  }

  private enqueueProtocolSync(session: RunSession): void {
    if (session.protocolSyncPending || session.controller.signal.aborted) return
    session.protocolSyncPending = true
    session.eventQueue = session.eventQueue
      .then(() => this.ingestProtocolState(session))
      .finally(() => {
        session.protocolSyncPending = false
      })
  }

  private async persistRunState(session: RunSession): Promise<void> {
    const agentUsage = session.usageTracker.snapshot()
    const signature = JSON.stringify({
      status: session.snapshot.status,
      phase: session.snapshot.phase,
      round: session.snapshot.round,
      totalTurns: session.snapshot.totalTurns,
      activeAgent: session.snapshot.activeAgent ?? null,
      turnStage: session.snapshot.turnStage ?? null,
      pause: session.snapshot.pause ?? null,
      activeTurnIndex: session.activeTurnIndex,
      releaseStatus: session.snapshot.releaseStatus ?? null,
      agentUsage,
      providerSessions: session.providerSessions,
      resumeRecoveryOriginStage: session.resumeRecoveryOriginStage ?? null,
      resumeRecoveryReasons: session.resumeRecoveryReasons ?? null,
      gitHead: session.gitHead ?? null,
      appFingerprint: session.appFingerprint ?? null,
      appEvidenceRevision: session.appEvidenceRevision,
      verifiedAppEvidenceRevision: session.verifiedAppEvidenceRevision
    })
    if (signature === session.lastStateSignature) return
    session.lastStateSignature = signature
    session.durableRevision += 1
    await session.durableStore.persist(this.durableManifest(session, agentUsage))
    await writeFile(
      join(session.workspace.runtimePath, 'run.json'),
      `${JSON.stringify({
        runId: session.snapshot.runId,
        createdAt: session.snapshot.startedAt,
        updatedAt: new Date().toISOString(),
        status: session.snapshot.status,
        phase: session.snapshot.phase,
        prompt: session.snapshot.prompt,
        executionMode: session.snapshot.executionMode,
        visibilityMode: session.snapshot.visibilityMode,
        missionProfile: session.snapshot.missionProfile ?? 'surprise',
        round: session.snapshot.round,
        totalTurns: session.snapshot.totalTurns,
        agentUsage,
        activeTurnIndex: session.activeTurnIndex,
        activeTimeMs: session.accumulatedActiveMs + (session.activeSinceMs > 0
          ? Math.max(0, this.nowMs() - session.activeSinceMs)
          : 0),
        ...(session.snapshot.pause ? { pause: session.snapshot.pause } : {}),
        ...(session.snapshot.finishedAt ? { finishedAt: session.snapshot.finishedAt } : {}),
        ...(session.snapshot.turnStage ? { turnStage: session.snapshot.turnStage } : {}),
        ...(session.snapshot.releaseStatus ? { releaseStatus: session.snapshot.releaseStatus } : {}),
        ...(session.snapshot.activeAgent ? { activeAgent: session.snapshot.activeAgent } : {}),
        workspacePath: session.snapshot.workspacePath,
        appPath: session.snapshot.appPath
      }, null, 2)}\n`,
      'utf8'
    )
  }

  private async createGitCheckpoint(session: RunSession, git: GitManager, message: string): Promise<GitResult> {
    const checkpoint = await git.checkpoint(session.workspace.workspacePath, message)
    if (!checkpoint.ok) return checkpoint
    if (checkpoint.commit) session.gitHead = checkpoint.commit
    session.appFingerprint = await git.appStateFingerprint(session.workspace.workspacePath)
    return checkpoint
  }

  private async requireGitCheckpoint(
    session: RunSession,
    git: GitManager,
    message: string,
    boundary: { stage?: TurnStageName; provider?: 'claude' | 'codex' } = {}
  ): Promise<GitResult> {
    let checkpoint = await this.createGitCheckpoint(session, git, message)
    if (!checkpoint.ok || !session.appFingerprint) {
      // Git can transiently lose a lock or briefly race an antivirus/indexer on
      // Windows. Retry the exact checkpoint once before asking the human to
      // intervene; provider work is not repeated.
      checkpoint = await this.createGitCheckpoint(session, git, `${message} (retry)`)
    }
    if (checkpoint.ok && session.appFingerprint) return checkpoint
    // An absent fingerprint deliberately activates the one-time migration path
    // after Git is repaired. That preserves user work instead of pretending an
    // unverifiable checkpoint is safe to resume automatically.
    session.appFingerprint = undefined
    throw new RunPauseError({
      reason: 'cli-incompatible',
      ...(boundary.provider ? { provider: boundary.provider } : {}),
      message: `Git could not seal the latest workspace boundary (${checkpoint.detail ?? 'app fingerprint unavailable'}). The generated source remains on disk and no later agent turn will start.`,
      resumable: true,
      ...(boundary.stage ? { stage: boundary.stage } : {}),
      action: 'Restore a working Git installation, then resume the preserved battle from this boundary.'
    })
  }

  private durableManifest(session: RunSession, usage: ReturnType<RunUsageTracker['snapshot']>): DurableRunManifest {
    const timestamp = new Date().toISOString()
    const runtimeFor = (agent: 'claude' | 'codex') => session.snapshot.agentRuntimes?.[agent]
    const selectedModel = (agent: 'claude' | 'codex') => agent === 'claude'
      ? session.settings.claudeModel
      : session.settings.codexModel
    const selectedEffort = (agent: 'claude' | 'codex') => agent === 'claude'
      ? session.settings.claudeEffort
      : session.settings.codexEffort
    const executable = (agent: 'claude' | 'codex') => agent === 'claude'
      ? session.settings.claudePath
      : session.settings.codexPath
    const loadout = (agent: 'claude' | 'codex') => {
      const requestedModel = selectedModel(agent).trim()
      const requestedEffort = selectedEffort(agent)
      const resolved = runtimeFor(agent)
      return {
        executable: executable(agent),
        ...(requestedModel ? { requestedModel } : {}),
        ...(requestedEffort !== 'default' ? { requestedEffort } : {}),
        ...(resolved?.model ? { resolvedModel: resolved.model } : {}),
        ...(resolved?.effort ? { resolvedEffort: resolved.effort } : {})
      }
    }
    const capability = (agent: 'claude' | 'codex') => {
      const pinned = session.preflightReport?.providers[agent]
      const model = runtimeFor(agent)?.model ?? selectedModel(agent).trim()
      const effort = runtimeFor(agent)?.effort ?? (selectedEffort(agent) === 'default' ? undefined : selectedEffort(agent))
      const streamFormat = pinned?.transportFormats.includes('jsonl')
        ? 'jsonl' as const
        : pinned?.transportFormats.some((format) => format === 'json' || format === 'stream-json')
          ? 'mixed' as const
          : agent === 'claude' ? 'mixed' as const : 'jsonl' as const
      return {
        adapterVersion: 'duo-provider-envelope-v1',
        cliVersion: pinned?.cliVersion ?? 'unverified-at-manifest-write',
        streamFormat,
        structuredOutput: pinned?.structuredOutput ?? true,
        sessionResume: pinned?.sessionResume ?? true,
        discoveredAt: pinned?.capturedAt ?? session.snapshot.startedAt,
        ...(pinned?.models.length
          ? { models: pinned.models.map((candidate) => candidate.id) }
          : model ? { models: [model] } : {}),
        ...(pinned?.efforts.length
          ? { efforts: pinned.efforts }
          : effort ? { efforts: [effort] } : {})
      }
    }
    const usageOf = (agent: 'claude' | 'codex') => ({
      processedInputTokens: usage[agent].processedInputTokens,
      cachedInputTokens: usage[agent].cachedInputTokens,
      outputTokens: usage[agent].outputTokens,
      reasoningTokens: usage[agent].reasoningTokens,
      calls: usage[agent].calls,
      ...(usage[agent].reportedCostUsd !== undefined ? { reportedCostUsd: usage[agent].reportedCostUsd } : {})
    })
    const allowedPauseReason = new Set([
      'provider-quota', 'provider-auth', 'provider-unavailable', 'host-interrupted',
      'cli-incompatible', 'workspace-drift'
    ])
    const pauseReason = session.snapshot.pause?.reason
    // Resume clears the live stage card before the provider starts again. Keep
    // the preserved durable cursor during that small window so a second host
    // interruption cannot regress work/verdict/recovery back to dialogue.
    const cursorStage = session.snapshot.turnStage?.stage ?? session.resumeStage ?? 'dialogue'
    const remainingLeaseMs = session.snapshot.turnStage
      ? Math.max(0, Date.parse(session.snapshot.turnStage.deadlineAt) - this.nowMs())
      : Math.max(0, session.runDeadlineMs - this.nowMs())
    return {
      schemaVersion: 1,
      planVersion: session.planVersion,
      revision: session.durableRevision,
      runId: session.snapshot.runId,
      workspaceId: session.snapshot.runId,
      workspacePath: session.workspace.workspacePath,
      status: session.snapshot.status === 'idle' ? 'running' : session.snapshot.status,
      updatedAt: timestamp,
      request: {
        prompt: session.request.prompt,
        executionMode: session.request.executionMode,
        visibilityMode: session.request.visibilityMode,
        missionProfile: session.request.missionProfile ?? 'surprise',
        maxTurns: session.request.maxTurns,
        maxRepairLoops: session.request.maxRepairLoops,
        turnTimeoutSeconds: session.request.turnTimeoutSeconds,
        runTimeoutSeconds: session.request.runTimeoutSeconds
      },
      loadout: { claude: loadout('claude'), codex: loadout('codex') },
      capabilities: { claude: capability('claude'), codex: capability('codex') },
      cursor: {
        turnIndex: session.activeTurnIndex,
        stage: cursorStage,
        attempt: session.snapshot.turnStage?.attempt ?? 1,
        idempotencyKey: `${session.snapshot.runId}:${String(session.activeTurnIndex)}:${cursorStage}`,
        ...(session.resumeRecoveryOriginStage ? { recoveryOriginStage: session.resumeRecoveryOriginStage } : {}),
        ...(session.resumeRecoveryReasons?.length ? { recoveryReasons: session.resumeRecoveryReasons } : {})
      },
      providerSessions: { ...session.providerSessions },
      evidence: {
        acceptedCodeAgents: [...session.acceptedCodeAgents],
        acceptedReviewAgents: [...session.acceptedReviewAgents],
        completedTaskAgents: [...new Set(session.snapshot.tasks
          .filter((task) => task.status === 'done' && (task.claimedBy === 'claude' || task.claimedBy === 'codex'))
          .map((task) => task.claimedBy as 'claude' | 'codex'))],
        appRevision: session.appEvidenceRevision,
        verifiedAppRevision: session.verifiedAppEvidenceRevision
      },
      git: {
        ...(session.gitHead ? { head: session.gitHead } : {}),
        ...(session.appFingerprint ? { appFingerprint: session.appFingerprint } : {})
      },
      timing: {
        remainingLeaseMs,
        accumulatedActiveMs: session.accumulatedActiveMs + (session.activeSinceMs > 0
          ? Math.max(0, this.nowMs() - session.activeSinceMs)
          : 0)
      },
      usage: { claude: usageOf('claude'), codex: usageOf('codex') },
      retries: [],
      ...(session.snapshot.pause && pauseReason
        ? {
            pause: {
              reason: allowedPauseReason.has(pauseReason)
                ? pauseReason as 'provider-quota' | 'provider-auth' | 'provider-unavailable' | 'host-interrupted' | 'cli-incompatible' | 'workspace-drift'
                : 'other' as const,
              ...(session.snapshot.pause.provider ? { agent: session.snapshot.pause.provider } : {}),
              pausedAt: session.snapshot.pause.pausedAt,
              ...(session.snapshot.pause.resetAt ? { resetAt: session.snapshot.pause.resetAt } : {}),
              ...(!allowedPauseReason.has(pauseReason) ? { detailCode: pauseReason } : {})
            }
          }
        : {}),
      eventCursor: {
        sequence: session.snapshot.events.length,
        ...(session.snapshot.events.at(-1)?.id ? { lastEventId: session.snapshot.events.at(-1)?.id } : {})
      }
    }
  }

  private async runSimulation(session: RunSession, git: GitManager): Promise<void> {
    await writeFile(join(session.workspace.appPath, 'index.html'), SIMULATION_ARTIFACT_HTML, 'utf8')
    for (const step of buildSimulationScript(
      session.snapshot.runId,
      session.request.prompt,
      session.request.missionProfile ?? 'surprise'
    )) {
      if (session.controller.signal.aborted) return
      await delay(step.delayMs * this.simulationDelayScale, session.controller.signal)
      await this.emitEvent(session, step.event)
      if (step.event.type === 'reveal.ready' && step.event.revealPacket) {
        await safeWriteProtocolText(
          session.workspace.duoPath,
          join(session.workspace.duoPath, 'sealed', 'reveal_packet.json'),
          `${JSON.stringify(step.event.revealPacket, null, 2)}\n`
        )
        await this.createGitCheckpoint(session, git, 'chore(duo): reveal ready')
      }
    }
  }

  private async runReal(session: RunSession, git: GitManager, startIndex = 0, resuming = false): Promise<void> {
    await this.emitEvent(session, createDirectorEvent(
      session,
      resuming ? 'health.check' : 'run.started',
      resuming ? 'Resume preflight confirmed the local agent runtimes.' : 'Real Mode preflight started.'
    ))
    const health = await this.healthProvider(session.settings)
    for (const tool of health) {
      await this.emitEvent(
        session,
        createDirectorEvent(
          session,
          'health.check',
          tool.available ? `${tool.label} ready: ${tool.version ?? 'detected'}` : `${tool.label} unavailable: ${tool.detail ?? 'not found'}`,
          { severity: tool.available ? 'low' : 'high', metadata: { tool } }
        )
      )
    }
    const gitHealth = health.find((tool) => tool.id === 'git')
    if (gitHealth?.available !== true || !session.appFingerprint) {
      throw new RunPauseError({
        reason: 'cli-incompatible',
        message: 'Real Mode needs a working Git checkpoint before either agent may edit. The sealed workspace remains preserved and Simulation Mode remains available.',
        resumable: true,
        action: 'Install or reconfigure Git, refresh Agent loadout, then resume the same battle.'
      })
    }
    const rawPreflight = buildRunPreflightReport({
      capturedAt: new Date().toISOString(),
      tools: health,
      contracts: EXPECTED_PROVIDER_CONTRACTS,
      selections: {
        claude: {
          ...(session.settings.claudeModel.trim() ? { model: session.settings.claudeModel } : {}),
          effort: session.settings.claudeEffort
        },
        codex: {
          ...(session.settings.codexModel.trim() ? { model: session.settings.codexModel } : {}),
          effort: session.settings.codexEffort
        }
      }
    })
    const hardBlockers = rawPreflight.blockers.filter((issue) => {
      if (issue.code !== 'model-unsupported' && issue.code !== 'effort-unsupported') return true
      return rawPreflight.providers[issue.agent].source === 'verified'
    })
    const downgraded = rawPreflight.blockers.filter((issue) => !hardBlockers.includes(issue))
    session.preflightReport = {
      ...rawPreflight,
      ready: hardBlockers.length === 0,
      blockers: hardBlockers,
      warnings: [...rawPreflight.warnings, ...downgraded]
    }
    for (const warning of session.preflightReport.warnings) {
      await this.emitEvent(session, createDirectorEvent(
        session,
        'health.check',
        warning.message,
        { severity: 'medium', topic: warning.code, metadata: { agent: warning.agent, verified: false } }
      ))
    }
    if (hardBlockers.length > 0) {
      const missing = hardBlockers.filter((issue) => issue.code === 'provider-unavailable')
      const modelBlocked = hardBlockers.find((issue) => issue.code === 'model-unsupported' || issue.code === 'effort-unsupported')
      throw new RunPauseError({
        reason: modelBlocked ? 'model-unavailable' : 'cli-incompatible',
        ...(modelBlocked ? { provider: modelBlocked.agent } : {}),
        message: missing.length > 0
          ? `Real Mode needs ${missing.map((issue) => issue.agent === 'claude' ? 'Claude Code' : 'Codex CLI').join(' and ')}. The workspace remains preserved; Simulation Mode remains available.`
          : `Provider compatibility preflight found ${hardBlockers.map((issue) => issue.message).join(' ')} The workspace remains preserved.`,
        resumable: true,
        action: modelBlocked
          ? 'Choose an advertised model and effort in Agent loadout, apply it, then resume.'
          : 'Install, update, or sign in to the missing CLI, refresh Agent loadout, then resume the battle.'
      })
    }

    const turns = session.turnPlan
    let runCeilingReached = false
    turnLoop: for (let index = startIndex; index < turns.length; index += 1) {
      if (session.controller.signal.aborted) return
      if (this.remainingRunSeconds(session) <= 0) {
        runCeilingReached = true
        break
      }
      const turn = turns[index]
      if (!turn) continue
      const pressure = session.providerPressure[turn.agent]
      if (pressure?.status === 'allowed_warning' && (pressure.utilization ?? 0) >= 0.9) {
        session.quotaConstrainedAgents.add(turn.agent)
        throw new RunPauseError({
          reason: 'provider-quota',
          provider: turn.agent,
          message: `${turn.agent === 'claude' ? 'Claude' : 'Codex'} reported ${Math.round((pressure.utilization ?? 0) * 100)}% provider utilization. The productive call and opponent handoff are preserved; Duo paused before another premium call.`,
          resumable: true,
          ...(pressure.resetAt ? { resetAt: pressure.resetAt } : {}),
          stage: turn.kind === 'pitch' || turn.kind === 'critique' || turn.kind === 'consensus' || turn.kind === 'tasking'
            ? 'dialogue'
            : 'work',
          action: 'Resume after the provider window resets. The next call starts from the compact Git and evidence baton, not replayed session history.'
        })
      }
      session.activeTurnIndex = index
      session.broadcastTick = 0
      session.snapshot.round = index + 1
      session.snapshot.phase = turn.phase
      if (session.quotaConstrainedAgents.has(turn.agent)) {
        await this.emitEvent(
          session,
          createDirectorEvent(
            session,
            'decision',
            `${turn.agent === 'claude' ? 'Claude' : 'Codex'} remains provider-limited, so this scheduled turn is skipped instead of spending another doomed call.`,
            {
              severity: 'high',
              topic: 'quota-turn-skipped',
              metadata: { agent: turn.agent, kind: turn.kind, phase: turn.phase }
            }
          )
        )
        session.snapshot.activeAgent = undefined
        session.snapshot.turnStage = undefined
        delete session.providerSessions[turn.agent]
        session.activeTurnIndex = Math.min(index + 1, turns.length)
        await this.persistRunState(session)
        continue
      }
      const stagedWork = turn.kind === 'code' || turn.kind === 'review' || turn.kind === 'verify' || turn.kind === 'repair'
      const restoredStage = resuming && index === startIndex ? session.resumeStage : undefined
      let continuationStage: TurnStageName | 'turn-complete' | undefined = restoredStage
      if (restoredStage === 'recovery') {
        const recoveryOrigin = session.resumeRecoveryOriginStage ?? (stagedWork ? 'work' : 'dialogue')
        const recovery = await this.executeTurnStage(
          session,
          git,
          turn,
          index + 1,
          'recovery',
          undefined,
          session.resumeRecoveryReasons ?? ['resume-contract-recovery'],
          recoveryOrigin
        )
        await this.resolveStageOutcome(session, git, turn, index + 1, 'recovery', recovery)
        session.resumeRecoveryOriginStage = undefined
        session.resumeRecoveryReasons = undefined
        await this.persistRunState(session)
        continuationStage = recoveryOrigin === 'opening'
          ? 'work'
          : recoveryOrigin === 'work'
            ? 'verdict'
            : 'turn-complete'
      }
      let providerSessionId: string | undefined
      if (stagedWork && session.planVersion === 'lean-collaboration-v2') {
        const opponentAgent = turn.agent === 'claude' ? 'codex' : 'claude'
        const opponentAlreadyContributed = session.acceptedCodeAgents.has(opponentAgent)
        const work = await this.executeTurnStage(session, git, turn, index + 1, 'work')
        if (this.remainingRunSeconds(session) <= 0) {
          await this.requireGitCheckpoint(
            session,
            git,
            `chore(duo): checkpoint lean round ${String(index + 1)} ${turn.agent} ${turn.kind} ceiling`,
            { stage: 'work', provider: turn.agent }
          )
          runCeilingReached = true
          break turnLoop
        }
        await this.resolveStageOutcome(session, git, turn, index + 1, 'work', work)
        const acceptedWork = !work.quotaRejected && work.assessment.outcome === 'accepted'
        if (
          (turn.kind === 'code' && (acceptedWork || work.durableSourceChanged)) ||
          (turn.kind === 'repair' && acceptedWork && work.durableSourceChanged)
        ) {
          session.acceptedCodeAgents.add(turn.agent)
        }
        const contributionReviewsOpponent = turn.kind === 'review' || turn.kind === 'repair' ||
          turn.kind === 'code' && opponentAlreadyContributed
        if (
          contributionReviewsOpponent && acceptedWork &&
          hasReciprocalReviewEvidence(session.stageEventLedger.since(0), turn.agent, index + 1)
        ) {
          session.acceptedReviewAgents.add(turn.agent)
        }
        const checkpoint = await this.requireGitCheckpoint(
          session,
          git,
          `chore(duo): checkpoint lean round ${String(index + 1)} ${turn.agent} ${turn.kind}${work.assessment.outcome === 'timeboxed' ? ' timeboxed' : ''}`,
          { stage: 'work', provider: turn.agent }
        )
        if (checkpoint.ok && checkpoint.commit) {
          await this.emitEvent(
            session,
            createDirectorEvent(
              session,
              'git.checkpoint',
              `Git checkpoint ${checkpoint.commit.slice(0, 7)} recorded after ${turn.agent}'s cohesive ${turn.kind} contribution.`
            )
          )
        }
      } else if (stagedWork) {
        if (continuationStage === 'work' || continuationStage === 'verdict') {
          providerSessionId = session.providerSessions[turn.agent]
        } else if (continuationStage !== 'turn-complete') {
          const opening = await this.executeTurnStage(session, git, turn, index + 1, 'opening')
          providerSessionId = opening.sessionId
          if (this.remainingRunSeconds(session) <= 0) {
            if (opening.durableSourceChanged) {
              await this.requireGitCheckpoint(
                session,
                git,
                `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind} opening ceiling`,
                { stage: 'opening', provider: turn.agent }
              )
            }
            runCeilingReached = true
            break turnLoop
          }
          await this.resolveStageOutcome(session, git, turn, index + 1, 'opening', opening)
          if (opening.durableSourceChanged) {
            // The short opening may legitimately get ahead of itself. Keep the
            // source, but still continue through the evidence-producing work
            // lease so a partial edit is never mistaken for a completed slice.
            continuationStage = 'work'
            const checkpoint = await this.requireGitCheckpoint(
              session,
              git,
              `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind} early work`,
              { stage: 'work', provider: turn.agent }
            )
            await this.emitEvent(
              session,
              createDirectorEvent(
                session,
                'decision',
                `${turn.agent === 'claude' ? 'Claude' : 'Codex'} moved from position into durable implementation early. The source is preserved; the deep-work lease now verifies or finishes that slice instead of assuming it is complete.`,
                {
                  severity: 'medium',
                  topic: 'early-work-preserved',
                  targetAgent: turn.agent,
                  metadata: {
                    agent: turn.agent,
                    kind: turn.kind,
                    ...(checkpoint.ok && checkpoint.commit ? { commit: checkpoint.commit } : {})
                  }
                }
              )
            )
          }
        }

        if (continuationStage !== 'verdict' && continuationStage !== 'turn-complete') {
          const work = await this.executeTurnStage(session, git, turn, index + 1, 'work', providerSessionId)
          providerSessionId = work.sessionId ?? providerSessionId
          if (this.remainingRunSeconds(session) <= 0) {
            await this.requireGitCheckpoint(
              session,
              git,
              `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind} ceiling`,
              { stage: 'work', provider: turn.agent }
            )
            runCeilingReached = true
            break turnLoop
          }
          await this.resolveStageOutcome(session, git, turn, index + 1, 'work', work)
          if (work.assessment.outcome === 'timeboxed') {
            providerSessionId = undefined
            delete session.providerSessions[turn.agent]
          }
          const acceptedWork = !work.quotaRejected && work.assessment.outcome === 'accepted'
          if (
            (turn.kind === 'code' && (acceptedWork || work.durableSourceChanged)) ||
            (turn.kind === 'repair' && acceptedWork && work.durableSourceChanged)
          ) {
            session.acceptedCodeAgents.add(turn.agent)
          }
          if (
            (turn.kind === 'review' || turn.kind === 'repair') &&
            acceptedWork &&
            hasReciprocalReviewEvidence(session.snapshot.events, turn.agent, index + 1)
          ) {
            session.acceptedReviewAgents.add(turn.agent)
          }
          const checkpoint = await this.requireGitCheckpoint(
            session,
            git,
            `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind}${work.assessment.outcome === 'timeboxed' ? ' timeboxed' : ''}`,
            { stage: 'verdict', provider: turn.agent }
          )
          if (checkpoint.ok && checkpoint.commit) {
            await this.emitEvent(
              session,
              createDirectorEvent(session, 'git.checkpoint', `Git checkpoint ${checkpoint.commit.slice(0, 7)} recorded after ${turn.agent}'s ${turn.kind} work lease.`)
            )
          }
          if (this.remainingRunSeconds(session) <= 0) {
            runCeilingReached = true
            break turnLoop
          }
        }

        if (continuationStage !== 'turn-complete') {
          const verdict = await this.executeTurnStage(session, git, turn, index + 1, 'verdict', providerSessionId)
          if (this.remainingRunSeconds(session) <= 0) {
            if (verdict.durableSourceChanged) {
              await this.requireGitCheckpoint(
                session,
                git,
                `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind} verdict ceiling`,
                { stage: 'verdict', provider: turn.agent }
              )
            }
            runCeilingReached = true
            break turnLoop
          }
          await this.resolveStageOutcome(session, git, turn, index + 1, 'verdict', verdict)
        }
      } else if (continuationStage !== 'turn-complete') {
        const dialogue = await this.executeTurnStage(session, git, turn, index + 1, 'dialogue')
        if (this.remainingRunSeconds(session) <= 0) {
          runCeilingReached = true
          break turnLoop
        }
        await this.resolveStageOutcome(session, git, turn, index + 1, 'dialogue', dialogue)
      }

      session.snapshot.activeAgent = undefined
      session.snapshot.turnStage = undefined
      if (index === startIndex) session.resumeStage = undefined
      delete session.providerSessions[turn.agent]
      session.activeTurnIndex = Math.min(index + 1, turns.length)
      // Commit the completed logical-turn boundary before any director-only
      // redaction, early-stop, or reveal work. Provider sessions are scoped to a
      // single staged turn; the next scheduled turn starts from the compact
      // durable board + private baton instead of replaying a growing transcript.
      await this.persistRunState(session)
      if (turn.phase === 'round.consensus') await this.loadRedactionDictionary(session)
      const balancedPairComplete = (index + 1) % 2 === 0
      const eligibleForEarlyStop = session.planVersion === 'lean-collaboration-v2'
        ? index >= 6
        : index >= 7 && balancedPairComplete
      if (eligibleForEarlyStop && await this.readyForEarlyStop(session)) {
        session.snapshot.totalTurns = index + 1
        break
      }
    }

    if (!this.runIsActive(session)) return
    if (runCeilingReached) {
      await this.emitEvent(
        session,
        createDirectorEvent(session, 'decision', 'The overall run ceiling was reached. Durable work is preserved and the best available reveal packet will be prepared.', {
          severity: 'high', topic: 'run-ceiling', metadata: { runTimeoutSeconds: session.request.runTimeoutSeconds }
        })
      )
      if (!this.runIsActive(session)) return
    }

    if (
      this.hasDuoQualityEvidence(session) &&
      await this.seriousMissionContractSatisfied(session)
    ) {
      await this.verifyCurrentRevision(session)
    }
    const packet = await this.readRevealPacket(session)
    if (!this.runIsActive(session)) return
    session.privateRevealPacket = packet
    session.redactionTerms = buildRedactionTerms([
      ...SIMULATION_REDACTIONS.filter(() => false),
      { value: packet.appName, label: 'APP_NAME' },
      ...packet.features.map((value) => ({ value, label: 'FEATURE' }))
    ])
    await safeWriteProtocolText(
      session.workspace.duoPath,
      join(session.workspace.duoPath, 'sealed', 'reveal_packet.json'),
      `${JSON.stringify(packet, null, 2)}\n`
    )
    if (!this.runIsActive(session)) return
    const readinessText = packet.status === 'ready'
      ? 'Build fully complete and ready for reveal.'
      : packet.status === 'partial'
        ? 'The run reached reveal with documented caveats.'
        : 'The run stopped before full completion; diagnostics are ready to inspect.'
    await this.requireGitCheckpoint(session, git, 'chore(duo): reveal ready')
    await this.emitEvent(
      session,
      createDirectorEvent(session, 'reveal.ready', readinessText, {
        severity: packet.status === 'ready' ? 'high' : 'medium', spoilerRisk: 1, status: packet.status, revealPacket: packet
      })
    )
  }

  private runIsActive(session: RunSession): boolean {
    return !session.controller.signal.aborted && session.snapshot.status === 'running'
  }

  private remainingRunSeconds(session: RunSession): number {
    return Math.max(0, Math.floor((session.runDeadlineMs - this.nowMs()) / 1_000))
  }

  private stagePolicy(session: RunSession): TurnBudgetPolicy {
    return {
      dialogueSeconds: 600,
      workLeaseSeconds: session.request.turnTimeoutSeconds,
      verdictSeconds: 180,
      recoverySeconds: 120,
      runTimeoutSeconds: session.request.runTimeoutSeconds
    }
  }

  private stageEffort(session: RunSession, turn: RealTurn, stage: TurnStageName): AgentEffort | CodexEffort {
    if (stage === 'opening' || stage === 'verdict' || stage === 'recovery') return 'low'
    const selected = turn.agent === 'codex' ? session.settings.codexEffort : session.settings.claudeEffort
    if (stage === 'dialogue') {
      return capStageEffort(selected, turn.phase === 'round.consensus' || turn.kind === 'consensus' ? 'high' : 'medium')
    }
    if (turn.kind === 'review') return capStageEffort(selected, 'high')
    if (turn.kind === 'verify') return capStageEffort(selected, 'low')
    return selected
  }

  private async executeTurnStage(
    session: RunSession,
    git: GitManager,
    turn: RealTurn,
    round: number,
    stage: TurnStageName,
    resumeSessionId?: string,
    recoveryReasons: string[] = [],
    recoveryOriginStage?: TurnStageName
  ): Promise<ExecutedTurnStage> {
    const budgetSeconds = resolveStageBudgetSeconds(stage, this.stagePolicy(session), this.remainingRunSeconds(session))
    if (budgetSeconds <= 0) throw new Error('The overall run ceiling was reached before the next agent stage could start.')

    const opponent = [...session.snapshot.events].reverse().find((event) =>
      event.type === 'agent.dispatch' && event.agent !== turn.agent && (event.agent === 'claude' || event.agent === 'codex')
    )
    const privateOpponent = session.lastPrivateDialogue?.agent !== turn.agent
      ? session.lastPrivateDialogue
      : undefined
    const structuredDialogueStage = stage === 'dialogue' || stage === 'recovery' && recoveryOriginStage === 'dialogue'
    const durablePrivateHandoff = await this.readLatestPrivateOpponentHandoff(session, turn.agent)
    const stagedPrivateHandoff = structuredDialogueStage ? undefined : durablePrivateHandoff
    const currentStagedHandoff = stagedPrivateHandoff && (!opponent || stagedPrivateHandoff.round >= opponent.round)
      ? stagedPrivateHandoff
      : undefined
    const inMemoryPrivateIsCurrent = Boolean(
      privateOpponent && (!opponent || privateOpponent.round >= opponent.round)
    )
    const latestStatement = structuredDialogueStage
      ? privateOpponent
        ? privateOpponent.text
        : durablePrivateHandoff
          ? `${durablePrivateHandoff.id}: "${durablePrivateHandoff.text}"`
          : opponent
            ? `${opponent.id}: "${opponent.publicText}"`
            : 'No teammate statement has been accepted yet. Open with a concrete position.'
      : currentStagedHandoff
        ? `${currentStagedHandoff.id}: "${currentStagedHandoff.text}"`
        : inMemoryPrivateIsCurrent && privateOpponent
          ? privateOpponent.text
          : opponent
            ? `${opponent.id}: "${opponent.publicText}"`
            : durablePrivateHandoff
              ? `${durablePrivateHandoff.id}: "${durablePrivateHandoff.text}"`
              : 'No teammate statement has been accepted yet. Open with a concrete position.'
    const latestStatementId = structuredDialogueStage
      ? privateOpponent
        ? opponent?.id ?? durablePrivateHandoff?.id
        : durablePrivateHandoff?.id ?? opponent?.id
      : currentStagedHandoff?.id ??
        (inMemoryPrivateIsCurrent ? opponent?.id ?? durablePrivateHandoff?.id : opponent?.id ?? durablePrivateHandoff?.id)
    const quotaHandoffFrom = [...session.quotaConstrainedAgents].find((agent) => agent !== turn.agent)
    const leanContribution = session.planVersion === 'lean-collaboration-v2' && stage === 'work'
    const prompt = composeTurnStagePrompt({
      runId: session.snapshot.runId,
      round,
      turn,
      stage,
      humanBrief: session.request.prompt,
      missionProfile: session.request.missionProfile ?? 'surprise',
      latestStatement,
      ...(latestStatementId ? { latestStatementId } : {}),
      board: session.snapshot.tasks.slice(0, 6).map((task) =>
        `${task.id}: ${task.publicTitle} [${task.status}; ${task.claimedBy ?? 'unclaimed'}]`
      ).join('\n') || 'No tasks yet.',
      finalTurn: Boolean(turn.revealCandidate || turn.kind === 'repair' || round === session.turnPlan.length),
      ...(leanContribution ? { leanContribution: true } : {}),
      recoveryReasons,
      ...(quotaHandoffFrom ? { quotaHandoffFrom } : {}),
      ...(recoveryOriginStage ? { recoveryOriginStage } : {})
    })
    await writeFile(join(session.workspace.runtimePath, 'prompts', `current_${turn.agent}_prompt.md`), prompt, 'utf8')

    const structuredDialogue = stage === 'dialogue' || stage === 'recovery' && recoveryOriginStage === 'dialogue'
    const stagedRecoveryOrigin: RecoveryOriginStage | undefined = recoveryOriginStage === 'opening' ||
      recoveryOriginStage === 'work' || recoveryOriginStage === 'verdict'
      ? recoveryOriginStage
      : undefined
    const structuredRecovery = stage === 'recovery' && stagedRecoveryOrigin !== undefined
    const structuredOutput = structuredDialogue || structuredRecovery
    const requiresRecoveryOpinion = recoveryReasons.includes('missing-opinion')
    const outputSchemaPath = join(
      session.workspace.runtimePath,
      'prompts',
      structuredRecovery ? 'recovery-capsule.schema.json' : 'dialogue-capsule.schema.json'
    )
    const structuredOutputSchema = structuredRecovery
      ? recoveryCapsuleJsonSchema(requiresRecoveryOpinion)
      : structuredDialogue
        ? dialogueCapsuleJsonSchemaForTurn({ kind: turn.kind, phase: turn.phase })
        : DIALOGUE_CAPSULE_JSON_SCHEMA
    if (structuredOutput) {
      await writeFile(outputSchemaPath, `${JSON.stringify(structuredOutputSchema, null, 2)}\n`, 'utf8')
    }

    let sessionId = resumeSessionId
    let commandSession: { mode: 'start'; id?: string } | { mode: 'resume'; id: string } | undefined
    const durableProviderSession = !structuredOutput ? session.providerSessions[turn.agent] : undefined
    if (leanContribution) {
      commandSession = undefined
      sessionId = undefined
      delete session.providerSessions[turn.agent]
    } else if (stage === 'opening' && durableProviderSession) {
      sessionId = durableProviderSession
      commandSession = { mode: 'resume', id: durableProviderSession }
    } else if (stage === 'opening' || stage === 'work' && !resumeSessionId) {
      const requestedId = turn.agent === 'claude' ? randomUUID() : undefined
      sessionId = requestedId
      commandSession = requestedId ? { mode: 'start', id: requestedId } : { mode: 'start' }
      if (requestedId) session.providerSessions[turn.agent] = requestedId
    } else if ((stage === 'work' || stage === 'verdict') && resumeSessionId) {
      commandSession = { mode: 'resume', id: resumeSessionId }
    }

    const effort = this.stageEffort(session, turn, stage)
    const buildCommand = (
      selectedSession: { mode: 'start'; id?: string } | { mode: 'resume'; id: string } | undefined
    ) => turn.agent === 'codex'
      ? buildAgentCommand({
          agent: 'codex',
          binary: session.settings.codexPath,
          model: session.settings.codexModel,
          effort,
          extraArgs: session.settings.codexExtraArgs,
          executionMode: session.request.executionMode as 'safe' | 'chaos' | 'yolo-sandbox',
          workspacePath: session.workspace.workspacePath,
          prompt,
          dangerousModeConfirmed: session.request.dangerousModeConfirmed,
          ...(structuredOutput
            ? {
                dialoguePolicy: {
                  kind: structuredRecovery ? 'structured-recovery' as const : 'structured-dialogue' as const,
                  outputSchema: structuredOutputSchema,
                  outputSchemaPath,
                  toolPolicy: 'none' as const
                }
              }
            : {}),
          ...(leanContribution
            ? { sourcePolicy: { toolPolicy: 'workspace-essential' as const } }
            : {}),
          ...(selectedSession ? { session: selectedSession } : {})
        })
      : buildAgentCommand({
          agent: 'claude',
          binary: session.settings.claudePath,
          model: session.settings.claudeModel,
          effort: effort as AgentEffort,
          extraArgs: session.settings.claudeExtraArgs,
          executionMode: session.request.executionMode as 'safe' | 'chaos' | 'yolo-sandbox',
          workspacePath: session.workspace.workspacePath,
          prompt,
          dangerousModeConfirmed: session.request.dangerousModeConfirmed,
          ...(structuredOutput
            ? {
                dialoguePolicy: {
                  kind: structuredRecovery ? 'structured-recovery' as const : 'structured-dialogue' as const,
                  outputSchema: structuredOutputSchema,
                  outputSchemaPath,
                  toolPolicy: 'none' as const
                }
              }
            : {}),
          ...(leanContribution
            ? { sourcePolicy: { toolPolicy: 'workspace-essential' as const } }
            : {}),
          ...(selectedSession ? { session: selectedSession } : {})
        })
    let command = buildCommand(commandSession)

    const startedAt = new Date()
    const nextAgent = session.turnPlan[session.activeTurnIndex + 1]?.agent
    const priorStageReceipt = session.snapshot.turnStage
    const sameStageReceipt = priorStageReceipt?.turnId === turn.id && priorStageReceipt.stage === stage
      ? priorStageReceipt
      : undefined
    session.snapshot.turnStage = {
      turnId: turn.id,
      agent: turn.agent,
      kind: turn.kind,
      stage,
      status: 'running',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + budgetSeconds * 1_000).toISOString(),
      attempt: 1,
      effort,
      ...(nextAgent ? { nextAgent } : {}),
      ...(sameStageReceipt?.durableWorkEvidence
        ? {
            durableWorkEvidence: true,
            ...(sameStageReceipt.evidenceFingerprint
              ? { evidenceFingerprint: sameStageReceipt.evidenceFingerprint }
              : {})
          }
        : {})
    }
    session.snapshot.activeAgent = turn.agent
    const agentName = turn.agent === 'claude' ? 'Claude' : 'Codex'
    const stageStart = session.stageEventLedger.cursor()
    if (stage === 'dialogue' || stage === 'opening' || leanContribution) {
      await this.emitEvent(
        session,
        createDirectorEvent(session, 'agent.started', `${agentName} opened a ${turn.kind} broadcast turn.`, {
          agent: turn.agent,
          topic: turn.kind,
          metadata: { phase: turn.phase, kind: turn.kind, stage, budgetSeconds }
        })
      )
    } else {
      const stageText = stage === 'work'
        ? `${agentName} entered a deep work lease. Real workspace evidence will stay live while the other agent waits on deck.`
        : stage === 'verdict'
          ? `${agentName} is filing the verdict and direct handoff.`
          : `${agentName} entered contract-only recovery; implementation will not be repeated.`
      await this.emitEvent(session, createDirectorEvent(session, 'decision', stageText, {
        severity: stage === 'recovery' ? 'high' : 'low',
        topic: `turn-${stage}`,
        metadata: { phase: turn.phase, kind: turn.kind, stage, budgetSeconds }
      }))
    }

    const activityBudget = new VisibleActivityBudget()
    const protocolTimer = setInterval(() => this.enqueueProtocolSync(session), this.protocolPollMs)
    const appStateBefore = await git.appStateFingerprint(session.workspace.workspacePath)
    const stageStartedMs = this.nowMs()
    let quotaRejected = false
    let quotaRateLimitType: string | undefined
    let quotaResetAt: string | undefined
    let dialogueCapsule: DialogueCapsule | undefined
    let recoveryCapsule: RecoveryCapsule | undefined
    let structuredToolActivity = false
    const cliActivityState: CliActivityState = { pendingClaudeVerificationToolUses: new Set() }
    let stageLineSequence = 0
    let lastRecordedFileSequence: number | undefined
    let successfulWorkspaceCommand = false
    let lastVerificationOutcome: { sequence: number; outcome: 'passed' | 'failed' } | undefined
    const stageProviderRecords: ProviderRecord[] = []
    const stageProviderText: string[] = []
    const undecodedStdoutText: string[] = []
    const stdoutFragments: string[] = []
    let stdoutFragmentBytes = 0
    let reassembledProviderEnvelope = false
    const onLine = (stream: 'stdout' | 'stderr', line: string): void => {
      const lineSequence = stageLineSequence
      stageLineSequence += 1
      if (stream === 'stdout' && stdoutFragmentBytes < 8_000_000) {
        const remaining = 8_000_000 - stdoutFragmentBytes
        const fragment = line.slice(0, remaining)
        stdoutFragments.push(fragment)
        stdoutFragmentBytes += Buffer.byteLength(fragment, 'utf8')
      }
      const decoded = decodeProviderEnvelope(line)
      if (stageProviderRecords.length < 256) {
        stageProviderRecords.push(...decoded.slice(0, 256 - stageProviderRecords.length))
      }
      if (decoded.length === 0) {
        const target = stream === 'stdout' ? undecodedStdoutText : stageProviderText
        if (target.length < 256) target.push(line.slice(0, 2_000))
      }
      const discovered = extractAgentSessionId(turn.agent, line)
      if (discovered && !structuredOutput) {
        sessionId = discovered
        session.providerSessions[turn.agent] = discovered
        void this.persistRunState(session).catch(() => undefined)
      }
      const quota = parseCliQuotaSignal(line)
      if (quota?.status === 'allowed_warning') {
        session.providerPressure[turn.agent] = quota
      }
      if (quota?.status === 'rejected') {
        quotaRejected = true
        quotaRateLimitType = quota.rateLimitType
        quotaResetAt = quota.resetAt
      }
      const extractedCapsule = structuredDialogue
        ? extractDialogueCapsuleFromCliLine(turn.agent, line)
        : undefined
      if (extractedCapsule) dialogueCapsule = extractedCapsule
      const extractedRecoveryCapsule = structuredRecovery
        ? extractRecoveryCapsuleFromCliLine(turn.agent, line)
        : undefined
      if (extractedRecoveryCapsule) recoveryCapsule = extractedRecoveryCapsule
      if (session.usageTracker.ingest(turn.agent, line, stream === 'stdout')) this.publishSnapshot(session)
      const context = { runId: session.snapshot.runId, round, source: turn.agent, stream }
      const log = normalizeCliLine(line, context)
      if (activityBudget.accept(log)) this.enqueueEvent(session, log)
      const activity = normalizeCliActivity(line, context, cliActivityState)
      if (activity?.category === 'file') lastRecordedFileSequence = lineSequence
      if (activity?.metadata?.commandCompleted === true) successfulWorkspaceCommand = true
      if (activity?.metadata?.verificationPassed === true) {
        lastVerificationOutcome = { sequence: lineSequence, outcome: 'passed' }
      } else if (activity?.metadata?.verificationFailed === true) {
        lastVerificationOutcome = { sequence: lineSequence, outcome: 'failed' }
      }
      if (structuredOutput && (activity?.category === 'command' || activity?.category === 'file')) {
        structuredToolActivity = true
      }
      if (activity && activityBudget.accept(activity)) this.enqueueEvent(session, activity)
    }
    const runProcess = (suffix: string, timeoutSeconds: number): Promise<ProcessRunResult> => this.processRunner.run({
      id: `${session.snapshot.runId}-${turn.id}-${stage}${suffix}`,
      command,
      timeoutMs: timeoutSeconds * 1_000,
      stdoutPath: session.settings.saveRawLogs
        ? join(session.workspace.runtimePath, 'private', 'raw', `${turn.agent}.jsonl`)
        : process.platform === 'win32' ? 'NUL' : '/dev/null',
      stderrPath: session.settings.saveRawLogs
        ? join(session.workspace.runtimePath, 'private', 'raw', `${turn.agent}.stderr.log`)
        : process.platform === 'win32' ? 'NUL' : '/dev/null',
      onLine
    })
    const reassembleBufferedEnvelope = (): void => {
      if (stageProviderRecords.length !== 0 || stdoutFragments.length <= 1) return
      const replayEnvelope = stdoutFragments.join('\n')
      const replayRecords = decodeProviderEnvelope(replayEnvelope)
      if (replayRecords.length === 0) return
      reassembledProviderEnvelope = true
      stageProviderRecords.push(...replayRecords.slice(0, 256))
      const replaySession = extractAgentSessionId(turn.agent, replayEnvelope)
      if (replaySession && !structuredOutput) {
        sessionId = replaySession
        session.providerSessions[turn.agent] = replaySession
        void this.persistRunState(session).catch(() => undefined)
      }
      const replayQuota = parseCliQuotaSignal(replayEnvelope)
      if (replayQuota?.status === 'rejected') {
        quotaRejected = true
        quotaRateLimitType = replayQuota.rateLimitType
        quotaResetAt = replayQuota.resetAt
      }
      if (structuredDialogue && !dialogueCapsule) {
        dialogueCapsule = extractDialogueCapsuleFromCliLine(turn.agent, replayEnvelope)
      }
      if (structuredRecovery && !recoveryCapsule) {
        recoveryCapsule = extractRecoveryCapsuleFromCliLine(turn.agent, replayEnvelope)
      }
      if (session.usageTracker.ingest(turn.agent, replayEnvelope, true)) this.publishSnapshot(session)
    }
    const clearFailedResumeEvidence = (): void => {
      stageProviderRecords.length = 0
      stageProviderText.length = 0
      undecodedStdoutText.length = 0
      stdoutFragments.length = 0
      stdoutFragmentBytes = 0
      reassembledProviderEnvelope = false
      quotaRejected = false
      quotaRateLimitType = undefined
      quotaResetAt = undefined
      dialogueCapsule = undefined
      recoveryCapsule = undefined
      structuredToolActivity = false
    }
    let result: ProcessRunResult
    try {
      try {
        result = await runProcess('', budgetSeconds)
      } catch (error) {
        if (commandSession?.mode !== 'resume') throw error
        if (error instanceof Error) stageProviderText.push(error.message.slice(0, 2_000))
        const now = new Date().toISOString()
        result = { exitCode: 1, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
      }
      reassembleBufferedEnvelope()
      const resumeFailure = commandSession?.mode === 'resume'
        ? classifyProviderFailure({
            agent: turn.agent,
            result,
            records: stageProviderRecords,
            text: reassembledProviderEnvelope
              ? stageProviderText
              : [...stageProviderText, ...undecodedStdoutText]
          })
        : undefined
      if (resumeFailure?.kind === 'session-lost') {
        const elapsedSeconds = Math.max(0, Math.floor((this.nowMs() - stageStartedMs) / 1_000))
        const fallbackSeconds = Math.min(
          Math.max(0, budgetSeconds - elapsedSeconds),
          this.remainingRunSeconds(session)
        )
        if (fallbackSeconds > 0) {
          await this.emitEvent(session, createDirectorEvent(
            session,
            'decision',
            `${agentName}'s exact provider session could not resume. One fresh bounded session is taking over the same stage without resetting its lease.`,
            { severity: 'medium', topic: 'session-fallback', metadata: { stage, fallbackSeconds } }
          ))
          const freshId = turn.agent === 'claude' ? randomUUID() : undefined
          clearFailedResumeEvidence()
          sessionId = freshId
          commandSession = freshId ? { mode: 'start', id: freshId } : { mode: 'start' }
          if (freshId) session.providerSessions[turn.agent] = freshId
          command = buildCommand(commandSession)
          if (session.snapshot.turnStage) {
            session.snapshot.turnStage = { ...session.snapshot.turnStage, attempt: 2 }
            this.publishSnapshot(session)
          }
          result = await runProcess('-fresh', fallbackSeconds)
          reassembleBufferedEnvelope()
        }
      }
    } finally {
      clearInterval(protocolTimer)
    }
    const providerFailure = classifyProviderFailure({
      agent: turn.agent,
      result,
      records: stageProviderRecords,
      text: reassembledProviderEnvelope
        ? stageProviderText
        : [...stageProviderText, ...undecodedStdoutText]
    })
    let rejectedDialogueContract = false
    let rejectedRecoveryContract = false
    if (structuredDialogue && dialogueCapsule) {
      try {
        if (structuredToolActivity) {
          throw new DialogueCapsuleError('Structured dialogue attempted workspace tool activity.')
        }
        const proposedTaskOwners = dialogueCapsule.tasks.map((task) => task.claimedBy)
        const validatedCapsule = validateDialogueCapsuleForTurn(dialogueCapsule, {
          kind: turn.kind,
          phase: turn.phase
        })
        await writeDialogueCapsuleProtocol({
          workspacePath: session.workspace.workspacePath,
          runId: session.snapshot.runId,
          round,
          agent: turn.agent,
          targetAgent: turn.agent === 'claude' ? 'codex' : 'claude',
          claimKey: 'shared-direction',
          contract: { kind: turn.kind, phase: turn.phase },
          missionProfile: session.request.missionProfile ?? 'surprise',
          humanBrief: session.request.prompt,
          ...(opponent ? { replyTo: opponent.id } : {}),
          capsule: validatedCapsule
        })
        if ((session.request.missionProfile ?? 'surprise') === 'serious' && validatedCapsule.consensus) {
          await sealSeriousMissionGuard(
            session.workspace.runtimePath,
            join(session.workspace.duoPath, 'sealed'),
            session.request.prompt
          )
        }
        if (
          turn.phase === 'round.consensus' &&
          validatedCapsule.tasks.some((task, index) => task.claimedBy !== proposedTaskOwners[index])
        ) {
          await this.emitEvent(
            session,
            createDirectorEvent(
              session,
              'decision',
              'The consensus used ambiguous task ownership. The director preserved both task scopes and assigned one source mission to each agent.',
              {
                severity: 'medium',
                topic: 'task-ownership-balanced',
                metadata: { proposedTaskOwners, assignedTaskOwners: validatedCapsule.tasks.map((task) => task.claimedBy) }
              }
            )
          )
        }
        session.lastPrivateDialogue = {
          agent: turn.agent,
          round,
          text: privateDialogueContext(
            turn.agent,
            validatedCapsule,
            { kind: turn.kind, phase: turn.phase },
            opponent?.id
          )
        }
      } catch (error) {
        if (!(error instanceof DialogueCapsuleError)) throw error
        rejectedDialogueContract = true
        dialogueCapsule = undefined
      }
    }
    if (structuredRecovery && stagedRecoveryOrigin && recoveryCapsule) {
      try {
        if (structuredToolActivity) {
          throw new RecoveryCapsuleError('Structured recovery attempted workspace tool activity.')
        }
        await writeRecoveryCapsuleProtocol({
          workspacePath: session.workspace.workspacePath,
          runId: session.snapshot.runId,
          round,
          agent: turn.agent,
          targetAgent: turn.agent === 'claude' ? 'codex' : 'claude',
          originStage: stagedRecoveryOrigin,
          ...(latestStatementId ? { replyTo: latestStatementId } : {}),
          requireOpinion: requiresRecoveryOpinion,
          capsule: recoveryCapsule
        })
      } catch (error) {
        if (!(error instanceof RecoveryCapsuleError)) throw error
        rejectedRecoveryContract = true
        recoveryCapsule = undefined
      }
    }
    this.enqueueProtocolSync(session)
    await session.eventQueue
    // A timer may have read a JSONL file while the agent was still appending its final line.
    // Perform one deterministic post-process read so acceptance never depends on poll timing.
    await this.ingestProtocolState(session)
    if (rejectedDialogueContract) {
      await this.emitEvent(
        session,
        createDirectorEvent(
          session,
          'decision',
          `${agentName}'s structured exchange failed the privacy or turn contract. One narrow tool-free correction is required.`,
          { severity: 'high', topic: 'dialogue-contract-rejected', metadata: { stage, kind: turn.kind } }
        )
      )
    }
    if (rejectedRecoveryContract) {
      await this.emitEvent(
        session,
        createDirectorEvent(
          session,
          'decision',
          `${agentName}'s recovery response failed the bounded collaboration contract. No workspace tool or source edit was accepted.`,
          { severity: 'high', topic: 'recovery-contract-rejected', metadata: { stage, kind: turn.kind } }
        )
      )
    }
    if (quotaRejected) {
      session.quotaConstrainedAgents.add(turn.agent)
      await this.releaseQuotaClaims(session, turn.agent)
      await this.ingestProtocolState(session)
      await this.emitEvent(
        session,
        createDirectorEvent(
          session,
          'decision',
          `${agentName} reached a provider quota boundary. No wasteful fresh retry or solo takeover will run; the balanced battle is being suspended with durable work preserved.`,
          {
            severity: 'high',
            topic: 'quota-suspend',
            metadata: {
              stage,
              agent: turn.agent,
              ...(quotaRateLimitType ? { rateLimitType: quotaRateLimitType } : {}),
              ...(quotaResetAt ? { resetAt: quotaResetAt } : {})
            }
          }
        )
      )
    }
    if (session.controller.signal.aborted) {
      return {
        assessment: { accepted: false, outcome: 'fatal', reasons: ['process-cancelled'] },
        durableSourceChanged: false,
        ...(sessionId ? { sessionId } : {}),
        ...(quotaRejected ? { quotaRejected: true } : {}),
        ...(quotaResetAt ? { quotaResetAt } : {}),
        ...(providerFailure ? { failure: providerFailure } : {})
      }
    }

    const stageEvents = session.stageEventLedger.since(stageStart)
    const appStateAfter = await git.appStateFingerprint(session.workspace.workspacePath)
    const observedFileChange = stageEvents.some((event) =>
      event.agent === turn.agent && event.round === round &&
      (event.type === 'file.changed' || event.type === 'agent.activity' && event.category === 'file')
    )
    const durableSourceChanged = appStateBefore !== undefined && appStateAfter !== undefined
      ? appStateBefore !== appStateAfter
      : observedFileChange
    const latestStageVerification = latestVerificationEvidence(stageEvents)
    // Agent-authored build failures are conservative blockers. Their file
    // polling order can race the streamed verifier event queue, so a failure
    // in this stage is never allowed to be overwritten by that ambiguity.
    const protocolBuildFailed = stageEvents.some((event) => event.type === 'build.failed')
    if (latestStageVerification || protocolBuildFailed) {
      session.supervisorVerificationAttempt = undefined
    }
    if (durableSourceChanged) session.appEvidenceRevision += 1
    if (latestStageVerification?.outcome === 'failed' || protocolBuildFailed) session.verifiedAppEvidenceRevision = -1
    // Provider-reported command outcomes remain useful repair evidence, but
    // only the independent supervisor verifier may certify a source revision.
    const preservedOpeningSource = stage === 'work' && hasPreservedOpeningSource(
      session.snapshot.events,
      turn.agent,
      round
    )
    // A short opening can legitimately finish the source slice before the
    // deep lease begins. The lease still gives the same agent a bounded chance
    // to inspect, verify, or refine it; a review-only continuation must not
    // suspend an otherwise durable turn just because no second edit was needed.
    const streamedVerificationForRevision = lastVerificationOutcome?.outcome === 'passed' &&
      (!durableSourceChanged || lastRecordedFileSequence !== undefined &&
        lastVerificationOutcome.sequence > lastRecordedFileSequence)
      ? 'passed'
      : lastVerificationOutcome?.outcome
    const durableWorkEvidence = reusableDurableWorkEvidence(
      priorStageReceipt,
      turn.id,
      stage,
      appStateAfter
    ) || hasDurableWorkEvidence({
      durableSourceChanged,
      preservedOpeningSource,
      queuedVerification: latestStageVerification?.outcome,
      streamedVerification: streamedVerificationForRevision,
      successfulWorkspaceCommand,
      protocolBuildFailed
    })
    if (durableWorkEvidence && appStateAfter && session.snapshot.turnStage) {
      session.snapshot.turnStage = {
        ...session.snapshot.turnStage,
        durableWorkEvidence: true,
        evidenceFingerprint: appStateAfter
      }
    }
    const opponentAgent = turn.agent === 'claude' ? 'codex' : 'claude'
    const opponentHasAcceptedContribution = session.acceptedCodeAgents.has(opponentAgent)
    const acceptanceResult = providerFailure?.kind === 'contract-invalid'
      ? { ...result, exitCode: 0, signal: null, timedOut: false, cancelled: false }
      : result
    const assessment = quotaRejected
      ? { accepted: false, outcome: 'timeboxed' as const, reasons: ['provider-quota-rejected'] }
      : assessTurnAcceptance({
      agent: turn.agent,
      round,
      stage,
      result: acceptanceResult,
      events: stageEvents,
      // Structured dialogue needs both the direct handoff and opinion capsule.
      // Staged work/verdict recovery already carries durable review evidence;
      // requiring a duplicate opinion there can trap a finished build in an
      // expensive contract-only recovery loop.
      requiresOpinion: structuredDialogue,
      requiresSourceChange: stage === 'work' &&
        contributionNeedsFreshSource(turn.kind, opponentHasAcceptedContribution) &&
        !hasPreservedOpeningSource(session.snapshot.events, turn.agent, round),
      // Review turns are allowed to conclude that the accepted source should
      // remain unchanged. Their handoff/verification quality is enforced by
      // the reciprocal-review and final release gates; only source-producing
      // code/repair leases must prove fresh durable work here.
      requiresWorkEvidence: stage === 'work' && (turn.kind === 'code' || turn.kind === 'repair'),
      durableSourceChanged,
      durableWorkEvidence,
      // Some providers continue directly from their short position into useful
      // implementation. Preserve that evidence and let the turn loop skip the
      // duplicate work lease instead of suspending a healthy run.
      forbidsSourceChange: stage === 'dialogue' || stage === 'verdict' || stage === 'recovery'
      })
    session.snapshot.turnStage = {
      ...session.snapshot.turnStage,
      status: assessment.outcome === 'timeboxed' ? 'timeboxed' : 'completed'
    }
    this.publishSnapshot(session)
    if (assessment.outcome === 'timeboxed') {
      await this.emitEvent(
        session,
        createDirectorEvent(session, 'decision', stage === 'work'
          ? `${agentName}'s work lease was timeboxed. Durable work was preserved; ${nextAgent === 'claude' ? 'Claude' : nextAgent === 'codex' ? 'Codex' : 'the next agent'} takes the counter.`
          : `${agentName}'s ${stage} window closed after its real position was recorded. The run advances without repeating the expensive stage.`, {
          severity: 'high',
          topic: 'turn-timeboxed',
          metadata: { stage, reasons: assessment.reasons, durableSourceChanged }
        })
      )
    }
    return {
      assessment,
      durableSourceChanged,
      ...(sessionId ? { sessionId } : {}),
      ...(quotaRejected ? { quotaRejected: true } : {}),
      ...(quotaResetAt ? { quotaResetAt } : {}),
      ...(providerFailure ? { failure: providerFailure } : {})
    }
  }

  private async resolveStageOutcome(
    session: RunSession,
    git: GitManager,
    turn: RealTurn,
    round: number,
    stage: TurnStageName,
    executed: ExecutedTurnStage
  ): Promise<void> {
    if (executed.failure?.kind === 'safety-violation' || executed.failure?.kind === 'workspace-drift') {
      throw new RunTerminalError(
        `${turn.agent === 'claude' ? 'Claude' : 'Codex'} reported ${executed.failure.kind}. The supervisor stopped before allowing unsafe or mismatched workspace changes.`,
        executed.failure.kind
      )
    }
    const boundaryNeedsCheckpoint = executed.durableSourceChanged && (
      executed.quotaRejected ||
      executed.failure !== undefined ||
      (executed.assessment.outcome !== 'accepted' && executed.assessment.outcome !== 'timeboxed')
    )
    const boundaryCheckpoint = boundaryNeedsCheckpoint
      ? await this.requireGitCheckpoint(
          session,
          git,
          `chore(duo): checkpoint round ${String(round)} ${turn.agent} ${turn.kind} preserved ${stage}`,
          { stage: stage === 'opening' ? 'work' : stage, provider: turn.agent }
        )
      : undefined
    if (executed.quotaRejected) {
      const agentName = turn.agent === 'claude' ? 'Claude' : 'Codex'
      const resumeStage: TurnStageName = stage === 'opening' && executed.durableSourceChanged ? 'work' : stage
      if (stage === 'opening' && executed.durableSourceChanged) {
        if (session.snapshot.turnStage) {
          session.snapshot.turnStage = {
            ...session.snapshot.turnStage,
            stage: 'work',
            status: 'running'
          }
        }
        await this.emitEvent(
          session,
          createDirectorEvent(
            session,
            'decision',
            `${agentName} wrote durable source before the provider boundary. It is checkpointed, and Resume will continue with the evidence-producing work lease rather than replaying the opening.`,
            {
              severity: 'high',
              topic: 'early-work-preserved',
              targetAgent: turn.agent,
              metadata: {
                agent: turn.agent,
                kind: turn.kind,
                quotaBoundary: true,
                ...(boundaryCheckpoint?.ok && boundaryCheckpoint.commit ? { commit: boundaryCheckpoint.commit } : {})
              }
            }
          )
        )
      }
      throw new RunPauseError({
        reason: 'provider-quota',
        provider: turn.agent,
        message: `${agentName} reached a provider usage boundary. The balanced battle is suspended with every durable file and event preserved.`,
        ...(executed.quotaResetAt ? { resetAt: executed.quotaResetAt } : {}),
        resumable: true,
        stage: resumeStage,
        action: executed.quotaResetAt
          ? 'Resume after the provider reset; the same turn will continue before the opponent moves.'
          : 'Resume when provider usage is available again; the same turn will continue before the opponent moves.'
      })
    }
    const recoverableFailureReason: Partial<Record<ProviderFailureClassification['kind'], RunPauseSnapshot['reason']>> = {
      quota: 'provider-quota',
      auth: 'provider-auth',
      'provider-unavailable': 'provider-unavailable',
      'model-unavailable': 'model-unavailable',
      'cli-incompatible': 'cli-incompatible',
      'session-lost': 'session-lost',
      'host-interrupted': 'host-interrupted'
    }
    const typedPauseReason = executed.failure ? recoverableFailureReason[executed.failure.kind] : undefined
    if (typedPauseReason) {
      const agentName = turn.agent === 'claude' ? 'Claude' : 'Codex'
      throw new RunPauseError({
        reason: typedPauseReason,
        provider: turn.agent,
        message: `${agentName}'s ${stage} stage reached a recoverable ${executed.failure?.kind ?? 'provider'} boundary. The exact workspace and collaboration cursor are preserved.`,
        resumable: true,
        stage,
        action: typedPauseReason === 'provider-auth'
          ? `Sign in to ${agentName}, then resume the same turn.`
          : typedPauseReason === 'model-unavailable'
            ? 'Choose an available model in Agent loadout, apply it, then resume.'
            : typedPauseReason === 'cli-incompatible'
              ? `Update or reconfigure the local ${agentName} CLI, then resume.`
              : 'Resume the same turn when the provider is available.'
      })
    }
    if (executed.assessment.outcome === 'accepted' || executed.assessment.outcome === 'timeboxed') return
    if (executed.assessment.outcome === 'recovery-required') {
      const agentName = turn.agent === 'claude' ? 'Claude' : 'Codex'
      if (stage === 'recovery') {
        throw new RunPauseError({
          reason: 'provider-protocol',
          provider: turn.agent,
          message: `${agentName} completed contract-only recovery, but the provider still did not produce a valid collaboration record (${executed.assessment.reasons.join(', ')}).`,
          resumable: true,
          stage: 'recovery',
          action: 'Resume the same contract-only recovery; accepted implementation will not repeat.'
        })
      }
      session.resumeRecoveryOriginStage = stage
      session.resumeRecoveryReasons = [...executed.assessment.reasons]
      await this.emitEvent(session, createDirectorEvent(session, 'decision', `${agentName} finished the work boundary but missed the broadcast contract. A short contract-only recovery is running; implementation will not repeat.`, {
        severity: 'high', topic: 'contract-recovery', metadata: { stage, reasons: executed.assessment.reasons }
      }))
      const recovery = await this.executeTurnStage(
        session,
        git,
        turn,
        round,
        'recovery',
        undefined,
        executed.assessment.reasons,
        stage
      )
      if (this.remainingRunSeconds(session) <= 0) return
      if (recovery.assessment.outcome === 'accepted' || recovery.assessment.outcome === 'timeboxed') {
        session.resumeRecoveryOriginStage = undefined
        session.resumeRecoveryReasons = undefined
        await this.persistRunState(session)
        return
      }
      throw new RunPauseError({
        reason: 'provider-protocol',
        provider: turn.agent,
        message: `${agentName} completed the model call but the expected collaboration contract could not be recovered (${recovery.assessment.reasons.join(', ')}). The workspace and raw provider record are preserved.`,
        resumable: true,
        stage: 'recovery',
        action: 'Resume the same turn after checking provider compatibility; implementation will not be discarded.'
      })
    }
    throw new RunPauseError({
      reason: executed.failure?.kind === 'stage-timeout' ||
        executed.assessment.reasons.includes('stage-timeout') ||
        executed.assessment.reasons.includes('work-lease-expired')
        ? 'stage-timeout'
        : 'provider-unavailable',
      provider: turn.agent,
      message: `${turn.agent === 'claude' ? 'Claude' : 'Codex'} ${stage} stage could not safely advance (${executed.assessment.reasons.join(', ')}). Durable workspace evidence remains preserved.`,
      resumable: true,
      stage,
      action: 'Resume the preserved turn when the local CLI is ready.'
    })
  }

  private async releaseQuotaClaims(
    session: RunSession,
    agent: Extract<DuoEvent['agent'], 'claude' | 'codex'>
  ): Promise<void> {
    const boardPath = join(session.workspace.duoPath, 'board.json')
    let value: unknown
    try {
      const content = await safeReadProtocolText(session.workspace.duoPath, boardPath)
      if (content === undefined) return
      value = JSON.parse(content) as unknown
    } catch {
      return
    }
    if (typeof value !== 'object' || value === null) return
    const board = value as Record<string, unknown>
    if (!Array.isArray(board.tasks)) return
    let changed = false
    const tasks = (board.tasks as unknown[]).map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return candidate
      const task = candidate as Record<string, unknown>
      if (task.claimedBy !== agent || task.status === 'done') return task
      changed = true
      return { ...task, claimedBy: 'none', status: 'open', handoffReason: 'provider-quota' }
    })
    if (!changed) return
    await safeWriteProtocolText(session.workspace.duoPath, boardPath, `${JSON.stringify({ ...board, tasks }, null, 2)}\n`)
  }

  private async ingestProtocolState(session: RunSession): Promise<void> {
    const files = ['dispatches.jsonl', 'opinions.jsonl', 'conflicts.jsonl', 'build.jsonl']
    for (const file of files) {
      const path = join(session.workspace.duoPath, 'public', file)
      let content = ''
      try {
        content = await safeReadProtocolText(session.workspace.duoPath, path) ?? ''
      } catch {
        continue
      }
      const expectedTypes = file === 'dispatches.jsonl'
        ? new Set<DuoEvent['type']>(['agent.dispatch'])
        : file === 'opinions.jsonl'
          ? new Set<DuoEvent['type']>(['opinion'])
          : file === 'conflicts.jsonl'
            ? new Set<DuoEvent['type']>(['conflict'])
            : new Set<DuoEvent['type']>([
              // Agent-authored failure/repair signals are useful and conservative.
              // A claimed build.passed is deliberately excluded: only observed
              // verifier process evidence may certify the release.
              'build.started', 'build.failed', 'repair.started', 'repair.completed'
            ])
      for (const event of parseProtocolJsonl(content, {
        runId: session.snapshot.runId,
        round: session.snapshot.round,
        sourceKey: `public/${file}`
      })) {
        if (!expectedTypes.has(event.type) || session.seenProtocolEvents.has(event.id)) continue
        const canonicalRound = Math.min(
          Math.max(1, session.turnPlan.length),
          Math.max(1, session.activeTurnIndex + 1)
        )
        await this.emitEvent(session, { ...event, round: canonicalRound }, { protocolOrigin: true })
      }
    }

    try {
      const boardContent = await safeReadProtocolText(
        session.workspace.duoPath,
        join(session.workspace.duoPath, 'board.json')
      )
      if (boardContent === undefined) return
      const tasks = normalizeBoard(JSON.parse(boardContent) as unknown)
      const signature = JSON.stringify(tasks)
      if (signature === session.boardSignature) return
      session.boardSignature = signature
      const previous = new Map(session.snapshot.tasks.map((task) => [task.id, task]))
      for (const task of tasks) {
        const before = previous.get(task.id)
        const type: DuoEvent['type'] = !before
          ? 'task.created'
          : before.claimedBy !== task.claimedBy && task.claimedBy && task.claimedBy !== 'none'
            ? 'task.claimed'
            : 'task.updated'
        if (before && JSON.stringify(before) === JSON.stringify(task)) continue
        const actor = task.claimedBy === 'claude' || task.claimedBy === 'codex' ? task.claimedBy : 'director'
        const publicText = !before
          ? `${actor === 'director' ? 'The agents' : actor === 'claude' ? 'Claude' : 'Codex'} added ${task.publicTitle.toLowerCase()} to the shared board.`
          : type === 'task.claimed'
            ? `${actor === 'claude' ? 'Claude' : 'Codex'} claimed ${task.publicTitle.toLowerCase()}.`
            : `${task.publicTitle} moved to ${task.status}.`
        await this.emitEvent(session, createDirectorEvent(session, type, publicText, {
          id: `board-${task.id}-${task.status}-${task.claimedBy ?? 'none'}`,
          agent: actor,
          task,
          relatedTaskIds: [task.id],
          topic: 'shared-board',
          severity: task.status === 'blocked' ? 'high' : 'low'
        }), { protocolOrigin: true })
      }
      session.snapshot.tasks = tasks
      this.publishSnapshot(session)
    } catch {
      // A board being rewritten is retried on the next protocol poll.
    }
  }

  private async readyForEarlyStop(session: RunSession): Promise<boolean> {
    if (!this.hasDuoQualityEvidence(session)) return false
    if (!await this.seriousMissionContractSatisfied(session)) return false
    const completedOwners = new Set(
      session.snapshot.tasks
        .filter((task) => task.status === 'done' && (task.claimedBy === 'claude' || task.claimedBy === 'codex'))
        .map((task) => task.claimedBy)
    )
    if (!completedOwners.has('claude') || !completedOwners.has('codex')) return false
    if (!await this.verifyCurrentRevision(session)) return false
    if (session.planVersion === 'lean-collaboration-v2') {
      const evidence = await inspectWorkspaceRevealEvidence(
        session.workspace,
        session.snapshot.tasks,
        session.snapshot.events,
        true
      )
      return evidence.hasRunnableArtifact && evidence.hasRecordedVerification
    }
    const packet = await this.readExistingRevealPacket(session)
    return packet?.status === 'ready'
  }

  private async verifyCurrentRevision(session: RunSession): Promise<boolean> {
    await session.eventQueue
    await this.ingestProtocolState(session)
    if (this.hasCurrentVerification(session)) return true
    const previous = session.supervisorVerificationAttempt
    // A passed proof remains authoritative for the exact revision. A failed
    // attempt does not: the failure may be transient, or a later provider
    // command may have supplied new verification evidence without changing
    // the source fingerprint. Reserved repair capacity must be able to retry
    // the independent gate without inventing a source edit.
    if (previous?.revision === session.appEvidenceRevision && previous.passed) return true

    await this.emitEvent(session, createDirectorEvent(
      session,
      'decision',
      'The independent supervisor is checking the exact current source revision. Agent claims cannot unlock the reveal.',
      {
        topic: 'supervisor-verification-started',
        metadata: { revision: session.appEvidenceRevision, trustedBoundary: 'supervisor' }
      }
    ))
    const remainingMs = Math.max(1_000, Math.min(600_000, this.remainingRunSeconds(session) * 1_000))
    const result = await this.supervisorVerifier.verify({
      appPath: session.workspace.appPath,
      npmPath: session.settings.npmPath,
      timeoutMs: remainingMs
    })
    const latestProviderVerification = session.snapshot.events
      .map((event, index) => ({ event, index, outcome: verificationOutcomeOf(event) }))
      .filter((item): item is typeof item & { outcome: 'passed' | 'failed' } =>
        item.event.topic !== 'supervisor-verification' && item.outcome !== undefined
      )
      .sort((left, right) => {
        const timestampDelta = Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp)
        return timestampDelta === 0 ? left.index - right.index : timestampDelta
      })
      .at(-1)
    const hasExecutableProof = result.checks.some((check) =>
      check.id.startsWith('script:') && check.outcome === 'passed'
    )
    const protocolFailureRound = Math.max(-1, ...session.snapshot.events
      .filter((event) => event.type === 'build.failed' && event.metadata?.protocolOrigin === 'workspace-public-protocol')
      .map((event) => event.round))
    const laterProviderPassRound = Math.max(-1, ...session.snapshot.events
      .filter((event) => event.topic !== 'supervisor-verification' && verificationOutcomeOf(event) === 'passed')
      .map((event) => event.round))
    const unresolvedProtocolFailure = protocolFailureRound >= laterProviderPassRound && protocolFailureRound >= 0
    const unresolvedProviderFailure = (
      latestProviderVerification?.outcome === 'failed' || unresolvedProtocolFailure
    ) && !hasExecutableProof
    const passed = result.outcome === 'passed' && !unresolvedProviderFailure
    session.supervisorVerificationAttempt = { revision: session.appEvidenceRevision, passed }
    session.verifiedAppEvidenceRevision = passed ? session.appEvidenceRevision : -1
    await this.emitEvent(session, createDirectorEvent(
      session,
      passed ? 'build.passed' : 'build.failed',
      passed
        ? `Independent supervisor proof passed for source revision ${String(session.appEvidenceRevision)}.`
        : `${unresolvedProviderFailure
            ? 'A recorded provider failure is still unresolved and the artifact-only smoke check cannot overrule it.'
            : result.summary} The evidence is routed into the reserved repair capacity.`,
      {
        severity: passed ? 'low' : 'high',
        topic: 'supervisor-verification',
        metadata: {
          revision: session.appEvidenceRevision,
          supervisorVerified: passed,
          checks: result.checks.map((check) => ({ id: check.id, outcome: check.outcome }))
        }
      }
    ))
    await this.persistRunState(session)
    return passed
  }

  private async readLatestPrivateOpponentHandoff(
    session: RunSession,
    agent: Extract<DuoEvent['agent'], 'claude' | 'codex'>
  ): Promise<{ id: string; round: number; text: string } | undefined> {
    const readBoundedJsonl = async (path: string, maximumBytes = 2_000_000): Promise<Record<string, unknown>[]> => {
      try {
        const content = await safeReadProtocolText(session.workspace.duoPath, path, maximumBytes)
        if (content === undefined) return []
        return content.split(/\r?\n/).flatMap((line) => {
          if (!line.trim()) return []
          try {
            return [record(JSON.parse(line) as unknown)]
          } catch {
            return []
          }
        })
      } catch {
        return []
      }
    }
    const privateRoot = join(session.workspace.duoPath, 'private')
    const [dispatches, opinions, pitches] = await Promise.all([
      readBoundedJsonl(join(privateRoot, 'dispatches.jsonl')),
      readBoundedJsonl(join(privateRoot, 'opinions.jsonl')),
      readBoundedJsonl(join(privateRoot, 'pitches.jsonl'))
    ])
    const belongsToCurrentRun = (input: Record<string, unknown>): boolean =>
      input.runId === undefined || input.runId === session.snapshot.runId
    const validPastOrCurrentRound = (input: Record<string, unknown>): input is Record<string, unknown> & { round: number } =>
      typeof input.round === 'number' && Number.isInteger(input.round) &&
      input.round >= 0 && input.round <= session.snapshot.round
    const dispatch = [...dispatches].reverse().find((input) =>
      belongsToCurrentRun(input) &&
      validPastOrCurrentRound(input) &&
      input.type === 'agent.dispatch' &&
      input.agent !== agent &&
      (input.agent === 'claude' || input.agent === 'codex') &&
      Boolean(revealText(input.id)) &&
      Boolean(revealText(input.privateText))
    )
    if (!dispatch) return undefined
    const opponent = dispatch.agent as 'claude' | 'codex'
    const id = revealText(dispatch.id)
    const speech = revealText(dispatch.privateText)
    const round = dispatch.round as number
    if (!id || !speech) return undefined
    const opinion = [...opinions].reverse().find((input) =>
      belongsToCurrentRun(input) && input.agent === opponent && input.round === round && Boolean(revealText(input.privateText))
    )
    const matchingPitches = pitches.filter((input) =>
      belongsToCurrentRun(input) && input.agent === opponent && input.round === round
    ).slice(-2)
    const pitchText = matchingPitches.map((pitch, index) => {
      const title = revealText(pitch.title)
      const idea = revealText(pitch.idea)
      const appeal = revealText(pitch.appeal)
      const risk = revealText(pitch.risk)
      return title && idea
        ? `Pitch ${String(index + 1)} — ${title}: ${idea}${appeal ? ` Appeal: ${appeal}` : ''}${risk ? ` Risk: ${risk}` : ''}`
        : undefined
    }).filter((value): value is string => Boolean(value))
    const privateOpinion = revealText(opinion?.privateText)
    const context = [
      `${opponent === 'claude' ? 'Claude' : 'Codex'} private ${revealText(dispatch.dispatchKind) ?? 'position'}:`,
      speech,
      ...(privateOpinion ? [`Opinion: ${privateOpinion}`] : []),
      ...pitchText
    ].join('\n')
    const maximum = 1_200
    return {
      id,
      round,
      text: context.length <= maximum ? context : `${context.slice(0, maximum - 1).trimEnd()}…`
    }
  }

  private async readExistingRevealPacket(
    session: RunSession,
    evidence?: WorkspaceRevealEvidence
  ): Promise<RevealPacket | undefined> {
    const workspaceEvidence = evidence ?? await inspectWorkspaceRevealEvidence(
      session.workspace,
      session.snapshot.tasks,
      session.snapshot.events,
      this.hasCurrentVerification(session)
    )
    const candidates = [
      join(session.workspace.duoPath, 'sealed', 'reveal_packet.json'),
      join(session.workspace.duoPath, 'reveal_packet.json')
    ]
    for (const path of candidates) {
      try {
        const content = await safeReadProtocolText(session.workspace.duoPath, path)
        if (content === undefined) continue
        const packet = safeRevealPacket(JSON.parse(content) as unknown, session.workspace, workspaceEvidence)
        if (packet) return packet
      } catch {
        // The next candidate may still contain a complete packet.
      }
    }
    return undefined
  }

  private async loadRedactionDictionary(session: RunSession): Promise<void> {
    try {
      const content = await safeReadProtocolText(
        session.workspace.duoPath,
        join(session.workspace.duoPath, 'sealed', 'redactions.json')
      )
      if (content === undefined) throw new Error('Missing redaction dictionary.')
      const value = JSON.parse(content) as { terms?: Array<{ value?: unknown; label?: unknown }> }
      const terms = Array.isArray(value.terms)
        ? value.terms
            .filter((term): term is { value: string; label?: string } => typeof term.value === 'string')
            .map((term) => ({
              value: term.value,
              ...(typeof term.label === 'string' ? { label: term.label } : {})
            }))
        : []
      session.redactionTerms = buildRedactionTerms(terms)
    } catch {
      session.redactionTerms = []
    }
  }

  private async readRevealPacket(session: RunSession): Promise<RevealPacket> {
    const evidence = await inspectWorkspaceRevealEvidence(
      session.workspace,
      session.snapshot.tasks,
      session.snapshot.events,
      this.hasCurrentVerification(session)
    )
    const packet = await this.readExistingRevealPacket(session, evidence)
    if (packet) {
      const enriched = enrichRevealPacket(packet, session.snapshot.events, session.snapshot.tasks)
      const releaseIssues: string[] = []
      if (!evidence.hasRunnableArtifact) {
        releaseIssues.push('The supervisor could not discover a runnable app artifact on the final workspace revision.')
      }
      if (!this.hasCurrentVerification(session)) {
        releaseIssues.push('Independent supervisor verification did not pass on the exact final source revision.')
      }
      if (!this.hasDuoQualityEvidence(session)) {
        releaseIssues.push('Both agents need an accepted build contribution, a completed owned task, and reply-linked cross-review evidence before the build can be marked ready.')
      }
      if (!await this.seriousMissionContractSatisfied(session)) {
        releaseIssues.push('The serious mission could not prove an intact binding chain from the human brief to the sealed implementation specification.')
      }
      if (releaseIssues.length === 0) return enriched
      return {
        ...enriched,
        status: 'partial',
        knownIssues: uniqueRevealStrings([
          ...releaseIssues,
          ...enriched.knownIssues
        ])
      }
    }
    const supervisorCanCertifyRelease = evidence.hasRunnableArtifact &&
      evidence.hasRecordedVerification &&
      this.hasCurrentVerification(session) &&
      this.hasDuoQualityEvidence(session) &&
      await this.seriousMissionContractSatisfied(session)
    if (supervisorCanCertifyRelease) {
      const verifiedFeatures = evidence.features.length > 0 ? evidence.features : evidence.completedWork
      const factualSummary = 'A runnable artifact passed current trusted verification after accepted build contributions, reciprocal review, and completed work from both agents.'
      return enrichRevealPacket({
        appName: evidence.appName ?? 'Verified local artifact',
        idea: evidence.idea ?? verifiedFeatures[0] ?? factualSummary,
        summary: factualSummary,
        features: verifiedFeatures,
        runCommand: evidence.runCommand ?? 'Open the generated workspace for inspection.',
        appPath: evidence.directEntrypoint ?? session.workspace.appPath,
        status: 'ready',
        whatWorked: evidence.completedWork,
        knownIssues: [],
        agentDramaSummary: [],
        gitCheckpoints: uniqueRevealStrings(session.snapshot.events
          .filter((event) => event.type === 'git.checkpoint')
          .map((event) => event.publicText)),
        // Enrichment replaces these empty values with the latest real, recorded
        // public statement from each accepted agent.
        agentQuotes: { claude: '', codex: '' }
      }, session.snapshot.events, session.snapshot.tasks)
    }
    const features = evidence.features.length > 0 ? evidence.features : evidence.completedWork
    return {
      appName: evidence.appName ?? basename(session.workspace.workspacePath),
      idea: evidence.idea ?? 'The agents reached the turn limit before completing the final reveal contract.',
      summary: 'The generated artifact was recovered from the workspace, with final release metadata still incomplete.',
      features,
      runCommand: evidence.runCommand ?? 'Open the generated workspace for inspection.',
      appPath: evidence.directEntrypoint ?? session.workspace.appPath,
      status: 'partial',
      whatWorked: evidence.completedWork.length > 0
        ? evidence.completedWork
        : ['Both local CLI agents completed scheduled turns.'],
      knownIssues: ['No valid reveal packet was produced before the turn limit.'],
      agentDramaSummary: ['The orchestrator preserved the partial workspace rather than inventing a successful result.'],
      gitCheckpoints: [],
      agentQuotes: {
        claude: 'The workspace needs another repair pass.',
        codex: 'The final contract was incomplete, so the result is marked partial.'
      }
    }
  }

  private hasCurrentVerification(session: RunSession): boolean {
    return session.verifiedAppEvidenceRevision >= 0 &&
      session.verifiedAppEvidenceRevision === session.appEvidenceRevision
  }

  private async seriousMissionContractSatisfied(session: RunSession): Promise<boolean> {
    if ((session.request.missionProfile ?? 'surprise') !== 'serious') return true
    return await validateSeriousMissionContract(
      join(session.workspace.duoPath, 'sealed'),
      session.request.prompt,
      join(session.workspace.runtimePath, 'private', 'serious_mission_guard.json')
    )
  }

  private hasDuoQualityEvidence(session: RunSession): boolean {
    return session.acceptedCodeAgents.size === 2 && session.acceptedReviewAgents.size === 2 &&
      hasCompletedOwnedTask(session.snapshot.tasks, 'claude') &&
      hasCompletedOwnedTask(session.snapshot.tasks, 'codex')
  }
}
