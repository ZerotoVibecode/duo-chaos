export type AgentId = 'claude' | 'codex' | 'director' | 'system'
export type AgentEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CodexEffort = AgentEffort | 'ultra'
/**
 * Controls which existing local CLI customizations may participate in source work.
 * Dialogue and contract recovery are always isolated regardless of this choice.
 */
export type CustomizationProfile = 'core' | 'smart' | 'full-local'
export type QualityRoutingProfile = 'balanced' | 'force-selected'
export type TurnStageName = 'dialogue' | 'opening' | 'work' | 'verdict' | 'recovery'
export type TurnStageStatus = 'running' | 'completed' | 'timeboxed' | 'paused'
export type TurnKind = 'pitch' | 'critique' | 'consensus' | 'tasking' | 'code' | 'review' | 'verify' | 'repair'

export interface TurnStageSnapshot {
  turnId: string
  agent: Extract<AgentId, 'claude' | 'codex'>
  kind: string
  stage: TurnStageName
  status: TurnStageStatus
  startedAt: string
  deadlineAt: string
  attempt: number
  effort?: string
  qualityCeiling?: string
  customizationProfile?: CustomizationProfile
  inferenceSteps?: number
  inferenceLimit?: number
  /** Number of fresh compact capsules already spent for this logical stage. */
  continuationCount?: number
  nextAgent?: Extract<AgentId, 'claude' | 'codex'>
  /** Durable source for this exact stage is checkpointed at evidenceFingerprint. */
  durableSourceChanged?: boolean
  durableWorkEvidence?: boolean
  evidenceFingerprint?: string
}

export interface AgentModelCapability {
  id: string
  label: string
  efforts: Array<Exclude<CodexEffort, 'default'>>
  defaultEffort?: Exclude<CodexEffort, 'default'>
}

export interface AgentRuntimeCatalog {
  agent: Extract<AgentId, 'claude' | 'codex'>
  models: AgentModelCapability[]
  source: 'cli-live' | 'cli-bundled' | 'cli-help' | 'fallback'
  discoveredAt: string
  note?: string
}

export interface AgentRuntimeProfile {
  model?: string
  effort?: Exclude<CodexEffort, 'default'>
  source: 'studio' | 'cli-config' | 'cli-default'
  customizationProfile?: CustomizationProfile
  qualityCeiling?: string
}

export interface AgentUsageTotals {
  processedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  calls: number
  largestRawLineBytes: number
  reportedCostUsd?: number
}

export type AgentUsageSnapshot = Record<Extract<AgentId, 'claude' | 'codex'>, AgentUsageTotals>

export type ExecutionMode = 'simulation' | 'safe' | 'chaos' | 'yolo-sandbox'
export type VisibilityMode = 'blind' | 'spoiler-shield' | 'full-chaos'
export type MissionProfile = 'surprise' | 'serious'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type OpinionTone =
  | 'skeptical'
  | 'impressed'
  | 'annoyed'
  | 'confident'
  | 'cautious'
  | 'amused'
  | 'contrarian'
  | 'self-critical'
  | 'collaborative'
  | 'ruthless'

export type AgentDispatchKind =
  | 'opening'
  | 'position'
  | 'challenge'
  | 'counter'
  | 'reaction'
  | 'evidence'
  | 'prediction'
  | 'concession'
  | 'decision'
  | 'repair'
  | 'verdict'
  | 'closing'
  | 'update'

export type BroadcastProvenance = 'agent-quote' | 'director' | 'evidence'
export type BroadcastBeatKind =
  | 'opening'
  | 'agent-quote'
  | 'replay'
  | 'challenge'
  | 'counter'
  | 'live-move'
  | 'evidence'
  | 'response-clock'
  | 'failure'
  | 'verification'
  | 'task'
  | 'response-due'
  | 'repair'
  | 'concession'
  | 'decision'
  | 'resolution'
  | 'heartbeat'
  | 'status'

export interface BroadcastQuote {
  agent: Extract<AgentId, 'claude' | 'codex'>
  text: string
  sourceEventId: string
}

export interface BroadcastBeat {
  id: string
  kind: BroadcastBeatKind
  provenance: BroadcastProvenance
  speaker: Extract<AgentId, 'claude' | 'codex' | 'director'>
  headline: string
  detail: string
  body?: string
  sourceEventIds: string[]
  quote?: BroadcastQuote
  severity?: Severity
  createdAt?: string
}

export type BroadcastMissionStatus = 'drafting' | 'queued' | 'active' | 'done' | 'blocked'

export interface BroadcastMission {
  turnId: string
  agent: Extract<AgentId, 'claude' | 'codex'>
  label: string
  status: BroadcastMissionStatus
  claimed: boolean
  id?: string
  taskId?: string
  sourceEventIds?: string[]
}

