import { randomBytes, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  AppSettings,
  AgentEffort,
  BroadcastSnapshot,
  CodexEffort,
  CustomizationProfile,
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
import { repairMojibake } from '@main/text/repair-mojibake'
import {
  ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult
} from '@main/process/process-runner'
import { buildRedactionTerms, type RedactionTerm } from '@main/security/redaction'
import { validateRunRequest } from '@main/security/run-policy'
import { projectEventForRenderer, projectTaskForRenderer } from '@main/security/visibility'
import {
  createRunWorkspace,
  restoreSupervisorWorkspacePolicy,
  type RunWorkspace
} from '@main/workspace/workspace-manager'
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
import { mergeBoardWithTaskContracts, normalizeBoard, parseProtocolJsonl } from './protocol-sync'
import { buildBroadcastState } from './broadcast-director'
import {
  buildQualityRepairTurns,
  buildLegacyRealTurnPlan,
  buildRealTurnPlan,
  contributionNeedsFreshSource,
  decideQualityRepair,
  type RealTurn,
  type RealTurnPlanVersion
} from './real-turn-plan'
import { buildSimulationScript, SIMULATION_ARTIFACT_HTML } from './simulation-script'
import {
  buildReviewReceipt,
  hasCompletedOwnedTask,
  promotedSurvivingContributionReceipts,
  reviewAcceptsCurrentRevision,
  type ReviewReceipt
} from './collaboration-evidence'
import {
  assessTurnAcceptance,
  hasDurableWorkEvidence,
  reusableDurableWorkEvidence,
  type TurnAcceptance
} from './turn-acceptance'
import {
  extendStageDeadlineForPause,
  remainingStageLeaseSeconds,
  resolveResumeStageLeaseSeconds,
  resolveStageBudgetSeconds,
  type TurnBudgetPolicy
} from './turn-budget'
import { composeTurnStagePrompt } from './turn-prompts'
import { RunUsageTracker, evaluateCompletedCallUsage } from './usage-telemetry'
import { resolveStageEffortDecision } from './stage-effort-policy'
import { WorkLeaseGuard } from './work-lease-guard'
import { containsStructuredWorkspaceActivity } from './structured-output-activity'
import {
  recordExplicitRecoveryResume,
  recoveryResumeAuditKey
} from './recovery-resume-audit'
import { selectTurnCapabilities } from './capability-broker'
import {
  compileQualityBrief,
  formatQualityBriefBatonForAgent,
  formatQualityBriefForAgent,
  type CompiledQualityBrief
} from './quality-brief'
import {
  buildContributionReceipt,
  mergeContributionReceiptClosure,
  receiptCompletesOwnedContribution,
  receiptEligibleForProofPromotion,
  survivingContributionCandidates,
  type ContributionReceipt
} from './contribution-receipt'
import { buildContextBaton, buildVerificationDigest } from './context-baton'
import { repinUnavailableProvider } from './resume-loadout'
import { StageEventLedger } from './stage-event-ledger'
import { SupervisorVerifier, type SupervisorVerifierPort } from './supervisor-verifier'
import { SupervisorProofStore } from './supervisor-proof-store'
import {
  createPitchProvenanceId,
  resolveConsensusProvenance,
  validateConsensusProvenance,
  type ConsensusProvenanceRecord,
  type PitchProvenanceRecord
} from './consensus-provenance'
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

const SUPERVISOR_VERIFICATION_GRACE_MS = 600_000

function dialogueRecoveryReason(error: DialogueCapsuleError): string {
  if (/binding quality brief/iu.test(error.message)) return 'consensus-quality-contract'
  if (/pitch provenance|supervisor-recorded pitch provenance|previously pitched candidate/iu.test(error.message)) {
    return 'consensus-provenance'
  }
  if (/workspace tool activity/iu.test(error.message)) return 'structured-tool-activity'
  return 'invalid-dialogue-contract'
}

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
  cancel?: (id: string, reason?: 'user' | 'lease') => Promise<boolean>
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
  qualityBrief: CompiledQualityBrief
  proofStore: SupervisorProofStore
  taskContracts: DuoTask[]
  contributionReceipts: ContributionReceipt[]
  reviewReceipts: ReviewReceipt[]
  /** Minimal private event identities required to validate durable equality proof. */
  collaborationProofEvents: DuoEvent[]
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
  workLeaseContinuations: Map<string, number>
  qualityRepairAttempts: number
  qualityRepairMissingEvidence: string[]
  /** Human-authorized retry audit. It is diagnostic and never a hard recovery cap. */
  retries: DurableRunManifest['retries']
}