export interface BroadcastEvidence {
  inspections: number
  edits: number
  verifications: number
  failures: number
}

export interface BroadcastResponseDue {
  agent: Extract<AgentId, 'claude' | 'codex'>
  since: string
  waitingSeconds: number
  nextTurnId?: string
}

export interface BroadcastVerdict {
  outcome: 'claude' | 'codex' | 'split' | 'unresolved'
  text: string
  sourceEventIds: string[]
}

export interface BroadcastState {
  activeBeat: BroadcastBeat
  beats: BroadcastBeat[]
  missions: BroadcastMission[]
  evidence: BroadcastEvidence
  responseDue?: BroadcastResponseDue
  verdict?: BroadcastVerdict
  generatedAt?: string
}

export interface BroadcastSnapshot extends BroadcastState {
  queue: BroadcastBeat[]
  responseDueAgent?: Extract<AgentId, 'claude' | 'codex'>
  nextAgent?: Extract<AgentId, 'claude' | 'codex'>
}

export type RunPhase =
  | 'idle'
  | 'preflight'
  | 'workspace.create'
  | 'workspace.seed'
  | 'round.pitch'
  | 'round.critique'
  | 'round.conflict'
  | 'round.consensus'
  | 'round.tasking'
  | 'round.claim'
  | 'round.code'
  | 'round.cross-review'
  | 'round.repair'
  | 'round.verify'
  | 'reveal.prepare'
  | 'reveal.ready'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type DuoEventType =
  | 'run.started'
  | 'health.check'
  | 'phase.changed'
  | 'agent.started'
  | 'agent.activity'
  | 'agent.dispatch'
  | 'cli.log'
  | 'opinion'
  | 'conflict'
  | 'decision'
  | 'task.created'
  | 'task.claimed'
  | 'task.updated'
  | 'file.changed'
  | 'git.checkpoint'
  | 'build.started'
  | 'build.failed'
  | 'build.passed'
  | 'repair.started'
  | 'repair.completed'
  | 'reveal.ready'
  | 'run.completed'
  | 'run.failed'
  | 'run.paused'
  | 'run.resumed'
  | 'run.cancelled'

export type TaskStatus = 'open' | 'claimed' | 'in-progress' | 'review' | 'done' | 'blocked'

export interface DuoTask {
  id: string
  publicTitle: string
  privateTitle?: string
  publicDescription?: string
  privateDescription?: string
  status: TaskStatus
  claimedBy?: AgentId | 'both' | 'none'
  risk: 'low' | 'medium' | 'high'
  files: string[]
  privateFiles?: string[]
}

export interface RevealPacket {
  appName: string
  idea: string
  summary: string
  features: string[]
  runCommand: string
  appPath: string
  devUrl?: string
  status: 'ready' | 'partial' | 'failed'
  whatWorked: string[]
  knownIssues: string[]
  agentDramaSummary: string[]
  gitCheckpoints: string[]
  agentQuotes: {
    claude: string
    codex: string
  }
}

export type ArtifactPreviewResult =
  | {
      status: 'ready'
      imageDataUrl: string
      width: number
      height: number
      capturedAt: string
    }
  | {
      status: 'unavailable'
      reason: 'no-built-artifact'
      message: string
    }
  | {
      status: 'failed'
      reason: 'unsafe-artifact' | 'capture-failed'
      message: string
    }

export interface DuoEvent {
  id: string
  type: DuoEventType
  runId: string
  round: number
  timestamp: string
  agent: AgentId
  publicText: string
  privateText?: string
  spoilerRisk: number
  severity: Severity
  targetAgent?: AgentId
  topic?: string
  tone?: OpinionTone
  dispatchKind?: AgentDispatchKind
  claimKey?: string
  replyTo?: string
  heat?: number
  confidence?: number
  evidenceFiles?: string[]
  relatedTaskIds?: string[]
  source?: AgentId
  stream?: 'stdout' | 'stderr' | 'system'
  category?: 'message' | 'command' | 'file' | 'reasoning' | 'error' | 'status' | 'unknown'
  rawAvailable?: boolean
  publicTopic?: string
  privateTopic?: string
  claudePosition?: string
  codexPosition?: string
  winner?: 'claude' | 'codex' | 'split' | 'director'
  resolution?: string
  impact?: 'low' | 'medium' | 'high'
  status?: string
  task?: DuoTask
  revealPacket?: RevealPacket
  metadata?: Record<string, unknown>
}

export interface ToolHealth {
  id: 'codex' | 'claude' | 'git' | 'node' | 'npm'
  label: string
  command: string
  available: boolean
  version?: string
  detail?: string
  runtime?: AgentRuntimeProfile
  catalog?: AgentRuntimeCatalog
  checkedAt: string
}

export interface RunSnapshot {
  runId: string
  prompt: string
  executionMode: ExecutionMode
  visibilityMode: VisibilityMode
  missionProfile?: MissionProfile
  phase: RunPhase
  status: 'idle' | 'running' | 'paused' | 'reveal-ready' | 'complete' | 'failed' | 'cancelled'
  round: number
  totalTurns?: number
  startedAt: string
  finishedAt?: string
  activeTimeMs?: number
  workspacePath: string
  appPath: string
  activeAgent?: AgentId
  turnStage?: TurnStageSnapshot
  agentRuntimes?: Partial<Record<Extract<AgentId, 'claude' | 'codex'>, AgentRuntimeProfile>>
  agentUsage?: AgentUsageSnapshot
  pause?: RunPauseSnapshot
  releaseStatus?: RevealPacket['status']
  revealPacket?: RevealPacket
  broadcast?: BroadcastSnapshot
  tasks: DuoTask[]
  events: DuoEvent[]
}

export type RunPauseReason =
  | 'provider-quota'
  | 'provider-auth'
  | 'provider-unavailable'
  | 'model-unavailable'
  | 'cli-incompatible'
  | 'provider-protocol'
  | 'session-lost'
  | 'stage-timeout'
  | 'host-interrupted'
  | 'workspace-drift'
  | 'verification-failed'
  | 'unknown'

export interface RunPauseSnapshot {
  reason: RunPauseReason
  provider?: Extract<AgentId, 'claude' | 'codex'>
  message: string
  pausedAt: string
  resetAt?: string
  resumable: boolean
  round: number
  stage?: TurnStageName
  checkpoint?: string
  action?: string
}

export type RecentBuildStatus = 'complete' | 'paused' | 'reveal-ready' | 'interrupted' | 'cancelled' | 'failed'

export interface AgentContributionSummary {
  turns: number
  edits: number
  messages: number
  tasksDone: number
}

export interface RecentBuildProof {
  tasksDone: number
  tasksTotal: number
  checkpoints: number
  buildPasses: number
  claude: AgentContributionSummary
  codex: AgentContributionSummary
}

export interface RecentBuildSummary {
  runId: string
  startedAt: string
  finishedAt?: string
  status: RecentBuildStatus
  phase: RunPhase
  executionMode: ExecutionMode
  visibilityMode: VisibilityMode
  missionProfile?: MissionProfile
  prompt: string
  workspacePath: string
  workspaceRoot: string
  appName?: string
  releaseStatus?: RevealPacket['status']
  sealed: boolean
  recoverable: boolean
  /** True only when the supervisor reconstructed this exact paused run in the current process. */
  resumable?: boolean
  proof: RecentBuildProof
}

export interface AppSettings {
  codexPath: string
  claudePath: string
  gitPath: string
  nodePath: string
  npmPath: string
  codexExtraArgs: string[]
  claudeExtraArgs: string[]
  codexModel: string
  codexEffort: CodexEffort
  claudeModel: string
  claudeEffort: AgentEffort
  codexCustomizationProfile: CustomizationProfile
  claudeCustomizationProfile: CustomizationProfile
  trustedLocalCapabilitiesConfirmed: boolean
  qualityRoutingProfile: QualityRoutingProfile
  claudeWorkInferenceLimit: number
  defaultWorkspaceRoot: string
  defaultExecutionMode: ExecutionMode
  defaultVisibilityMode: VisibilityMode
  defaultMissionProfile: MissionProfile
  saveRawLogs: boolean
  maxTurns: number
  maxRepairLoops: number
  turnTimeoutSeconds: number
  runTimeoutSeconds: number
}

export interface StartRunRequest {
  prompt: string
  workspaceRoot: string
  executionMode: ExecutionMode
  visibilityMode: VisibilityMode
  /** Missing only on legacy callers; validation normalizes it to surprise. */
  missionProfile?: MissionProfile
  maxTurns: number
  maxRepairLoops: number
  turnTimeoutSeconds: number
  runTimeoutSeconds: number
  dangerousModeConfirmed: boolean
  unsafeWorkspaceRootConfirmed: boolean
  /** Pinned at admission so later Settings changes cannot silently alter a resumed battle. */
  codexCustomizationProfile?: CustomizationProfile
  claudeCustomizationProfile?: CustomizationProfile
  trustedLocalCapabilitiesConfirmed?: boolean
  qualityRoutingProfile?: QualityRoutingProfile
  claudeWorkInferenceLimit?: number
  codexModel?: string
  codexEffort?: CodexEffort
  claudeModel?: string
  claudeEffort?: AgentEffort
}

export interface StartRunResult {
  runId: string
  workspacePath: string
}