interface ExecutedTurnStage {
  assessment: TurnAcceptance
  durableSourceChanged: boolean
  structuredContractAccepted?: boolean
  supervisorVerifiedNoChange?: boolean
  sessionId?: string
  quotaRejected?: boolean
  quotaResetAt?: string
  failure?: ProviderFailureClassification
  leaseTimeboxed?: boolean
  contributionReceipt?: ContributionReceipt
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

function mergeSupervisorEvidenceEvents(...groups: DuoEvent[][]): DuoEvent[] {
  const events = new Map<string, DuoEvent>()
  for (const group of groups) {
    for (const event of group) events.set(event.id, event)
  }
  return [...events.values()]
}

function customizationFor(
  request: StartRunRequest,
  agent: 'claude' | 'codex'
): CustomizationProfile {
  return agent === 'claude'
    ? request.claudeCustomizationProfile ?? 'core'
    : request.codexCustomizationProfile ?? 'core'
}

function pinRequestToSettings(request: StartRunRequest, settings: AppSettings): StartRunRequest {
  const pinned: StartRunRequest = {
    ...request,
    // Legacy and non-UI callers that omit the new capability contract stay on
    // the least-privileged core toolset. The Studio renderer sends the user's
    // explicit saved selection and confirmation on every new run.
    codexCustomizationProfile: request.codexCustomizationProfile ?? 'core',
    claudeCustomizationProfile: request.claudeCustomizationProfile ?? 'core',
    trustedLocalCapabilitiesConfirmed: request.trustedLocalCapabilitiesConfirmed ?? false,
    qualityRoutingProfile: request.qualityRoutingProfile ?? settings.qualityRoutingProfile,
    workInferenceLimit: request.workInferenceLimit ?? request.claudeWorkInferenceLimit ?? settings.workInferenceLimit,
    codexModel: request.codexModel ?? settings.codexModel,
    codexEffort: request.codexEffort ?? settings.codexEffort,
    claudeModel: request.claudeModel ?? settings.claudeModel,
    claudeEffort: request.claudeEffort ?? settings.claudeEffort
  }
  const usesLocalToolbelt = customizationFor(pinned, 'claude') !== 'core' ||
    customizationFor(pinned, 'codex') !== 'core'
  if (pinned.executionMode !== 'simulation' && usesLocalToolbelt && pinned.trustedLocalCapabilitiesConfirmed !== true) {
    throw new Error('Confirm that this workspace may use your local CLI skills, plugins, and MCP tools before starting.')
  }
  return pinned
}

function settingsForPinnedRun(settings: AppSettings, request: StartRunRequest): AppSettings {
  return {
    ...settings,
    codexModel: request.codexModel ?? settings.codexModel,
    codexEffort: request.codexEffort ?? settings.codexEffort,
    claudeModel: request.claudeModel ?? settings.claudeModel,
    claudeEffort: request.claudeEffort ?? settings.claudeEffort,
    codexCustomizationProfile: request.codexCustomizationProfile ?? settings.codexCustomizationProfile,
    claudeCustomizationProfile: request.claudeCustomizationProfile ?? settings.claudeCustomizationProfile,
    qualityRoutingProfile: request.qualityRoutingProfile ?? settings.qualityRoutingProfile,
    workInferenceLimit: request.workInferenceLimit ?? request.claudeWorkInferenceLimit ?? settings.workInferenceLimit,
    trustedLocalCapabilitiesConfirmed: request.trustedLocalCapabilitiesConfirmed ?? settings.trustedLocalCapabilitiesConfirmed
  }
}

function decorateRuntimeProfiles(
  profiles: NonNullable<RunSnapshot['agentRuntimes']>,
  request: StartRunRequest
): NonNullable<RunSnapshot['agentRuntimes']> {
  const decorate = (
    agent: 'claude' | 'codex',
    profile: NonNullable<RunSnapshot['agentRuntimes']>['claude']
  ): NonNullable<RunSnapshot['agentRuntimes']>['claude'] => {
    if (!profile) return profile
    const requestedModel = agent === 'claude' ? request.claudeModel?.trim() : request.codexModel?.trim()
    const requestedEffort = agent === 'claude' ? request.claudeEffort : request.codexEffort
    const studioPinned = Boolean(requestedModel) || Boolean(requestedEffort && requestedEffort !== 'default')
    return {
      ...profile,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort && requestedEffort !== 'default' ? { effort: requestedEffort } : {}),
      ...(studioPinned ? { source: 'studio' as const } : {}),
      customizationProfile: customizationFor(request, agent),
      qualityCeiling: requestedEffort ?? profile.effort ?? 'default'
    }
  }
  return {
    ...(profiles.claude ? { claude: decorate('claude', profiles.claude) } : {}),
    ...(profiles.codex ? { codex: decorate('codex', profiles.codex) } : {})
  }
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

function compactRevealText(value: string | undefined, maximum = 280): string | undefined {
  if (!value) return undefined
  const compact = value
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return undefined
  if (compact.length <= maximum) return compact
  const sentenceBoundary = compact.lastIndexOf('.', maximum - 1)
  const wordBoundary = compact.lastIndexOf(' ', maximum - 1)
  const boundary = sentenceBoundary >= Math.floor(maximum * 0.55) ? sentenceBoundary + 1 : wordBoundary
  return `${compact.slice(0, Math.max(1, boundary)).trimEnd()}…`
}

function compactRevealStrings(values: string[], maximum = 180): string[] {
  return uniqueRevealStrings(values.map((value) => compactRevealText(value, maximum)))
}

function productName(value: string | undefined): string | undefined {
  const compact = compactRevealText(value, 120)
  if (!compact) return undefined
  return compact.split(/\s+(?:—|–|\|)\s+/u, 1)[0]?.trim() || compact
}

function markdownHeading(content: string): string | undefined {
  return productName(revealText(content.match(/^#\s+(.+)$/m)?.[1]))
}

function firstMarkdownParagraph(content: string): string | undefined {
  const paragraphs = content
    .replace(/^#.*$/gm, '')
    .split(/\r?\n\s*\r?\n/u)
    .map((paragraph) => compactRevealText(paragraph, 320))
    .filter((paragraph): paragraph is string => Boolean(paragraph))
  return paragraphs[0]
}

function isVerboseRevealCopy(value: string | undefined): boolean {
  return Boolean(value && (value.length > 420 || value.split(/\r?\n/u).length > 4))
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

function isExpectedClaudeStructuredMaxTurnClosure(
  agent: Extract<DuoEvent['agent'], 'claude' | 'codex'>,
  records: ProviderRecord[],
  result: ProcessRunResult
): boolean {
  if (
    agent !== 'claude' || result.exitCode === 0 || result.signal !== null || result.timedOut || result.cancelled ||
    result.outputLimitExceeded || result.rawLogWriteFailed
  ) return false
  const markerIndices = records.flatMap((providerRecord, index) => {
    const candidate = record(providerRecord)
    return candidate.type === 'result' && candidate.subtype === 'error_max_turns' ? [index] : []
  })
  if (markerIndices.length !== 1 || markerIndices[0] !== records.length - 1) return false

  // Only the canonical final max-turn marker may explain this non-zero exit.
  // Never let a valid StructuredOutput payload hide a second fatal provider
  // record merely because both arrived in the same buffered envelope.
  return records.every((providerRecord, index) => {
    if (index === markerIndices[0]) return true
    const candidate = record(providerRecord)
    const type = typeof candidate.type === 'string' ? candidate.type.toLocaleLowerCase() : ''
    const subtype = typeof candidate.subtype === 'string' ? candidate.subtype.toLocaleLowerCase() : ''
    const hasErrorPayload = typeof candidate.error === 'string'
      ? candidate.error.trim().length > 0
      : candidate.error !== undefined && candidate.error !== null
    return type !== 'error' && !type.endsWith('.error') && candidate.is_error !== true &&
      !subtype.startsWith('error_') && !hasErrorPayload
  })
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

  const ideaMarkdown = await readSmallText(
    workspace.duoPath,
    join(workspace.duoPath, 'sealed', 'idea.md')
  )
  if (ideaMarkdown) {
    appName = markdownHeading(ideaMarkdown)
    idea = firstMarkdownParagraph(ideaMarkdown)
  }

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
  if (entryContent) appName ??= productName(htmlTitle(entryContent))

  const packageContent = await readSmallText(workspace.workspacePath, join(workspace.appPath, 'package.json'))
  let packageRunCommand: string | undefined
  if (packageContent) {
    try {
      const packageJson = record(JSON.parse(packageContent) as unknown)
      const packageName = revealText(packageJson.productName) ?? revealText(packageJson.displayName) ?? revealText(packageJson.name)
      if (packageName) appName ??= productName(humanizePackageName(packageName))
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
    appName ??= markdownHeading(readme)
    idea ??= firstMarkdownParagraph(readme)
  }

  const completedWork = uniqueRevealStrings(tasks
    .filter((task) => task.status === 'done')
    .map((task) => {
      const publicTitle = task.publicTitle?.trim()
      const publicTitleIsPlaceholder = Boolean(publicTitle && /\[(?:feature|mechanic|interaction|app_name|product_name)\]/i.test(publicTitle))
      return publicTitle && !publicTitleIsPlaceholder
        ? publicTitle
        : task.publicDescription ?? task.privateDescription ?? task.privateTitle ?? publicTitle
    }))
  const features = compactRevealStrings(completedWork.length > 0 ? completedWork : specFeatures)
  idea ??= compactRevealText(specFeatures[0], 320) ?? features[0]

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
  const providedAppName = productName(revealText(input.appName))
  const providedIdea = revealText(input.idea)
  const providedSummary = revealText(input.summary)
  const providedRunCommand = revealText(input.runCommand)
  const workspacePlaceholderName = Boolean(providedAppName && (
    providedAppName.toLocaleLowerCase() === workspaceName.toLocaleLowerCase() ||
    /^duo-run-\d{8}t\d{6}z-[a-z0-9]+$/i.test(providedAppName)
  ))
  const legacyFallback = workspacePlaceholderName &&
    /turn limit before writing a complete reveal packet/i.test(providedIdea ?? '') &&
    /inspect the generated readme and package\.json/i.test(providedRunCommand ?? '')
  const appName = workspacePlaceholderName
    ? evidence.appName ?? providedAppName ?? workspaceName
    : providedAppName ?? evidence.appName ?? workspaceName
  const genericPartialSummary = /partial generated workspace|ready for inspection|release metadata.*incomplete/i.test(providedSummary ?? '')
  const genericWorkspaceCommand = /(?:open|inspect)(?: the)? generated workspace|readme|package\.json/i.test(providedRunCommand ?? '')
  const summary = legacyFallback || genericPartialSummary
    ? `${appName} was recovered from the generated workspace; the original release metadata was incomplete.`
    : compactRevealText(providedSummary, 360) ?? compactRevealText(providedIdea, 360) ?? evidence.idea ?? 'A generated workspace is ready for inspection.'
  const providedAppPath = revealText(input.appPath)
  const usesAppDirectory = !providedAppPath || providedAppPath === 'app' || providedAppPath === workspace.appPath
  const rawFeatures = revealStrings(input.features)
  const features = rawFeatures.some((feature) => isVerboseRevealCopy(feature))
    ? evidence.features
    : compactRevealStrings(rawFeatures)
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
    idea: legacyFallback || isVerboseRevealCopy(providedIdea)
      ? evidence.idea ?? summary
      : compactRevealText(providedIdea, 320) ?? evidence.idea ?? summary,
    summary,
    features: features.length > 0 ? uniqueRevealStrings(features) : evidence.features,
    runCommand: legacyFallback || (workspacePlaceholderName && genericWorkspaceCommand)
      ? evidence.runCommand ?? 'Open the generated workspace for inspection.'
      : providedRunCommand ?? evidence.runCommand ?? 'Open the generated workspace for inspection.',
    appPath: usesAppDirectory && evidence.directEntrypoint
      ? evidence.directEntrypoint
      : providedAppPath ?? evidence.directEntrypoint ?? workspace.appPath,
    ...(revealText(input.devUrl) ? { devUrl: revealText(input.devUrl) } : {}),
    status,
    whatWorked: !legacyFallback && providedWork.length > 0
      ? compactRevealStrings(providedWork)
      : compactRevealStrings([...checks, ...evidence.completedWork]),
    knownIssues: compactRevealStrings(
      (revealStrings(input.knownIssues).length > 0
        ? revealStrings(input.knownIssues)
        : revealStrings(input.remainingCaveats))
        .filter((issue) => !/no valid reveal packet was produced/i.test(issue))
    ),
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
    const validatedRequest = validateRunRequest(value, {
      minimumTurns: this.options.testOnlyMinimumTurns
    })
    const active = [...this.sessions.values()].find((session) => session.snapshot.status === 'running')
    if (active) throw new Error('A run is already active. Stop it before starting another.')

    const loadedSettings = await this.options.getSettings()
    const request = pinRequestToSettings(validatedRequest, loadedSettings)
    const settings = settingsForPinnedRun(loadedSettings, request)
    const agentRuntimes = decorateRuntimeProfiles(await resolveAgentRuntimeProfiles(settings), request)
    const runId = createRunId()
    const qualityBrief = compileQualityBrief({
      humanBrief: request.prompt,
      missionProfile: request.missionProfile ?? 'surprise'
    })
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
    await safeWriteProtocolText(
      workspace.duoPath,
      join(workspace.duoPath, 'sealed', 'quality_brief.json'),
      `${JSON.stringify(qualityBrief, null, 2)}\n`
    )
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
      qualityBrief,
      proofStore: new SupervisorProofStore(workspace.runtimePath),
      taskContracts: [],
      contributionReceipts: [],
      reviewReceipts: [],
      collaborationProofEvents: [],
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
      providerPressure: {},
      workLeaseContinuations: new Map(),
      qualityRepairAttempts: 0,
      qualityRepairMissingEvidence: [],
      retries: []
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
      .catch((error: unknown) => {
        // A secondary local persistence failure while recording the original
        // boundary must never become an unhandled rejection. Keep the public
        // snapshot honest even when the protocol journal itself cannot accept
        // another atomic write.
        this.freezeActiveClock(session)
        session.snapshot.status = 'failed'
        session.snapshot.phase = 'failed'
        session.snapshot.finishedAt = new Date().toISOString()
        session.snapshot.activeAgent = undefined
        session.snapshot.pause = undefined
        session.snapshot.events.push(createDirectorEvent(
          session,
          'run.failed',
          error instanceof Error
            ? `The local supervisor could not persist the battle boundary: ${error.message}`
            : 'The local supervisor could not persist the battle boundary.',
          { severity: 'critical', topic: 'host-interrupted' }
        ))
        this.publishSnapshot(session)
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
      ...(input.missingEvidence?.length
        ? { missingEvidence: input.missingEvidence }
        : session.qualityRepairMissingEvidence.length > 0 && session.privateRevealPacket?.status === 'partial'
          ? { missingEvidence: session.qualityRepairMissingEvidence }
          : {}),
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
        severity: input.reason === 'quality-repair' ? 'medium' : input.reason === 'provider-quota' ? 'high' : 'critical',
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
    const resumesQualityRepair = session.snapshot.pause.reason === 'quality-repair'
    const resumesUsageGuard = session.snapshot.usageGuard?.status === 'pending'
    if (session.runnerActive) throw new Error('The battle is still settling. Try Resume again in a moment.')
    const now = this.nowMs()
    if (session.pausedAtMs !== undefined) {
      session.runDeadlineMs += Math.max(0, now - session.pausedAtMs)
      if (session.snapshot.turnStage) {
        session.snapshot.turnStage = {
          ...session.snapshot.turnStage,
          deadlineAt: extendStageDeadlineForPause(
            session.snapshot.turnStage.deadlineAt,
            session.pausedAtMs,
            now
          )
        }
      }
    }
    if (resumesQualityRepair) {
      // Explicit Resume authorizes the already-reserved pair and its verifier.
      // It does not reopen or replay any completed provider turn.
      const repairWindowMs = Math.max(20 * 60_000, session.request.turnTimeoutSeconds * 2 * 1_000)
      session.runDeadlineMs = Math.max(session.runDeadlineMs, now + repairWindowMs)
    }
    const appliedSettings = await this.options.getSettings()
    if (session.snapshot.pause?.reason === 'model-unavailable') {
      session.request = repinUnavailableProvider(
        session.request,
        appliedSettings,
        session.snapshot.pause.provider
      )
    }
    session.settings = settingsForPinnedRun(appliedSettings, session.request)
    const git = new GitManager(session.settings.gitPath, join(session.workspace.runtimePath, 'supervisor-git'))
    const initialized = await git.initialize(session.workspace.workspacePath)
    if (!initialized.ok) throw new Error(initialized.detail ?? 'The preserved Git checkpoint could not be reopened.')
    const currentFingerprint = await git.appStateFingerprint(session.workspace.workspacePath)
    let adoptedWorkspaceDrift = false
    if (session.appFingerprint && currentFingerprint !== session.appFingerprint) {
      if (session.snapshot.pause?.reason !== 'workspace-drift') {
        throw new Error('The generated app changed outside the preserved battle. Reopen the recovered battle before adopting that source.')
      }
      const adopted = await this.createGitCheckpoint(session, git, 'chore(duo): adopt recovered workspace boundary')
      if (!adopted.ok || !session.appFingerprint) {
        throw new Error(adopted.detail ?? 'The recovered workspace could not be sealed by Git.')
      }
      adoptedWorkspaceDrift = true
      session.appEvidenceRevision += 1
      session.verifiedAppEvidenceRevision = -1
      if (session.snapshot.turnStage) {
        session.snapshot.turnStage = {
          ...session.snapshot.turnStage,
          durableSourceChanged: true,
          evidenceFingerprint: session.appFingerprint
        }
      }
      await this.persistRunState(session)
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
    session.snapshot.agentRuntimes = decorateRuntimeProfiles(
      await resolveAgentRuntimeProfiles(session.settings),
      session.request
    )
    const pausedStage = session.snapshot.turnStage
    const pausedInferenceLimit = pausedStage?.inferenceLimit ?? session.request.workInferenceLimit ?? session.request.claudeWorkInferenceLimit ?? 8
    const resumesExhaustedWorkCapsule = session.snapshot.pause?.reason === 'stage-timeout' &&
      session.snapshot.pause.provider === pausedStage?.agent &&
      pausedStage?.stage === 'work' &&
      (pausedStage.inferenceSteps ?? 0) >= pausedInferenceLimit
    if (resumesExhaustedWorkCapsule && pausedStage) {
      // The automatic compact continuation has already been spent. An explicit
      // user Resume authorizes one new bounded inference capsule for this same
      // logical turn. Keep continuationCount unchanged so this fresh capsule
      // cannot silently unlock another automatic retry.
      session.snapshot.turnStage = {
        ...pausedStage,
        status: 'running',
        inferenceSteps: 0
      }
      delete session.providerSessions[pausedStage.agent]
    }
    session.controller = new AbortController()
    session.quotaConstrainedAgents.clear()
    session.providerPressure = {}
    if (resumesUsageGuard && session.snapshot.usageGuard) {
      session.snapshot.usageGuard = {
        ...session.snapshot.usageGuard,
        status: 'acknowledged',
        acknowledgedAt: new Date().toISOString()
      }
    }
    const recoveryResumeAudit = session.resumeStage === 'recovery'
      ? recordExplicitRecoveryResume(session.retries, {
          idempotencyKey: recoveryResumeAuditKey({
            runId: session.snapshot.runId,
            turnId: session.snapshot.turnStage?.turnId ??
              session.turnPlan[session.activeTurnIndex]?.id ??
              `turn-${String(session.activeTurnIndex)}`,
            originStage: session.resumeRecoveryOriginStage,
            reasonCategory: session.resumeRecoveryReasons?.slice().sort().join('|') ||
              session.snapshot.pause?.reason
          }),
          reason: session.snapshot.pause?.reason ?? 'provider-protocol',
          updatedAt: new Date(now).toISOString()
        })
      : undefined
    if (recoveryResumeAudit) session.retries = recoveryResumeAudit.records
    session.snapshot.status = 'running'
    session.snapshot.phase = session.resumePhase ?? session.turnPlan[session.activeTurnIndex]?.phase ?? 'reveal.ready'
    session.snapshot.finishedAt = undefined
    session.snapshot.activeAgent = undefined
    // Preserve the durable stage receipt until the resumed executor replaces
    // it. This prevents the same accepted edit from being repeated after a
    // quota or host pause.
    if (session.snapshot.turnStage) {
      session.snapshot.turnStage = { ...session.snapshot.turnStage, status: 'running' }
    }
    session.snapshot.pause = undefined
    session.activeSinceMs = now
    session.pausedAtMs = undefined
    await this.emitEvent(session, createDirectorEvent(
      session,
      'run.resumed',
      adoptedWorkspaceDrift
        ? 'The recovered source was adopted as a new Git boundary. Verification is stale, so the same logical turn will reconcile it before the battle advances.'
        : recoveryResumeAudit?.advisory
          ? `Contract-only recovery resume ${String(recoveryResumeAudit.attempts)} is starting from the same preserved boundary. No automatic retry loop or source replay is running; inspect provider compatibility if the narrow contract fails again.`
        : recoveryResumeAudit
          ? 'Contract-only recovery resumed from the same preserved boundary. The bounded recovery lease cannot edit source or replay accepted implementation.'
        : resumesUsageGuard
          ? 'The exact provider-usage checkpoint was acknowledged. One fresh compact call may continue from the durable baton; completed work will not be replayed.'
        : resumesExhaustedWorkCapsule
          ? `The preserved ${pausedStage?.agent === 'claude' ? 'Claude' : 'Codex'} turn resumed in a fresh bounded work capsule. Existing source and evidence stay intact; the exhausted provider session will not be replayed.`
        : resumesQualityRepair
          ? 'The reserved quality-repair pair resumed from the sealed cursor. Completed provider turns will not be replayed.'
        : 'The preserved battle resumed from its last durable turn boundary.',
      {
        severity: 'high',
        topic: adoptedWorkspaceDrift
          ? 'workspace-adopted'
          : recoveryResumeAudit?.advisory
            ? 'recovery-resume-advisory'
          : recoveryResumeAudit
            ? 'recovery-resumed'
          : resumesUsageGuard
            ? 'usage-guard-resumed'
          : resumesExhaustedWorkCapsule
            ? 'work-capsule-resumed'
            : resumesQualityRepair
              ? 'quality-repair-resumed'
            : 'run-resumed',
        metadata: {
          turnIndex: session.activeTurnIndex,
          adoptedWorkspaceDrift,
          resumesUsageGuard,
          resumesExhaustedWorkCapsule,
          resumesQualityRepair,
          ...(recoveryResumeAudit
            ? {
                recoveryResumeAttempts: recoveryResumeAudit.attempts,
                recoveryResumeAdvisory: recoveryResumeAudit.advisory,
                automaticRetry: false,
                sourceReplay: false
              }
            : {})
        }
      }
    ))
    if (recoveryResumeAudit) {
      // Persist the human-authorized recovery audit before launching the child.
      // A host crash must not erase the diagnostic attempt count.
      await this.persistRunState(session)
    }
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
        const manifestRevealReady = manifest.status === 'reveal-ready'
        // Dangerous-mode consent is deliberately ephemeral. Finished sealed work can be
        // revealed without executing an agent, but an active YOLO battle must be started
        // again so the user explicitly reconfirms its disposable environment.
        if (manifestRevealReady && manifest.request.missionProfile === 'serious') {
          const seriousContractValid = await validateSeriousMissionContract(
            join(workspacePath, '.duo', 'sealed'),
            manifest.request.prompt,
            join(runtimePath, 'private', 'serious_mission_guard.json')
          )
          if (!seriousContractValid) continue
        }
        let workspaceDrift = false
        if (manifest.git.appFingerprint) {
          const git = new GitManager(settings.gitPath, join(runtimePath, 'supervisor-git'))
          const currentFingerprint = await git.appStateFingerprint(workspacePath)
          workspaceDrift = !currentFingerprint || currentFingerprint !== manifest.git.appFingerprint
        }
        const revealReady = manifestRevealReady && !workspaceDrift
        if (manifest.request.executionMode === 'yolo-sandbox' && !revealReady) continue
        const planVersion: RealTurnPlanVersion = manifest.planVersion === 'balanced-hybrid-v1'
          ? 'balanced-hybrid-v1'
          : 'lean-collaboration-v2'
        const baseTurnPlan = planVersion === 'balanced-hybrid-v1'
          ? buildLegacyRealTurnPlan(runId, {
              maxTurns: manifest.request.maxTurns,
              maxRepairLoops: manifest.request.maxRepairLoops
            })
          : buildRealTurnPlan(runId, {
          maxTurns: manifest.request.maxTurns,
          maxRepairLoops: manifest.request.maxRepairLoops
            })
        const qualityRepairAttempts = manifest.qualityRepair?.attempts ?? 0
        const qualityRepairMissingEvidence = manifest.qualityRepair?.missingEvidence ?? []
        const turnPlan = [...baseTurnPlan]
        for (let repairAttempt = 1; repairAttempt <= qualityRepairAttempts; repairAttempt += 1) {
          turnPlan.push(...buildQualityRepairTurns(runId, repairAttempt, qualityRepairMissingEvidence))
        }
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
        const proofStore = new SupervisorProofStore(runtimePath)
        const [
          contributionReceipts,
          reviewReceipts,
          taskContracts,
          verificationReceipt
        ] = await Promise.all([
          proofStore.readContributionReceipts(runId),
          proofStore.readReviewReceipts(runId),
          proofStore.readTaskContracts(runId),
          proofStore.readLatestVerificationReceipt(runId)
        ])
        const requiredCollaborationEventIds = [...new Set([
          ...contributionReceipts.flatMap((receipt) => receipt.handoffEventIds),
          ...reviewReceipts.flatMap((receipt) => receipt.evidenceEventIds)
        ])]
        const collaborationProofEvents = await proofStore.readCollaborationProofEvents(
          runId,
          requiredCollaborationEventIds
        )
        tasks = mergeBoardWithTaskContracts(tasks, taskContracts)
        const qualityEvidenceEvents = mergeSupervisorEvidenceEvents(events, collaborationProofEvents)
        // The manifest field is only a restart cache. Re-establish verification
        // from supervisor-owned private proof so a stale or edited cache cannot
        // unlock current-revision collaboration evidence.
        const restoredVerifiedRevision = verificationReceipt?.outcome === 'passed' &&
          verificationReceipt.revision === manifest.evidence.appRevision
          ? verificationReceipt.revision
          : -1
        // Manifest agent sets are only a cache from older builds. Reconstruct
        // quality proof from revision-bound receipts so stale append-only flags
        // cannot survive a later edit or an interrupted upgrade.
        const survivingContributions = promotedSurvivingContributionReceipts(
          contributionReceipts,
          reviewReceipts,
          manifest.evidence.appRevision,
          manifest.git.appFingerprint,
          qualityEvidenceEvents,
          { independentlyVerified: restoredVerifiedRevision === manifest.evidence.appRevision }
        )
        const acceptedCodeAgents = new Set(survivingContributions.map((receipt) => receipt.agent))
        const acceptedReviewAgents = new Set(reviewReceipts
          .filter((receipt) => reviewAcceptsCurrentRevision(
            receipt,
            survivingContributions,
            manifest.evidence.appRevision,
            manifest.git.appFingerprint,
            qualityEvidenceEvents,
            {
              allowPromotedTarget: true,
              independentlyVerified: restoredVerifiedRevision === manifest.evidence.appRevision,
              reviewerTurnReceipts: contributionReceipts
            }
          ))
          .map((receipt) => receipt.reviewer))
        const interrupted = !revealReady && manifest.status !== 'paused' && !workspaceDrift
        const restoredReason = manifest.pause?.detailCode
        const supportedReasons = new Set<RunPauseSnapshot['reason']>([
          'provider-quota', 'usage-pressure', 'provider-auth', 'provider-unavailable', 'model-unavailable',
          'cli-incompatible', 'provider-protocol', 'session-lost', 'stage-timeout',
          'host-interrupted', 'workspace-drift', 'verification-failed', 'quality-repair', 'unknown'
        ])
        const reason = workspaceDrift
          ? 'workspace-drift' as const
          : interrupted
            ? 'host-interrupted' as const
            : supportedReasons.has(restoredReason as RunPauseSnapshot['reason'])
              ? restoredReason as RunPauseSnapshot['reason']
              : manifest.pause?.reason === 'other'
                ? 'unknown' as const
                : manifest.pause?.reason as RunPauseSnapshot['reason'] ?? 'unknown'
        const pausedAt = interrupted || workspaceDrift
          ? new Date().toISOString()
          : manifest.pause?.pausedAt ?? manifest.updatedAt
        const provider = manifest.pause?.agent
        const legacyPause = record(legacy.pause)
        const legacyResumable = typeof legacyPause.resumable === 'boolean'
          ? legacyPause.resumable
          : undefined
        const legacyPauseEvent = [...events].reverse().find((event) =>
          event.type === 'run.paused' && event.agent === 'director' && event.topic === reason &&
          event.metadata?.pauseReason === reason && typeof event.metadata.resumable === 'boolean'
        )
        const legacyEventResumable = typeof legacyPauseEvent?.metadata?.resumable === 'boolean'
          ? legacyPauseEvent.metadata.resumable
          : undefined
        // Host interruption and workspace adoption are always explicit recovery
        // checkpoints. Otherwise preserve the durable finality bit. Older
        // quality-repair manifests may consult the supervisor-owned run mirror;
        // if neither record has the bit, fail closed instead of reopening a paid
        // repair loop that may already have reached its stop condition.
        const restoredResumable = interrupted || workspaceDrift
          ? true
          : manifest.pause?.resumable ?? legacyEventResumable ?? legacyResumable ?? reason !== 'quality-repair'
        const pause: RunPauseSnapshot = {
          reason,
          ...(provider ? { provider } : {}),
          message: workspaceDrift
            ? 'Source changed after the last durable checkpoint, likely during a hard interruption. The current workspace was preserved for explicit adoption.'
            : interrupted
              ? 'Duo Chaos closed while this battle was active. The durable turn boundary was recovered.'
              : reason === 'provider-quota' || reason === 'usage-pressure'
              ? `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'A provider'} reached a usage boundary. The balanced battle remains preserved.`
              : reason === 'quality-repair'
                ? restoredResumable
                  ? 'The artifact is preserved and sealed. Reserved quality repair is waiting for explicit Resume.'
                  : 'The artifact is preserved and sealed. The quality-repair stop condition is final for this battle.'
                : 'The battle is preserved at a recoverable provider boundary.',
          pausedAt,
          ...(manifest.pause?.resetAt ? { resetAt: manifest.pause.resetAt } : {}),
          resumable: restoredResumable,
          round: activeRound,
          stage: manifest.cursor.stage,
          ...(reason === 'quality-repair' && qualityRepairMissingEvidence.length > 0
            ? { missingEvidence: qualityRepairMissingEvidence }
            : {}),
          action: workspaceDrift
            ? 'Review the preserved workspace, then Resume to adopt it as a new checkpoint and reverify before continuing.'
            : reason === 'provider-quota' || reason === 'usage-pressure'
              ? 'Resume when usage is available again.'
              : reason === 'quality-repair'
                ? restoredResumable
                  ? 'Resume the reserved quality-repair pair, or explicitly reveal the preserved partial artifact.'
                  : 'Reveal the preserved partial artifact, or return to the prompt. No additional provider call will run from this checkpoint.'
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
            source: 'studio',
            customizationProfile: manifest.request.claudeCustomizationProfile ?? 'core',
            qualityCeiling: manifest.loadout.claude.requestedEffort ?? manifest.loadout.claude.resolvedEffort ?? 'default'
          },
          codex: {
            ...(manifest.loadout.codex.resolvedModel ? { model: manifest.loadout.codex.resolvedModel } : {}),
            ...(codexEffort ? { effort: codexEffort } : {}),
            source: 'studio',
            customizationProfile: manifest.request.codexCustomizationProfile ?? 'core',
            qualityCeiling: manifest.loadout.codex.requestedEffort ?? manifest.loadout.codex.resolvedEffort ?? 'default'
          }
        }
        const request: StartRunRequest = {
          ...manifest.request,
          codexModel: manifest.loadout.codex.requestedModel ?? manifest.loadout.codex.resolvedModel ?? '',
          codexEffort: (manifest.loadout.codex.requestedEffort ?? manifest.loadout.codex.resolvedEffort ?? 'default') as CodexEffort,
          claudeModel: manifest.loadout.claude.requestedModel ?? manifest.loadout.claude.resolvedModel ?? '',
          claudeEffort: (manifest.loadout.claude.requestedEffort ?? manifest.loadout.claude.resolvedEffort ?? 'default') as AgentEffort,
          workspaceRoot: dirname(workspacePath),
          dangerousModeConfirmed: false,
          unsafeWorkspaceRootConfirmed: false
        }
        const restoredTurnStage = !revealReady && manifest.cursor.stageReceipt
          ? {
              ...manifest.cursor.stageReceipt,
              status: 'paused' as const,
              // App downtime is not provider thinking time. Restore the exact
              // remaining active lease instead of either expiring it offline
              // or silently granting a brand-new full stage.
              deadlineAt: new Date(this.nowMs() + manifest.timing.remainingLeaseMs).toISOString()
            }
          : undefined
        const session: RunSession = {
          request,
          settings: settingsForPinnedRun(settings, request),
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
            ...(manifest.usageGuard ? { usageGuard: manifest.usageGuard } : {}),
            ...(legacy.releaseStatus === 'ready' || legacy.releaseStatus === 'partial' || legacy.releaseStatus === 'failed'
              ? { releaseStatus: legacy.releaseStatus }
              : {}),
            ...(!revealReady ? { pause } : {}),
            ...(restoredTurnStage ? { turnStage: restoredTurnStage } : {}),
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
          acceptedCodeAgents,
          acceptedReviewAgents,
          qualityBrief: compileQualityBrief({
            humanBrief: manifest.request.prompt,
            missionProfile: manifest.request.missionProfile
          }),
          proofStore,
          taskContracts,
          contributionReceipts,
          reviewReceipts,
          collaborationProofEvents,
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
          verifiedAppEvidenceRevision: restoredVerifiedRevision,
          ...(manifest.git.head ? { gitHead: manifest.git.head } : {}),
          ...(manifest.git.appFingerprint ? { appFingerprint: manifest.git.appFingerprint } : {}),
          quotaConstrainedAgents: new Set(!revealReady && provider ? [provider] : []),
          providerPressure: {},
          workLeaseContinuations: new Map(restoredTurnStage?.continuationCount
            ? [[`${restoredTurnStage.turnId}:work`, restoredTurnStage.continuationCount]]
            : []),
          qualityRepairAttempts,
          qualityRepairMissingEvidence,
          retries: [...manifest.retries]
        }
        this.sessions.set(runId, session)
        await this.loadRedactionDictionary(session)
        if (!revealReady && reason === 'quality-repair') {
          const partialPacket = await this.readExistingRevealPacket(session)
          if (partialPacket?.status !== 'partial') {
            this.sessions.delete(runId)
            continue
          }
          session.privateRevealPacket = partialPacket
          session.snapshot.releaseStatus = 'partial'
        }
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
        } else if (interrupted || workspaceDrift) {
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

  async revealPartial(runId: string): Promise<RunSnapshot> {
    const session = this.requireSession(runId)
    if (
      session.snapshot.status !== 'paused' ||
      session.snapshot.pause?.reason === 'workspace-drift' ||
      session.qualityRepairAttempts < 1 ||
      session.privateRevealPacket?.status !== 'partial'
    ) {
      throw new Error('No repairable partial artifact is waiting for explicit reveal.')
    }
    session.revealed = true
    this.freezeActiveClock(session)
    session.snapshot.status = 'complete'
    session.snapshot.phase = 'complete'
    session.snapshot.releaseStatus = 'partial'
    session.snapshot.pause = undefined
    session.snapshot.finishedAt = new Date().toISOString()
    session.snapshot.activeAgent = undefined
    await this.emitEvent(session, createDirectorEvent(
      session,
      'run.completed',
      'The preserved partial artifact was revealed by explicit user choice. Its recorded caveats remain attached.',
      { severity: 'medium', spoilerRisk: 1, topic: 'partial-reveal-accepted' }
    ))
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
      verifiedAppEvidenceRevision: session.verifiedAppEvidenceRevision,
      qualityRepairAttempts: session.qualityRepairAttempts,
      qualityRepairMissingEvidence: session.qualityRepairMissingEvidence,
      retries: session.retries
    })
    if (signature === session.lastStateSignature) return
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
    session.lastStateSignature = signature
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
        customizationProfile: customizationFor(session.request, agent),
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
        runTimeoutSeconds: session.request.runTimeoutSeconds,
        codexCustomizationProfile: customizationFor(session.request, 'codex'),
        claudeCustomizationProfile: customizationFor(session.request, 'claude'),
        trustedLocalCapabilitiesConfirmed: session.request.trustedLocalCapabilitiesConfirmed ?? false,
        qualityRoutingProfile: session.request.qualityRoutingProfile ?? 'balanced',
        workInferenceLimit: session.request.workInferenceLimit ?? session.request.claudeWorkInferenceLimit ?? 8,
        // Keep the legacy alias in durable manifests while older Duo builds may
        // still be asked to resume this exact workspace. New settings and new
        // runtime policy use the provider-neutral key above.
        claudeWorkInferenceLimit: session.request.workInferenceLimit ?? session.request.claudeWorkInferenceLimit ?? 8
      },
      loadout: { claude: loadout('claude'), codex: loadout('codex') },
      capabilities: { claude: capability('claude'), codex: capability('codex') },
      cursor: {
        turnIndex: session.activeTurnIndex,
        stage: cursorStage,
        attempt: session.snapshot.turnStage?.attempt ?? 1,
        idempotencyKey: `${session.snapshot.runId}:${String(session.activeTurnIndex)}:${cursorStage}`,
        ...(session.resumeRecoveryOriginStage ? { recoveryOriginStage: session.resumeRecoveryOriginStage } : {}),
        ...(session.resumeRecoveryReasons?.length ? { recoveryReasons: session.resumeRecoveryReasons } : {}),
        ...(session.snapshot.turnStage ? { stageReceipt: session.snapshot.turnStage } : {})
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
      ...(session.snapshot.usageGuard ? { usageGuard: session.snapshot.usageGuard } : {}),
      retries: [...session.retries],
      ...(session.qualityRepairAttempts > 0
        ? {
            qualityRepair: {
              attempts: session.qualityRepairAttempts,
              missingEvidence: session.qualityRepairMissingEvidence
            }
          }
        : {}),
      ...(session.snapshot.pause && pauseReason
        ? {
            pause: {
              reason: allowedPauseReason.has(pauseReason)
                ? pauseReason as 'provider-quota' | 'provider-auth' | 'provider-unavailable' | 'host-interrupted' | 'cli-incompatible' | 'workspace-drift'
                : 'other' as const,
              ...(session.snapshot.pause.provider ? { agent: session.snapshot.pause.provider } : {}),
              pausedAt: session.snapshot.pause.pausedAt,
              ...(session.snapshot.pause.resetAt ? { resetAt: session.snapshot.pause.resetAt } : {}),
              resumable: session.snapshot.pause.resumable,
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
      let recoveredWorkResult: ExecutedTurnStage | undefined
      if (restoredStage === 'recovery') {
        const preservedRecoveryReceipt = session.snapshot.turnStage
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
        if (recoveryOrigin === 'work') {
          recoveredWorkResult = {
            assessment: { accepted: true, outcome: 'accepted', reasons: [] },
            durableSourceChanged: preservedRecoveryReceipt?.durableSourceChanged ?? false
          }
        }
        session.resumeRecoveryOriginStage = undefined
        session.resumeRecoveryReasons = undefined
        await this.persistRunState(session)
        continuationStage = recoveryOrigin === 'opening'
          ? 'work'
          : recoveryOrigin === 'work'
            ? session.planVersion === 'lean-collaboration-v2' ? 'turn-complete' : 'verdict'
            : 'turn-complete'
      }
      let providerSessionId: string | undefined
      if (stagedWork && session.planVersion === 'lean-collaboration-v2') {
        const preservedReceipt = resuming && continuationStage === 'work'
          ? session.snapshot.turnStage
          : undefined
        const canReusePreservedWork = preservedReceipt?.turnId === turn.id &&
          preservedReceipt.durableSourceChanged === true &&
          preservedReceipt.evidenceFingerprint !== undefined &&
          preservedReceipt.evidenceFingerprint === session.appFingerprint
        const executedWork = recoveredWorkResult ?? (canReusePreservedWork
          ? {
              assessment: { accepted: true, outcome: 'accepted' as const, reasons: [] },
              durableSourceChanged: true
            }
          : continuationStage === 'turn-complete'
            ? undefined
            : await this.executeTurnStage(session, git, turn, index + 1, 'work'))
        if (!executedWork) {
          throw new Error('A completed lean work turn is missing its preserved stage result.')
        }
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
        const work = canReusePreservedWork || recoveredWorkResult
          ? executedWork
          : await this.resolveStageOutcome(session, git, turn, index + 1, 'work', executedWork)
        // Revision-bound contribution and reciprocal-review sets are refreshed
        // inside executeTurnStage. Never append agent flags here: a later edit
        // must be able to invalidate stale final-review evidence.
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
          const resolvedWork = await this.resolveStageOutcome(session, git, turn, index + 1, 'work', work)
          if (resolvedWork.assessment.outcome === 'timeboxed') {
            providerSessionId = undefined
            delete session.providerSessions[turn.agent]
          }
          // executeTurnStage reconstructed the current-revision proof sets.
          // Legacy manifests may still cache these arrays, but they no longer
          // grant quality credit without typed receipts.
          const checkpoint = await this.requireGitCheckpoint(
            session,
            git,
            `chore(duo): checkpoint round ${String(index + 1)} ${turn.agent} ${turn.kind}${resolvedWork.assessment.outcome === 'timeboxed' ? ' timeboxed' : ''}`,
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
    if (session.snapshot.usageGuard?.status === 'pending') {
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        'The final provider call crossed a soft usage boundary, but no later premium call is needed. The release flow continues without an unnecessary pause.',
        {
          severity: 'low',
          topic: 'provider-usage-guard-cleared',
          metadata: {
            agent: session.snapshot.usageGuard.agent,
            callId: session.snapshot.usageGuard.callId,
            reasons: session.snapshot.usageGuard.reasons
          }
        }
      ))
      session.snapshot.usageGuard = undefined
    }
    if (runCeilingReached) {
      await this.emitEvent(
        session,
        createDirectorEvent(session, 'decision', 'The overall run ceiling was reached. Durable work is preserved and the best available reveal packet will be prepared.', {
          severity: 'high', topic: 'run-ceiling', metadata: { runTimeoutSeconds: session.request.runTimeoutSeconds }
        })
      )
      if (!this.runIsActive(session)) return
    }

    const finalArtifactEvidence = await inspectWorkspaceRevealEvidence(
      session.workspace,
      session.snapshot.tasks,
      session.snapshot.events,
      this.hasCurrentVerification(session)
    )
    // Artifact correctness and collaboration quality are separate facts. Even
    // when one agent missed an owned task or reciprocal review, independently
    // verify the exact final source so the reveal can report the artifact's
    // health truthfully instead of hiding useful proof behind a duo-quality gate.
    if (finalArtifactEvidence.hasRunnableArtifact) {
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
    const missingEvidence = await this.missingReadyEvidence(session, finalArtifactEvidence)
    if (packet.status === 'partial' && missingEvidence.length > 0) {
      const repairDecision = decideQualityRepair({
        completedAttempts: session.qualityRepairAttempts,
        maximumAttempts: session.request.maxRepairLoops,
        previousMissingEvidence: session.qualityRepairMissingEvidence,
        currentMissingEvidence: missingEvidence
      })
      if (!repairDecision.reservePair) {
        session.qualityRepairMissingEvidence = missingEvidence
        session.snapshot.releaseStatus = 'partial'
        session.snapshot.phase = 'round.repair'
        await this.pauseSession(session, {
          reason: 'quality-repair',
          message: repairDecision.reason === 'attempt-limit'
            ? 'The configured quality-repair limit was reached. The preserved artifact remains available with honest caveats.'
            : 'A complete repair pair produced no new release evidence. Duo stopped the paid retry loop and preserved the artifact with honest caveats.',
          resumable: false,
          missingEvidence,
          action: 'Reveal the preserved partial artifact, or return to the prompt and start a revised battle. No additional provider call will run from this checkpoint.'
        })
        return
      }
      const attempt = session.qualityRepairAttempts + 1
      session.qualityRepairAttempts = attempt
      session.qualityRepairMissingEvidence = missingEvidence
      session.turnPlan.push(...buildQualityRepairTurns(
        session.snapshot.runId,
        attempt,
        missingEvidence
      ))
      session.snapshot.totalTurns = session.turnPlan.length
      session.snapshot.releaseStatus = 'partial'
      session.snapshot.phase = 'round.repair'
      await this.requireGitCheckpoint(session, git, `chore(duo): reserve quality repair ${String(attempt)}`)
      await this.pauseSession(session, {
        reason: 'quality-repair',
        message: 'The artifact is preserved and sealed, but the supervisor still needs release evidence before it can call the build ready.',
        resumable: true,
        stage: 'work',
        missingEvidence,
        action: 'Resume the reserved repair and reciprocal review pair. You can explicitly reveal the partial artifact instead, but that ends this battle with caveats.'
      })
      return
    }
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
      recoverySeconds: 600,
      runTimeoutSeconds: session.request.runTimeoutSeconds
    }
  }

  private stageEffortDecision(session: RunSession, turn: RealTurn, stage: TurnStageName) {
    const selected = turn.agent === 'codex'
      ? session.request.codexEffort ?? session.settings.codexEffort
      : session.request.claudeEffort ?? session.settings.claudeEffort
    return resolveStageEffortDecision({
      agent: turn.agent,
      selected,
      stage,
      turnKind: turn.kind,
      phase: turn.phase,
      qualityRouting: session.request.qualityRoutingProfile ?? 'balanced'
    })
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
    await restoreSupervisorWorkspacePolicy(
      session.workspace,
      session.request.missionProfile ?? 'surprise'
    )
    const pendingUsageGuard = session.snapshot.usageGuard
    if (pendingUsageGuard?.status === 'pending') {
      await this.requireGitCheckpoint(
        session,
        git,
        `chore(duo): checkpoint ${pendingUsageGuard.agent} usage boundary`,
        { stage, provider: pendingUsageGuard.agent }
      )
      await this.persistRunState(session)
      const measured = pendingUsageGuard.totals
      const exactDetail = measured
        ? `The completed call reported ${String(measured.processedInputTokens)} processed input, ${String(measured.cachedInputTokens)} cached input, ${String(measured.outputTokens)} output, and ${String(measured.reasoningTokens)} reasoning tokens.${pendingUsageGuard.effectiveInputTokens === undefined ? '' : ` Cache-weighted input pressure was ${String(pendingUsageGuard.effectiveInputTokens)} tokens.`}`
        : pendingUsageGuard.utilization !== undefined
          ? `The provider reported ${String(Math.round(pendingUsageGuard.utilization * 100))}% utilization.`
          : 'The provider reported usage pressure.'
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        `${exactDetail} Productive work was checkpointed and the battle is continuing automatically.`,
        {
          severity: 'medium',
          topic: 'provider-usage-advisory',
          metadata: {
            agent: pendingUsageGuard.agent,
            callId: pendingUsageGuard.callId,
            reasons: pendingUsageGuard.reasons,
            action: 'continue-after-checkpoint'
          }
        }
      ))
      session.snapshot.usageGuard = undefined
      await this.persistRunState(session)
    }
    if (pendingUsageGuard?.status === 'acknowledged') {
      // An explicit Resume spends this one-shot acknowledgement. A new guard
      // may be recorded from the fresh call, but this receipt cannot pause the
      // same capsule forever.
      session.snapshot.usageGuard = undefined
      await this.persistRunState(session)
    }
    const priorStageReceipt = session.snapshot.turnStage
    const sameStageReceipt = priorStageReceipt?.turnId === turn.id && priorStageReceipt.stage === stage
      ? priorStageReceipt
      : undefined
    const carriedWorkReceipt = stage === 'recovery' && recoveryOriginStage === 'work' && priorStageReceipt?.turnId === turn.id
      ? priorStageReceipt
      : sameStageReceipt
    const inferenceLimit = session.request.workInferenceLimit ?? session.request.claudeWorkInferenceLimit ?? 8
    const spentContinuations = sameStageReceipt?.continuationCount ??
      session.workLeaseContinuations.get(`${turn.id}:work`) ?? 0
    const resumeStartsFreshCapsule = stage === 'work' &&
      session.resumeStage === 'work' &&
      (sameStageReceipt?.inferenceSteps ?? 0) >= inferenceLimit &&
      spentContinuations < 1
    const continuationCount = spentContinuations + (resumeStartsFreshCapsule ? 1 : 0)
    if (resumeStartsFreshCapsule) {
      session.workLeaseContinuations.set(`${turn.id}:work`, continuationCount)
    }
    const initialInferenceSteps = resumeStartsFreshCapsule ? 0 : sameStageReceipt?.inferenceSteps ?? 0
    const policy = this.stagePolicy(session)
    const restoredStageSeconds = sameStageReceipt && session.resumeStage === stage
      ? resolveResumeStageLeaseSeconds(
          stage,
          remainingStageLeaseSeconds(sameStageReceipt.deadlineAt, this.nowMs()),
          policy
        )
      : undefined
    const budgetSeconds = resolveStageBudgetSeconds(
      stage,
      policy,
      this.remainingRunSeconds(session),
      restoredStageSeconds
    )
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
    const durableVerification = await session.proofStore.readLatestVerificationReceipt(session.snapshot.runId)
    const latestVerificationEvent = durableVerification
      ? undefined
      : [...session.snapshot.events].reverse().find((event) =>
          (event.type === 'build.failed' || event.type === 'build.passed') &&
          event.topic === 'supervisor-verification'
        )
    const verificationEvidence = durableVerification ?? (latestVerificationEvent
      ? {
          summary: latestVerificationEvent.privateText ?? latestVerificationEvent.publicText,
          checks: (Array.isArray(latestVerificationEvent.metadata?.checks)
            ? latestVerificationEvent.metadata.checks
            : []).flatMap((value) => {
              const check = record(value)
              return typeof check.id === 'string' && typeof check.outcome === 'string'
                ? [{
                    id: check.id,
                    outcome: check.outcome,
                    ...(typeof check.label === 'string' ? { label: check.label } : {}),
                    ...(typeof check.detail === 'string' ? { detail: check.detail } : {})
                  }]
                : []
            })
        }
      : undefined)
    const latestVerificationDigest = verificationEvidence
      ? buildVerificationDigest({
          summary: verificationEvidence.summary,
          checks: verificationEvidence.checks,
          constraints: session.qualityBrief.privateContract.hardConstraints.map((constraint) => ({
            id: constraint.id,
            sourceText: constraint.sourceText
          }))
        })
      : undefined
    const relevantDecisionDelta = session.snapshot.events
      .filter((event) => event.type === 'decision')
      .slice(-3)
      .map((event) => event.privateText ?? event.publicText)
    const previousContribution = session.contributionReceipts.at(-1)
    const contextBaton = stage === 'work'
      ? await buildContextBaton({
          workspacePath: session.workspace.workspacePath,
          agent: turn.agent,
          mission: turn.goal,
          tasks: session.snapshot.tasks.map((task) => ({
            id: task.id,
            title: task.privateTitle ?? task.publicTitle,
            status: task.status,
            ...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
            files: task.privateFiles ?? task.files
          })),
          ...(latestVerificationDigest ? { verificationDigest: latestVerificationDigest } : {}),
          ...(relevantDecisionDelta.length ? { decisionDelta: relevantDecisionDelta } : {}),
          opponentPosition: latestStatement,
          ...(previousContribution
            ? {
                contributionReceipt: `${previousContribution.agent} ${previousContribution.status}; ${String(previousContribution.fileCount)} files; verification ${previousContribution.verification}; remaining ${previousContribution.unresolvedRisks.join(', ') || 'none'}`
              }
            : {})
        })
      : undefined
    const capabilitySelection = selectTurnCapabilities({
      mission: session.request.missionProfile ?? 'surprise',
      stage,
      turnKind: turn.kind,
      profile: stage === 'work' ? customizationFor(session.request, turn.agent) : 'core',
      task: `${session.request.prompt}\n${turn.goal}`,
      ...(contextBaton
        ? { stack: [...new Set(contextBaton.match(/\b(?:typescript|tsx|react|vite|electron|html|css|javascript)\b/giu)?.map((value) => value.toLowerCase()) ?? [])] }
        : {})
    })
    const pitchCatalog = structuredDialogueStage && turn.phase === 'round.consensus'
      ? (await session.proofStore.readPitches(session.snapshot.runId)).map((pitch) => ({
          pitchId: pitch.pitchId,
          agent: pitch.agent,
          title: pitch.title
        }))
      : undefined
    const postConsensusSourceContext = turn.kind === 'code' || turn.kind === 'review' ||
      turn.kind === 'verify' || turn.kind === 'repair'
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
      ...(contextBaton ? { contextBaton } : {}),
      ...(pitchCatalog?.length ? { pitchCatalog } : {}),
      capabilityShortlist: capabilitySelection.promptContract,
      ...(postConsensusSourceContext
        ? {
            briefReference: `The exact human brief and acceptance plan are sealed in .duo/sealed/quality_brief.json and .duo/sealed/spec.md under fingerprint ${session.qualityBrief.fingerprint}.`,
            qualityBaton: formatQualityBriefBatonForAgent(session.qualityBrief)
          }
        : { qualityContract: formatQualityBriefForAgent(session.qualityBrief) }),
      ...(stage === 'work'
        ? { customizationProfile: customizationFor(session.request, turn.agent) }
        : {}),
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
      // Quality-per-token work calls are intentionally self-contained. They
      // receive the compact durable baton and must never replay a growing CLI
      // session transcript, including after a paused run is resumed.
      sessionId = undefined
      commandSession = undefined
      delete session.providerSessions[turn.agent]
    } else if ((stage === 'opening' || stage === 'work') && durableProviderSession) {
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

    const effortDecision = this.stageEffortDecision(session, turn, stage)
    const effort = effortDecision.requested
    const buildCommand = (
      selectedSession: { mode: 'start'; id?: string } | { mode: 'resume'; id: string } | undefined
    ) => turn.agent === 'codex'
      ? buildAgentCommand({
          agent: 'codex',
          binary: session.settings.codexPath,
          model: session.request.codexModel ?? session.settings.codexModel,
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
            ? {
                sourcePolicy: {
                  toolPolicy: 'workspace-essential' as const,
                  customizationProfile: customizationFor(session.request, 'codex')
                }
              }
            : {}),
          ...(selectedSession ? { session: selectedSession } : {})
        })
      : buildAgentCommand({
          agent: 'claude',
          binary: session.settings.claudePath,
          model: session.request.claudeModel ?? session.settings.claudeModel,
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
            ? {
                sourcePolicy: {
                  toolPolicy: 'workspace-essential' as const,
                  customizationProfile: customizationFor(session.request, 'claude')
                }
              }
            : {}),
          ...(selectedSession ? { session: selectedSession } : {})
        })
    let command = buildCommand(commandSession)

    const startedAt = new Date()
    const nextAgent = session.turnPlan[session.activeTurnIndex + 1]?.agent
    session.snapshot.turnStage = {
      turnId: turn.id,
      agent: turn.agent,
      kind: turn.kind,
      stage,
      status: 'running',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + budgetSeconds * 1_000).toISOString(),
      attempt: sameStageReceipt?.attempt ?? 1,
      effort,
      qualityCeiling: turn.agent === 'claude'
        ? session.request.claudeEffort ?? session.settings.claudeEffort
        : session.request.codexEffort ?? session.settings.codexEffort,
      ...(stage === 'work' ? { customizationProfile: customizationFor(session.request, turn.agent) } : {}),
      ...(stage === 'work'
        ? { inferenceLimit, inferenceSteps: initialInferenceSteps, continuationCount }
        : {}),
      ...(nextAgent ? { nextAgent } : {}),
      ...(carriedWorkReceipt?.durableSourceChanged
        ? {
            durableSourceChanged: true,
            ...(carriedWorkReceipt.evidenceFingerprint
              ? { evidenceFingerprint: carriedWorkReceipt.evidenceFingerprint }
              : {})
          }
        : {}),
      ...(carriedWorkReceipt?.durableWorkEvidence
        ? {
            durableWorkEvidence: true,
            ...(carriedWorkReceipt.evidenceFingerprint
              ? { evidenceFingerprint: carriedWorkReceipt.evidenceFingerprint }
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
          metadata: {
            phase: turn.phase,
            kind: turn.kind,
            stage,
            budgetSeconds,
            effortTarget: effortDecision.target,
            effortRequested: effortDecision.requested,
            effortReason: effortDecision.reason,
            capabilities: capabilitySelection.selected.map((item) => ({
              id: item.id,
              kind: item.kind,
              disposition: item.disposition
            }))
          }
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
    const appRevisionBefore = session.appEvidenceRevision
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
    let lastVerificationOutcome: { sequence: number; outcome: 'passed' | 'failed' } | undefined
    const stageProviderRecords: ProviderRecord[] = []
    const stageProviderText: string[] = []
    const undecodedStdoutText: string[] = []
    const stdoutFragments: string[] = []
    let stdoutFragmentBytes = 0
    let reassembledProviderEnvelope = false
    const workLeaseGuard = stage === 'work'
      ? new WorkLeaseGuard(inferenceLimit, { agent: turn.agent, initialInferenceSteps })
      : undefined
    let leaseTimeboxRequested = false
    let leaseFinalizationAnnounced = false
    let activeProcessId: string | undefined
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
      if (workLeaseGuard && decoded.length > 0) {
        const lease = workLeaseGuard.observe(decoded)
        if (session.snapshot.turnStage?.turnId === turn.id) {
          session.snapshot.turnStage = {
            ...session.snapshot.turnStage,
            inferenceSteps: lease.inferenceSteps
          }
        }
        if (lease.recommendation === 'request-finalization' && !leaseFinalizationAnnounced) {
          leaseFinalizationAnnounced = true
          this.enqueueEvent(session, createDirectorEvent(
            session,
            'decision',
            `${agentName} crossed the soft work budget while still making progress. The lease stays open for task closure, verification, and a concise handoff.`,
            {
              agent: turn.agent,
              severity: 'medium',
              topic: 'work-finalization-requested',
              metadata: {
                inferenceSteps: lease.inferenceSteps,
                progressBoundaries: lease.progressBoundaries,
                pendingTools: lease.pendingTools
              }
            }
          ))
        }
        if (lease.shouldTimebox && !leaseTimeboxRequested && activeProcessId && this.processRunner.cancel) {
          leaseTimeboxRequested = true
          void this.processRunner.cancel(activeProcessId, 'lease')
        }
      }
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
      if (quota?.status === 'allowed_warning' && (quota.utilization ?? 0) >= 0.82) {
        session.providerPressure[turn.agent] = quota
        session.snapshot.usageGuard = {
          status: 'pending',
          agent: turn.agent,
          callId: activeProcessId ?? `${session.snapshot.runId}-${turn.id}-${stage}`,
          trigger: 'provider-warning',
          reasons: ['provider-pressure'],
          triggeredAt: new Date().toISOString(),
          ...(quota.utilization !== undefined ? { utilization: quota.utilization } : {}),
          ...(quota.resetAt ? { resetAt: quota.resetAt } : {})
        }
      }
      if (quota?.status === 'rejected') {
        quotaRejected = true
        quotaRateLimitType = quota.rateLimitType
        quotaResetAt = quota.resetAt
      }
      const extractedCapsule = structuredDialogue
        ? extractDialogueCapsuleFromCliLine(turn.agent, line, { kind: turn.kind, phase: turn.phase })
        : undefined
      if (extractedCapsule) dialogueCapsule = extractedCapsule
      const extractedRecoveryCapsule = structuredRecovery
        ? extractRecoveryCapsuleFromCliLine(turn.agent, line)
        : undefined
      if (extractedRecoveryCapsule) recoveryCapsule = extractedRecoveryCapsule
      if (session.usageTracker.ingest(turn.agent, line, stream === 'stdout', activeProcessId)) this.publishSnapshot(session)
      const context = { runId: session.snapshot.runId, round, source: turn.agent, stream }
      const log = normalizeCliLine(line, context)
      if (activityBudget.accept(log)) this.enqueueEvent(session, log)
      const activity = normalizeCliActivity(line, context, cliActivityState)
      if (activity?.category === 'file') lastRecordedFileSequence = lineSequence
      if (activity?.metadata?.verificationPassed === true) {
        lastVerificationOutcome = { sequence: lineSequence, outcome: 'passed' }
      } else if (activity?.metadata?.verificationFailed === true) {
        lastVerificationOutcome = { sequence: lineSequence, outcome: 'failed' }
      }
      if (structuredOutput && containsStructuredWorkspaceActivity(decoded, structuredOutputSchema)) {
        structuredToolActivity = true
      }
      if (activity && activityBudget.accept(activity)) this.enqueueEvent(session, activity)
    }
    const applyCompletedCallUsage = async (callId: string): Promise<void> => {
      const receipt = session.usageTracker.evidenceSnapshot().calls.find((candidate) => candidate.id === callId)
      const usageDecision = receipt ? evaluateCompletedCallUsage(receipt) : undefined
      if (!usageDecision) return
      session.snapshot.usageGuard = {
        status: 'pending',
        agent: usageDecision.agent,
        callId: usageDecision.callId,
        trigger: 'completed-call-usage',
        reasons: usageDecision.reasons,
        triggeredAt: new Date().toISOString(),
        effectiveInputTokens: usageDecision.effectiveInputTokens,
        totals: {
          processedInputTokens: usageDecision.totals.processedInputTokens,
          cachedInputTokens: usageDecision.totals.cachedInputTokens,
          outputTokens: usageDecision.totals.outputTokens,
          reasoningTokens: usageDecision.totals.reasoningTokens,
          calls: usageDecision.totals.calls
        },
        limits: { ...usageDecision.limits }
      }
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        `${agentName}'s completed call crossed a soft usage advisory. The exact work remains accepted; Duo will checkpoint before another premium call and continue automatically.`,
        {
          agent: turn.agent,
          severity: 'medium',
          topic: 'provider-usage-guard',
          metadata: {
            agent: usageDecision.agent,
            callId: usageDecision.callId,
            reasons: usageDecision.reasons,
            totals: usageDecision.totals,
            limits: usageDecision.limits,
            action: 'continue-after-checkpoint'
          }
        }
      ))
    }
    const runProcess = async (suffix: string, timeoutSeconds: number): Promise<ProcessRunResult> => {
      activeProcessId = `${session.snapshot.runId}-${turn.id}-${stage}${suffix}`
      const callId = activeProcessId
      session.usageTracker.beginCall(turn.agent, callId)
      try {
        const processResult = await this.processRunner.run({
          id: callId,
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
        session.usageTracker.finishCall(
          turn.agent,
          callId,
          processResult.timedOut
            ? 'timed-out'
            : processResult.cancelled
              ? 'cancelled'
              : processResult.exitCode === 0
                ? 'complete'
                : 'failed'
        )
        await applyCompletedCallUsage(callId)
        return processResult
      } catch (error) {
        session.usageTracker.finishCall(turn.agent, callId, 'failed')
        throw error
      }
    }
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
        dialogueCapsule = extractDialogueCapsuleFromCliLine(
          turn.agent,
          replayEnvelope,
          { kind: turn.kind, phase: turn.phase }
        )
      }
      if (structuredRecovery && !recoveryCapsule) {
        recoveryCapsule = extractRecoveryCapsuleFromCliLine(turn.agent, replayEnvelope)
      }
      if (structuredOutput && containsStructuredWorkspaceActivity(replayRecords, structuredOutputSchema)) {
        structuredToolActivity = true
      }
      if (session.usageTracker.ingest(turn.agent, replayEnvelope, true, activeProcessId)) this.publishSnapshot(session)
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
      await restoreSupervisorWorkspacePolicy(
        session.workspace,
        session.request.missionProfile ?? 'surprise'
      )
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
    let rejectedDialogueReason: string | undefined
    let rejectedRecoveryContract = false
    let acceptedDialogueContract = false
    let acceptedRecoveryContract = false
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
        let supervisorProvenance: ConsensusProvenanceRecord | undefined
        if (validatedCapsule.consensus) {
          const immutablePitches = await session.proofStore.readPitches(session.snapshot.runId)
          supervisorProvenance = resolveConsensusProvenance({
            runId: session.snapshot.runId,
            appName: validatedCapsule.consensus.appName,
            humanBrief: session.request.prompt,
            qualityBriefFingerprint: session.qualityBrief.fingerprint,
            selectedSourcePitchIds: validatedCapsule.consensus.sourcePitchIds,
            pitches: immutablePitches
          })
          if (!supervisorProvenance || !validateConsensusProvenance({
            record: supervisorProvenance,
            runId: session.snapshot.runId,
            humanBrief: session.request.prompt,
            qualityBriefFingerprint: session.qualityBrief.fingerprint,
            immutablePitches
          })) {
            throw new DialogueCapsuleError(
              'The consensus must resolve to the exact supervisor-recorded pitch provenance for this run.'
            )
          }
        }
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
        acceptedDialogueContract = true
        for (const [index, pitch] of validatedCapsule.pitches.entries()) {
          const record: PitchProvenanceRecord = {
            pitchId: createPitchProvenanceId({
              runId: session.snapshot.runId,
              round,
              agent: turn.agent,
              index,
              title: pitch.title,
              idea: pitch.idea
            }),
            runId: session.snapshot.runId,
            round,
            agent: turn.agent,
            ...pitch
          }
          await session.proofStore.appendPitch(record)
        }
        if (supervisorProvenance) {
          const contracts = normalizeBoard({ tasks: validatedCapsule.tasks })
          await Promise.all([
            session.proofStore.writeConsensusProvenance(supervisorProvenance),
            session.proofStore.writeTaskContracts(session.snapshot.runId, contracts)
          ])
          session.taskContracts = contracts
        }
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
        rejectedDialogueReason = dialogueRecoveryReason(error)
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
        acceptedRecoveryContract = true
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
          {
            severity: 'high',
            topic: 'dialogue-contract-rejected',
            metadata: { stage, kind: turn.kind, reason: rejectedDialogueReason ?? 'invalid-dialogue-contract' }
          }
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
        ...(providerFailure ? { failure: providerFailure } : {}),
        ...(leaseTimeboxRequested ? { leaseTimeboxed: true } : {})
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
      streamedVerification: streamedVerificationForRevision
    })
    if ((durableWorkEvidence || durableSourceChanged) && appStateAfter && session.snapshot.turnStage) {
      session.snapshot.turnStage = {
        ...session.snapshot.turnStage,
        ...(durableWorkEvidence ? { durableWorkEvidence: true } : {}),
        ...(durableSourceChanged ? { durableSourceChanged: true } : {}),
        evidenceFingerprint: appStateAfter
      }
    }
    const opponentAgent = turn.agent === 'claude' ? 'codex' : 'claude'
    const opponentHasAcceptedContribution = session.acceptedCodeAgents.has(opponentAgent)
    const recordedStructuredContract = acceptedDialogueContract || acceptedRecoveryContract
    const expectedStructuredMaxTurnClosure = recordedStructuredContract && !quotaRejected &&
      providerFailure?.kind === 'cli-incompatible' && providerFailure.source === 'process' &&
      isExpectedClaudeStructuredMaxTurnClosure(turn.agent, stageProviderRecords, result)
    if (expectedStructuredMaxTurnClosure && activeProcessId) {
      // Claude may close a deliberately one-turn structured call with
      // error_max_turns even though its single strict StructuredOutput tool
      // payload was accepted. Reconcile only that exact canonical closure;
      // output-limit, raw-log, timeout, host, and generic CLI failures remain
      // real safety boundaries.
      session.usageTracker.finishCall(turn.agent, activeProcessId, 'complete')
      await applyCompletedCallUsage(activeProcessId)
    }
    const acceptedStructuredContract = recordedStructuredContract && !quotaRejected &&
      (!providerFailure || expectedStructuredMaxTurnClosure)
    const effectiveProviderFailure = expectedStructuredMaxTurnClosure ? undefined : providerFailure
    const acceptanceResult = acceptedStructuredContract || effectiveProviderFailure?.kind === 'contract-invalid'
      ? { ...result, exitCode: 0, signal: null, timedOut: false, cancelled: false }
      : result
    const assessedTurn = assessTurnAcceptance({
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
    const assessment: TurnAcceptance = quotaRejected
      ? { accepted: false, outcome: 'timeboxed', reasons: ['provider-quota-rejected'] }
      : rejectedDialogueContract
        ? {
            accepted: false,
            outcome: 'recovery-required',
            reasons: [
              rejectedDialogueReason ?? 'invalid-dialogue-contract',
              ...assessedTurn.reasons.filter((reason) => reason !== rejectedDialogueReason)
            ]
          }
        : assessedTurn
    let contributionReceipt: ContributionReceipt | undefined
    if (stage === 'work') {
      const diff = await git.summarizeAppChanges(session.workspace.workspacePath)
      const qualityEvidenceEvents = this.qualityEvidenceEvents(session, stageEvents)
      const verification = protocolBuildFailed || latestStageVerification?.outcome === 'failed' ||
        streamedVerificationForRevision === 'failed'
        ? 'failed' as const
        : latestStageVerification?.outcome === 'passed' || streamedVerificationForRevision === 'passed'
          ? 'passed' as const
          : 'unknown' as const
      contributionReceipt = buildContributionReceipt({
        runId: session.snapshot.runId,
        round,
        turnId: turn.id,
        agent: turn.agent,
        kind: turn.kind,
        tasks: this.contractedTasks(session),
        // A quota or provider pause can split one logical contribution across
        // multiple fresh calls. Preserve a valid reply-linked handoff already
        // recorded for this exact agent + round instead of demanding that the
        // resumed closure call duplicate it.
        events: qualityEvidenceEvents,
        diff,
        verification,
        accepted: assessment.outcome === 'accepted',
        baseRevision: appRevisionBefore,
        resultRevision: session.appEvidenceRevision,
        baseFingerprint: appStateBefore ?? '',
        resultFingerprint: appStateAfter ?? ''
      })
      const priorReceiptIndex = session.contributionReceipts.findIndex((receipt) => receipt.id === contributionReceipt?.id)
      if (priorReceiptIndex >= 0) {
        contributionReceipt = mergeContributionReceiptClosure(
          session.contributionReceipts[priorReceiptIndex]!,
          contributionReceipt
        )
        session.contributionReceipts[priorReceiptIndex] = contributionReceipt
      } else session.contributionReceipts.push(contributionReceipt)
      await this.retainCollaborationProofEvents(
        session,
        contributionReceipt.handoffEventIds,
        qualityEvidenceEvents
      )
      await session.proofStore.appendContributionReceipt(contributionReceipt)
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        contributionReceipt.status === 'complete'
          ? `${agentName} completed an independently attributable contribution with verification and a teammate handoff.`
          : `${agentName}'s owned contribution is preserved but remains ${contributionReceipt.status}; the supervisor will not count it as equal finished work yet.`,
        {
          topic: 'contribution-receipt',
          severity: contributionReceipt.status === 'complete' ? 'low' : 'medium',
          proof: {
            kind: 'contribution',
            agent: turn.agent,
            status: contributionReceipt.status,
            accepted: contributionReceipt.accepted,
            sourceChanged: contributionReceipt.sourceChanged,
            verification: contributionReceipt.verification,
            handoffRecorded: contributionReceipt.handoffRecorded,
            fileCount: contributionReceipt.fileCount,
            revision: contributionReceipt.resultRevision
          },
          metadata: {
            agent: turn.agent,
            receiptKind: 'contribution',
            status: contributionReceipt.status,
            accepted: contributionReceipt.accepted,
            sourceChanged: contributionReceipt.sourceChanged,
            verification: contributionReceipt.verification,
            handoffRecorded: contributionReceipt.handoffRecorded,
            fileCount: contributionReceipt.fileCount,
            taskCount: contributionReceipt.taskIds.length,
            unresolvedRisks: contributionReceipt.unresolvedRisks
          }
        }
      ))

      const currentBeforeTurn = survivingContributionCandidates(
        session.contributionReceipts.filter((receipt) => receipt.id !== contributionReceipt?.id),
        appRevisionBefore,
        appStateBefore,
        this.qualityEvidenceEvents(session, stageEvents)
      )
      const targetContribution = currentBeforeTurn
        .filter((receipt) => receipt.agent === opponentAgent)
        .sort((left, right) => right.resultRevision - left.resultRevision)[0]
      const reviewsOpponent = turn.kind === 'review' || turn.kind === 'repair' ||
        (turn.kind === 'code' && targetContribution !== undefined)
      const reviewReceipt = reviewsOpponent
        ? buildReviewReceipt({
            runId: session.snapshot.runId,
            round,
            turnId: turn.id,
            reviewer: turn.agent,
            targetContribution,
            reviewedRevision: session.appEvidenceRevision,
            reviewedFingerprint: appStateAfter,
            events: this.qualityEvidenceEvents(session, stageEvents),
            verification,
            accepted: assessment.outcome === 'accepted',
            sourceChanged: durableSourceChanged
          })
        : undefined
      if (reviewReceipt) {
        const priorReviewIndex = session.reviewReceipts.findIndex((receipt) => receipt.id === reviewReceipt.id)
        if (priorReviewIndex >= 0) session.reviewReceipts[priorReviewIndex] = reviewReceipt
        else session.reviewReceipts.push(reviewReceipt)
        await this.retainCollaborationProofEvents(
          session,
          reviewReceipt.evidenceEventIds,
          this.qualityEvidenceEvents(session, stageEvents)
        )
        await session.proofStore.appendReviewReceipt(reviewReceipt)
        await this.emitEvent(session, createDirectorEvent(
          session,
          'decision',
          `${agentName} filed revision-bound review evidence for ${opponentAgent === 'claude' ? 'Claude' : 'Codex'}'s accepted contribution.`,
          {
            topic: 'review-receipt',
            severity: reviewReceipt.accepted ? 'low' : 'medium',
            proof: {
              kind: 'review',
              agent: turn.agent,
              accepted: reviewReceipt.accepted,
              verification: reviewReceipt.verification,
              disposition: reviewReceipt.disposition,
              revision: reviewReceipt.reviewedRevision
            },
            metadata: {
              agent: turn.agent,
              receiptKind: 'review',
              disposition: reviewReceipt.disposition,
              targetContributionId: reviewReceipt.targetContributionId,
              reviewedRevision: reviewReceipt.reviewedRevision,
              verification: reviewReceipt.verification,
              accepted: reviewReceipt.accepted
            }
          }
        ))
      }
      this.refreshCurrentQualityEvidence(session, appStateAfter)
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        session.acceptedCodeAgents.size === 2 && session.acceptedReviewAgents.size === 2
          ? `Both contributions and both reciprocal reviews survive on source revision ${String(session.appEvidenceRevision)}.`
          : `Current-revision quality proof refreshed after ${agentName}'s turn.`,
        {
          topic: 'quality-evidence-state',
          severity: session.acceptedCodeAgents.size === 2 && session.acceptedReviewAgents.size === 2 ? 'low' : 'medium',
          proof: {
            kind: 'quality-state',
            revision: session.appEvidenceRevision,
            acceptedContributionAgents: [...session.acceptedCodeAgents],
            acceptedReviewAgents: [...session.acceptedReviewAgents]
          },
          metadata: {
            revision: session.appEvidenceRevision,
            acceptedContributionAgents: [...session.acceptedCodeAgents],
            acceptedReviewAgents: [...session.acceptedReviewAgents],
            fingerprintBound: appStateAfter !== undefined
          }
        }
      ))
    }
    const usageEvidence = session.usageTracker.evidenceSnapshot().calls.filter((call) => call.agent === turn.agent)
    const completeCalls = usageEvidence.filter((call) => call.complete).length
    const incompleteCalls = usageEvidence.filter((call) => !call.complete && call.status !== 'active').length
    await this.emitEvent(session, createDirectorEvent(
      session,
      'decision',
      incompleteCalls > 0
        ? `${agentName}'s usage receipt retains ${String(incompleteCalls)} incomplete provider call${incompleteCalls === 1 ? '' : 's'} instead of hiding the work.`
        : `${agentName}'s provider usage receipt is complete for ${String(completeCalls)} call${completeCalls === 1 ? '' : 's'}.`,
      {
        topic: 'usage-receipt',
        metadata: {
          agent: turn.agent,
          completeCalls,
          incompleteCalls,
          evidence: incompleteCalls === 0
            ? 'exact'
            : usageEvidence.some((call) => !call.complete && call.source === 'provisional')
              ? 'provider-partial'
              : 'estimated'
        }
      }
    ))
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
      ...(recordedStructuredContract ? { structuredContractAccepted: true } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(quotaRejected ? { quotaRejected: true } : {}),
      ...(quotaResetAt ? { quotaResetAt } : {}),
      ...(effectiveProviderFailure ? { failure: effectiveProviderFailure } : {}),
      ...(leaseTimeboxRequested ? { leaseTimeboxed: true } : {}),
      ...(contributionReceipt ? { contributionReceipt } : {})
    }
  }

  private async advanceAcceptedDialogueTurnBeforePause(
    session: RunSession,
    turn: RealTurn,
    stage: TurnStageName,
    executed: ExecutedTurnStage
  ): Promise<boolean> {
    if (stage !== 'dialogue' || executed.structuredContractAccepted !== true) return false
    const current = session.turnPlan[session.activeTurnIndex]
    if (!current || current.id !== turn.id) return false
    if (turn.phase === 'round.consensus') await this.loadRedactionDictionary(session)
    session.snapshot.activeAgent = undefined
    session.snapshot.turnStage = undefined
    session.resumeStage = undefined
    delete session.providerSessions[turn.agent]
    session.activeTurnIndex = Math.min(session.activeTurnIndex + 1, session.turnPlan.length)
    session.resumePhase = session.turnPlan[session.activeTurnIndex]?.phase ?? 'reveal.ready'
    session.snapshot.phase = session.resumePhase
    await this.persistRunState(session)
    return true
  }

  private async resolveStageOutcome(
    session: RunSession,
    git: GitManager,
    turn: RealTurn,
    round: number,
    stage: TurnStageName,
    executed: ExecutedTurnStage
  ): Promise<ExecutedTurnStage> {
    if (executed.failure?.kind === 'safety-violation' || executed.failure?.kind === 'workspace-drift') {
      throw new RunTerminalError(
        `${turn.agent === 'claude' ? 'Claude' : 'Codex'} reported ${executed.failure.kind}. The supervisor stopped before allowing unsafe or mismatched workspace changes.`,
        executed.failure.kind
      )
    }
    if (
      session.planVersion === 'lean-collaboration-v2' && stage === 'work' && turn.kind === 'code' &&
      executed.contributionReceipt && !receiptCompletesOwnedContribution(
        executed.contributionReceipt,
        this.qualityEvidenceEvents(session)
      ) &&
      !receiptEligibleForProofPromotion(executed.contributionReceipt, this.qualityEvidenceEvents(session)) &&
      !executed.quotaRejected && executed.failure === undefined
    ) {
      const continuationKey = `${turn.id}:completion`
      const continuations = session.workLeaseContinuations.get(continuationKey) ?? 0
      if (continuations < 1) {
        session.workLeaseContinuations.set(continuationKey, continuations + 1)
        await this.emitEvent(session, createDirectorEvent(
          session,
          'decision',
          `${turn.agent === 'claude' ? 'Claude' : 'Codex'} landed useful work but the owned contribution is not closed yet. The same agent keeps the ball for one compact completion pass.`,
          {
            severity: 'medium',
            topic: 'contribution-completion-pass',
            metadata: {
              agent: turn.agent,
              turnId: turn.id,
              unresolvedRisks: executed.contributionReceipt.unresolvedRisks
            }
          }
        ))
        const continuation = await this.executeTurnStage(session, git, turn, round, 'work')
        return await this.resolveStageOutcome(session, git, turn, round, 'work', continuation)
      }
      throw new RunPauseError({
        reason: 'provider-protocol',
        provider: turn.agent,
        message: `${turn.agent === 'claude' ? 'Claude' : 'Codex'} produced durable work, but the owned contribution still lacks ${executed.contributionReceipt.unresolvedRisks.join(', ')}. The opponent will not silently inherit it.`,
        resumable: true,
        stage: 'work',
        action: 'Resume the same owned task; Duo will request only the missing closure evidence before advancing.'
      })
    }
    if (
      executed.leaseTimeboxed && stage === 'work' && !executed.durableSourceChanged &&
      executed.assessment.outcome !== 'accepted' && executed.assessment.outcome !== 'timeboxed'
    ) {
      const continuationKey = `${turn.id}:work`
      const continuations = session.snapshot.turnStage?.continuationCount ??
        session.workLeaseContinuations.get(continuationKey) ?? 0
      if (continuations < 1) {
        session.workLeaseContinuations.set(continuationKey, continuations + 1)
        if (session.snapshot.turnStage) {
          session.snapshot.turnStage = {
            ...session.snapshot.turnStage,
            continuationCount: continuations + 1,
            inferenceSteps: 0
          }
          await this.persistRunState(session)
        }
        await this.emitEvent(session, createDirectorEvent(
          session,
          'decision',
          `${turn.agent === 'claude' ? 'Claude' : 'Codex'} reached the internal reasoning lease before a durable edit landed. A fresh compact capsule is continuing the same owned task; the battle is not restarting.`,
          {
            severity: 'medium',
            topic: 'work-capsule-continuation',
            metadata: { agent: turn.agent, turnId: turn.id, capsule: continuations + 2 }
          }
        ))
        const continuation = await this.executeTurnStage(session, git, turn, round, 'work')
        return await this.resolveStageOutcome(session, git, turn, round, 'work', continuation)
      }
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
      const completedDialogue = await this.advanceAcceptedDialogueTurnBeforePause(session, turn, stage, executed)
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
        ...(!completedDialogue ? { stage: resumeStage } : {}),
        action: completedDialogue
          ? 'Resume after provider usage returns; the accepted dialogue turn will not be replayed and the next scheduled turn will begin.'
          : executed.quotaResetAt
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
      const completedDialogue = await this.advanceAcceptedDialogueTurnBeforePause(session, turn, stage, executed)
      throw new RunPauseError({
        reason: typedPauseReason,
        provider: turn.agent,
        message: `${agentName}'s ${stage} stage reached a recoverable ${executed.failure?.kind ?? 'provider'} boundary. The exact workspace and collaboration cursor are preserved.`,
        resumable: true,
        ...(!completedDialogue ? { stage } : {}),
        action: completedDialogue
          ? 'Resolve the provider boundary, then resume. The accepted dialogue turn will not be replayed.'
          : typedPauseReason === 'provider-auth'
          ? `Sign in to ${agentName}, then resume the same turn.`
          : typedPauseReason === 'model-unavailable'
            ? 'Choose an available model in Agent loadout, apply it, then resume.'
            : typedPauseReason === 'cli-incompatible'
              ? `Update or reconfigure the local ${agentName} CLI, then resume.`
              : 'Resume the same turn when the provider is available.'
      })
    }
    if (executed.assessment.outcome === 'accepted' || executed.assessment.outcome === 'timeboxed') return executed
    const onlyMissingWorkEvidence = executed.assessment.outcome === 'fatal' &&
      executed.assessment.reasons.length === 1 &&
      executed.assessment.reasons[0] === 'missing-work-evidence'
    const canIndependentlyVerifyCleanWork = stage === 'work' &&
      (turn.kind === 'code' || turn.kind === 'repair' || turn.kind === 'review') &&
      !executed.durableSourceChanged &&
      executed.failure === undefined &&
      onlyMissingWorkEvidence
    if (canIndependentlyVerifyCleanWork) {
      // A provider can legitimately conclude that the exact current source needs
      // no edit. Resolve that narrow ambiguity at the trusted supervisor boundary
      // instead of replaying the model call or inventing a provider outage.
      const verified = await this.verifyCurrentRevision(session)
      if (!verified) {
        throw new RunPauseError({
          reason: 'verification-failed',
          message: `The independent supervisor could not verify the exact source revision after ${turn.agent === 'claude' ? 'Claude' : 'Codex'} completed a clean no-change ${turn.kind} stage. No provider failure is being inferred.`,
          resumable: true,
          stage,
          action: 'Inspect the recorded supervisor checks or repair the preserved source, then resume this exact turn.'
        })
      }
      const evidenceFingerprint = await git.appStateFingerprint(session.workspace.workspacePath)
      if (session.snapshot.turnStage) {
        session.snapshot.turnStage = {
          ...session.snapshot.turnStage,
          status: 'completed',
          durableWorkEvidence: true,
          ...(evidenceFingerprint ? { evidenceFingerprint } : {})
        }
      }
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        `Independent proof passed for the unchanged source revision, so ${turn.agent === 'claude' ? 'Claude' : 'Codex'}'s ${turn.kind} stage advances without a redundant edit.`,
        {
          severity: 'medium',
          topic: 'supervisor-work-evidence',
          metadata: { revision: session.appEvidenceRevision, turnId: turn.id, kind: turn.kind }
        }
      ))
      await this.persistRunState(session)
      return {
        ...executed,
        assessment: { accepted: true, outcome: 'accepted', reasons: [] },
        // Advancing a verified no-op must not be miscounted as a source
        // contribution in the reciprocal duo-quality gate.
        supervisorVerifiedNoChange: true
      }
    }
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
      if (this.remainingRunSeconds(session) <= 0) return executed
      if (recovery.assessment.outcome === 'accepted' || recovery.assessment.outcome === 'timeboxed') {
        session.resumeRecoveryOriginStage = undefined
        session.resumeRecoveryReasons = undefined
        await this.persistRunState(session)
        return {
          ...executed,
          assessment: { accepted: true, outcome: 'accepted', reasons: [] }
        }
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
    const stageTimedOut = executed.failure?.kind === 'stage-timeout' ||
      executed.assessment.reasons.includes('stage-timeout') ||
      executed.assessment.reasons.includes('work-lease-expired')
    const boundedClaudeWorkCapsule = stageTimedOut && turn.agent === 'claude' &&
      stage === 'work' && executed.leaseTimeboxed === true
    throw new RunPauseError({
      reason: stageTimedOut ? 'stage-timeout' : 'provider-protocol',
      provider: turn.agent,
      message: boundedClaudeWorkCapsule
        ? `${turn.agent === 'claude' ? 'Claude' : 'Codex'} reached the bounded ${stage} capsule before trusted work evidence landed (${executed.assessment.reasons.join(', ')}). The workspace and recorded evidence remain preserved.`
        : stageTimedOut
          ? `${turn.agent === 'claude' ? 'Claude' : 'Codex'} ${stage} stage reached its time boundary before it could safely advance (${executed.assessment.reasons.join(', ')}). Durable workspace evidence remains preserved.`
        : `${turn.agent === 'claude' ? 'Claude' : 'Codex'} completed the ${stage} stage, but trusted collaboration or work evidence was incomplete (${executed.assessment.reasons.join(', ')}). Durable workspace evidence remains preserved.`,
      resumable: true,
      stage,
      action: boundedClaudeWorkCapsule
        ? 'Resume starts a fresh bounded capsule for the same preserved turn; the battle does not restart.'
        : stageTimedOut
          ? 'Resume the preserved turn when the local CLI is ready.'
          : 'Resume the preserved turn to recover the missing protocol or verification evidence; accepted work will not be discarded.'
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
      // Quota pauses are durable suspensions, not task abandonment. Keeping
      // ownership prevents the opponent from silently taking over and lets a
      // resumed fresh capsule close the exact same contribution.
      return { ...task, status: 'open', handoffReason: 'provider-quota' }
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
      const tasks = mergeBoardWithTaskContracts(
        normalizeBoard(JSON.parse(boardContent) as unknown),
        session.taskContracts
      )
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
      this.contractedTasks(session)
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
    const [provenance, immutablePitches] = await Promise.all([
      session.proofStore.readConsensusProvenance(session.snapshot.runId),
      session.proofStore.readPitches(session.snapshot.runId)
    ])
    const qualityProvenanceMatches = provenance !== undefined && validateConsensusProvenance({
      record: provenance,
      runId: session.snapshot.runId,
      humanBrief: session.request.prompt,
      qualityBriefFingerprint: session.qualityBrief.fingerprint,
      immutablePitches
    })
    const result = await this.supervisorVerifier.verify({
      appPath: session.workspace.appPath,
      npmPath: session.settings.npmPath,
      // Agent execution obeys the overall run ceiling. Independent final proof
      // receives its own bounded grace window so an exhausted agent budget can
      // never collapse a normal build/test gate into a one-second false failure.
      timeoutMs: SUPERVISOR_VERIFICATION_GRACE_MS,
      abortSignal: session.controller.signal,
      qualityContract: {
        missionProfile: session.request.missionProfile ?? 'surprise',
        consensusProvenance: {
          verified: qualityProvenanceMatches,
          ...(qualityProvenanceMatches
            ? { evidenceHandle: `consensus-provenance:${session.qualityBrief.fingerprint}` }
            : {})
        },
        criteria: session.qualityBrief.privateContract.hardConstraints.map((constraint) => ({
          id: constraint.id,
          label: constraint.sourceText,
          kind: constraint.kind,
          polarity: constraint.polarity,
          evidenceTerms: constraint.coverageTerms,
          ...(constraint.coverageGroups ? { evidenceGroups: constraint.coverageGroups } : {})
        }))
      }
    })
    if (!this.runIsActive(session) || session.controller.signal.aborted) return false
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
    if (result.browserEvidence) {
      const compact = result.browserEvidence.viewports.find((viewport) => viewport.id === 'compact')
      const full = result.browserEvidence.viewports.find((viewport) => viewport.id === 'full')
      const consoleHealthy = result.browserEvidence.viewports.every((viewport) =>
        viewport.consoleErrors.length === 0 && viewport.pageErrors.length === 0
      )
      const interactionRequired = result.checks.some((check) => check.id === 'browser:interaction')
      const interactionPassed = !interactionRequired || result.checks.some((check) =>
        check.id === 'browser:interaction' && check.outcome === 'passed'
      )
      await this.emitEvent(session, createDirectorEvent(
        session,
        'decision',
        passed
          ? 'Compact and full-screen browser proof passed with healthy console and interaction evidence.'
          : 'Browser quality evidence found a release blocker; the result remains repairable and is not being presented as clean.',
        {
          topic: 'browser-qa-receipt',
          severity: passed ? 'low' : 'high',
          metadata: {
            smokePassed: result.outcome === 'passed',
            compactScreenshot: compact?.screenshotCaptured === true,
            fullscreenScreenshot: full?.screenshotCaptured === true,
            consoleHealthy,
            interactionPassed
          }
        }
      ))
    }
    session.supervisorVerificationAttempt = { revision: session.appEvidenceRevision, passed }
    session.verifiedAppEvidenceRevision = passed ? session.appEvidenceRevision : -1
    const verificationEvent = createDirectorEvent(
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
          checks: result.checks.map((check) => ({
            id: check.id,
            outcome: check.outcome,
            label: check.label,
            ...(typeof record(check).detail === 'string' ? { detail: record(check).detail } : {})
          }))
        }
      }
    )
    await this.emitEvent(session, verificationEvent)
    await session.proofStore.writeVerificationReceipt({
      version: 1,
      runId: session.snapshot.runId,
      revision: session.appEvidenceRevision,
      outcome: passed ? 'passed' : 'failed',
      summary: verificationEvent.privateText ?? verificationEvent.publicText,
      checks: result.checks.map((check) => ({
        id: check.id,
        outcome: check.outcome,
        label: check.label,
        ...(typeof record(check).detail === 'string' ? { detail: String(record(check).detail) } : {})
      })),
      recordedAt: verificationEvent.timestamp
    })
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
    const context = repairMojibake([
      `${opponent === 'claude' ? 'Claude' : 'Codex'} private ${revealText(dispatch.dispatchKind) ?? 'position'}:`,
      speech,
      ...(privateOpinion ? [`Opinion: ${privateOpinion}`] : []),
      ...pitchText
    ].join('\n'))
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
        releaseIssues.push('Both agents need a material accepted contribution, a completed owned task, and exact-current reciprocal review evidence before the build can be marked ready.')
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
    const releaseIssues: string[] = []
    if (!evidence.hasRunnableArtifact) {
      releaseIssues.push('The supervisor could not discover a runnable app artifact on the final workspace revision.')
    }
    if (!this.hasCurrentVerification(session)) {
      releaseIssues.push('Independent supervisor verification did not pass on the exact final source revision.')
    }
    if (!this.hasDuoQualityEvidence(session)) {
      releaseIssues.push('Both agents need a material accepted contribution, a completed owned task, and exact-current reciprocal review evidence before the build can be marked ready.')
    }
    if (!await this.seriousMissionContractSatisfied(session)) {
      releaseIssues.push('The serious mission could not prove an intact binding chain from the human brief to the sealed implementation specification.')
    }
    return enrichRevealPacket({
      appName: evidence.appName ?? basename(session.workspace.workspacePath),
      idea: evidence.idea ?? 'The agents reached the turn limit before completing the final reveal contract.',
      summary: evidence.hasRecordedVerification
        ? 'The generated artifact passed independent verification, while the collaboration record retains documented caveats.'
        : 'The generated artifact was recovered from the workspace, with final release proof still incomplete.',
      features,
      runCommand: evidence.runCommand ?? 'Open the generated workspace for inspection.',
      appPath: evidence.directEntrypoint ?? session.workspace.appPath,
      status: 'partial',
      whatWorked: evidence.completedWork.length > 0
        ? evidence.completedWork
        : ['Both local CLI agents completed scheduled turns.'],
      knownIssues: releaseIssues,
      agentDramaSummary: [],
      gitCheckpoints: uniqueRevealStrings(session.snapshot.events
        .filter((event) => event.type === 'git.checkpoint')
        .map((event) => event.publicText)),
      agentQuotes: {
        claude: '',
        codex: ''
      }
    }, session.snapshot.events, session.snapshot.tasks)
  }

  private hasCurrentVerification(session: RunSession): boolean {
    return session.verifiedAppEvidenceRevision >= 0 &&
      session.verifiedAppEvidenceRevision === session.appEvidenceRevision
  }

  private contractedTasks(session: RunSession): DuoTask[] {
    const contractIds = new Set(session.taskContracts.map((task) => task.id))
    return session.snapshot.tasks.filter((task) => contractIds.has(task.id))
  }

  private qualityEvidenceEvents(session: RunSession, extra: DuoEvent[] = []): DuoEvent[] {
    return mergeSupervisorEvidenceEvents(
      session.snapshot.events,
      extra,
      session.collaborationProofEvents
    )
  }

  private async retainCollaborationProofEvents(
    session: RunSession,
    eventIds: string[],
    candidates: DuoEvent[]
  ): Promise<void> {
    const required = new Set(eventIds)
    if (required.size === 0) return
    const selected = candidates.filter((event) => required.has(event.id))
    if (new Set(selected.map((event) => event.id)).size !== required.size) {
      throw new Error('Supervisor collaboration proof could not be bound to every referenced event id.')
    }
    session.collaborationProofEvents = await session.proofStore.recordCollaborationProofEvents(
      session.snapshot.runId,
      selected
    )
  }

  private async seriousMissionContractSatisfied(session: RunSession): Promise<boolean> {
    if ((session.request.missionProfile ?? 'surprise') !== 'serious') return true
    return await validateSeriousMissionContract(
      join(session.workspace.duoPath, 'sealed'),
      session.request.prompt,
      join(session.workspace.runtimePath, 'private', 'serious_mission_guard.json')
    )
  }

  private refreshCurrentQualityEvidence(session: RunSession, fingerprint = session.appFingerprint): void {
    const qualityEvidenceEvents = this.qualityEvidenceEvents(session)
    const contributions = promotedSurvivingContributionReceipts(
      session.contributionReceipts,
      session.reviewReceipts,
      session.appEvidenceRevision,
      fingerprint,
      qualityEvidenceEvents,
      { independentlyVerified: this.hasCurrentVerification(session) }
    )
    session.acceptedCodeAgents = new Set(contributions.map((receipt) => receipt.agent))
    session.acceptedReviewAgents = new Set(session.reviewReceipts
      .filter((receipt) => reviewAcceptsCurrentRevision(
        receipt,
        contributions,
        session.appEvidenceRevision,
        fingerprint,
        qualityEvidenceEvents,
        {
          allowPromotedTarget: true,
          independentlyVerified: this.hasCurrentVerification(session),
          reviewerTurnReceipts: session.contributionReceipts
        }
      ))
      .map((receipt) => receipt.reviewer))
  }

  private hasDuoQualityEvidence(session: RunSession): boolean {
    this.refreshCurrentQualityEvidence(session)
    return session.acceptedCodeAgents.size === 2 && session.acceptedReviewAgents.size === 2 &&
      hasCompletedOwnedTask(this.contractedTasks(session), 'claude') &&
      hasCompletedOwnedTask(this.contractedTasks(session), 'codex')
  }

  private async missingReadyEvidence(
    session: RunSession,
    artifact: WorkspaceRevealEvidence
  ): Promise<string[]> {
    this.refreshCurrentQualityEvidence(session)
    const missing: string[] = []
    if (!artifact.hasRunnableArtifact) missing.push('Runnable artifact')
    if (!this.hasCurrentVerification(session)) missing.push('Independent verification')
    for (const agent of ['claude', 'codex'] as const) {
      const label = agent === 'claude' ? 'Claude' : 'Codex'
      if (!session.acceptedCodeAgents.has(agent)) missing.push(`${label} accepted contribution`)
      if (!hasCompletedOwnedTask(this.contractedTasks(session), agent)) missing.push(`${label} completed owned task`)
      if (!session.acceptedReviewAgents.has(agent)) missing.push(`${label} exact-current cross-review`)
    }
    if (!await this.seriousMissionContractSatisfied(session)) missing.push('Human brief provenance')
    return uniqueRevealStrings(missing, 12)
  }
}
