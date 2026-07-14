import type { AgentContributionSummary, AgentId, DuoEvent, RunSnapshot } from '@shared/types'
import { releaseVerificationPassCount, verificationFailureCount } from '@shared/verification-evidence'

type BuildAgent = Extract<AgentId, 'claude' | 'codex'>

export interface AgentEvidenceMomentum {
  challenges: number
  acceptedCalls: number
  edits: number
  tasksDone: number
  repairSaves: number
  acceptedContributions: number
  acceptedReviews: number
  continuingContributions: number
  blockedContributions: number
  verifiedContributions: number
  handoffs: number
  sourceFiles: number
  latestMove?: string
}

export interface UsageCompletenessEvidence {
  completeCalls: number
  incompleteCalls: number
  evidence: 'exact' | 'provider-partial' | 'estimated' | 'unknown'
}

export interface BrowserQualityEvidence {
  available: boolean
  smokePassed: boolean
  compactScreenshot: boolean
  fullscreenScreenshot: boolean
  consoleHealthy: boolean
  interactionPassed: boolean
  passed: boolean
}

export interface BriefQualityEvidence {
  available: boolean
  passed: boolean
  passedChecks: number
  totalChecks: number
}

export interface EvidenceMomentumSnapshot {
  agents: Record<BuildAgent, AgentEvidenceMomentum>
  shared: {
    tasksDone: number
    tasksTotal: number
    buildPasses: number
    buildFailures: number
    checkpoints: number
    acceptedContributions: number
    acceptedContributionGoal: number
    acceptedReviews: number
    acceptedReviewGoal: number
    brief: BriefQualityEvidence
    browser: BrowserQualityEvidence
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function receiptMetadata(event: DuoEvent): Record<string, unknown> | undefined {
  if (event.proof) return event.proof
  const root = record(event.metadata)
  return record(root?.receipt) ?? root
}

function contributionReceipt(event: DuoEvent): {
  agent?: BuildAgent
  status: string
  accepted: boolean
  verification: string
  handoffRecorded: boolean
  sourceChanged: boolean
  fileCount: number
} | undefined {
  const metadata = receiptMetadata(event)
  const receiptKind = metadata?.receiptKind
  if (event.topic !== 'contribution-receipt' && receiptKind !== 'contribution') return undefined
  const recordedAgent = event.agent === 'claude' || event.agent === 'codex'
    ? event.agent
    : metadata?.agent === 'claude' || metadata?.agent === 'codex'
      ? metadata.agent
      : undefined
  const status = typeof metadata?.status === 'string'
    ? metadata.status
    : typeof metadata?.receiptStatus === 'string'
      ? metadata.receiptStatus
      : event.status ?? 'unknown'
  return {
    ...(recordedAgent ? { agent: recordedAgent } : {}),
    status,
    accepted: metadata?.accepted === true,
    verification: typeof metadata?.verification === 'string' ? metadata.verification : 'unknown',
    handoffRecorded: metadata?.handoffRecorded === true,
    sourceChanged: metadata?.sourceChanged === true,
    fileCount: typeof metadata?.fileCount === 'number' && Number.isFinite(metadata.fileCount)
      ? Math.max(0, Math.floor(metadata.fileCount))
      : 0
  }
}

function receiptIsAccepted(receipt: NonNullable<ReturnType<typeof contributionReceipt>>): boolean {
  return receipt.status === 'complete' && receipt.accepted && receipt.sourceChanged &&
    receipt.verification === 'passed' && receipt.handoffRecorded
}

function currentQualityAgents(run: RunSnapshot): {
  contributions: Set<BuildAgent>
  reviews: Set<BuildAgent>
} | undefined {
  const state = run.events.filter((event) => event.topic === 'quality-evidence-state').at(-1)
  const metadata = state?.proof
    ? state.proof as unknown as Record<string, unknown>
    : record(state?.metadata)
  if (!metadata) return undefined
  const agents = (value: unknown): Set<BuildAgent> => new Set(
    Array.isArray(value)
      ? value.filter((item): item is BuildAgent => item === 'claude' || item === 'codex')
      : []
  )
  return {
    contributions: agents(metadata.acceptedContributionAgents),
    reviews: agents(metadata.acceptedReviewAgents)
  }
}

export function deriveUsageCompleteness(run: RunSnapshot, agent: BuildAgent): UsageCompletenessEvidence | undefined {
  const event = run.events.filter((candidate) => {
    const metadata = receiptMetadata(candidate)
    const recordedAgent = candidate.agent === 'claude' || candidate.agent === 'codex'
      ? candidate.agent
      : metadata?.agent
    if (recordedAgent !== agent) return false
    return candidate.topic === 'usage-receipt' || typeof metadata?.completeCalls === 'number' || typeof metadata?.incompleteCalls === 'number'
  }).at(-1)
  if (!event) return undefined
  const metadata = receiptMetadata(event)
  if (!metadata) return undefined
  const completeCalls = typeof metadata.completeCalls === 'number' && Number.isFinite(metadata.completeCalls)
    ? Math.max(0, Math.floor(metadata.completeCalls))
    : 0
  const incompleteCalls = typeof metadata.incompleteCalls === 'number' && Number.isFinite(metadata.incompleteCalls)
    ? Math.max(0, Math.floor(metadata.incompleteCalls))
    : 0
  const rawEvidence = typeof metadata.evidence === 'string'
    ? metadata.evidence
    : typeof metadata.evidenceKind === 'string'
      ? metadata.evidenceKind
      : 'unknown'
  const evidence = rawEvidence === 'exact' || rawEvidence === 'provider-partial' || rawEvidence === 'estimated'
    ? rawEvidence
    : 'unknown'
  return { completeCalls, incompleteCalls, evidence }
}

export function deriveBrowserQualityEvidence(run: RunSnapshot): BrowserQualityEvidence {
  const event = run.events.filter((candidate) => {
    const metadata = record(candidate.metadata)
    return candidate.topic === 'browser-qa-receipt' || record(metadata?.browserEvidence) !== undefined
  }).at(-1)
  const root = record(event?.metadata)
  const metadata = record(root?.browserEvidence) ?? root
  const available = metadata !== undefined
  const smokePassed = metadata?.smokePassed === true
  const compactScreenshot = metadata?.compactScreenshot === true
  const fullscreenScreenshot = metadata?.fullscreenScreenshot === true
  const consoleHealthy = metadata?.consoleHealthy === true
  const interactionPassed = metadata?.interactionPassed === true
  return {
    available,
    smokePassed,
    compactScreenshot,
    fullscreenScreenshot,
    consoleHealthy,
    interactionPassed,
    passed: available && smokePassed && compactScreenshot && fullscreenScreenshot && consoleHealthy && interactionPassed
  }
}

export function deriveBriefQualityEvidence(run: RunSnapshot): BriefQualityEvidence {
  const event = run.events.filter((candidate) => candidate.topic === 'supervisor-verification').at(-1)
  const metadata = record(event?.metadata)
  const rawChecks = Array.isArray(metadata?.checks) ? metadata.checks : []
  const checks = rawChecks.flatMap((value) => {
    const check = record(value)
    const id = typeof check?.id === 'string' ? check.id : undefined
    const outcome = typeof check?.outcome === 'string' ? check.outcome : undefined
    return id?.startsWith('brief:') && outcome ? [{ id, outcome }] : []
  })
  const passedChecks = checks.filter((check) => check.outcome === 'passed').length
  return {
    available: checks.length > 0,
    passed: checks.length > 0 && passedChecks === checks.length,
    passedChecks,
    totalChecks: checks.length
  }
}

function isEditEvidenceEvent(event: DuoEvent): boolean {
  return event.type === 'file.changed'
    || ((event.type === 'agent.activity' || event.type === 'cli.log') && event.category === 'file')
}

function isChallengeEvent(event: DuoEvent): boolean {
  return event.type === 'conflict'
    || event.dispatchKind === 'challenge'
    || event.dispatchKind === 'counter'
}

function deriveAgentEvidence(run: RunSnapshot, agent: BuildAgent): AgentEvidenceMomentum {
  const latestMove = run.events
    .filter((event) => event.agent === agent && event.publicText.trim().length > 0)
    .at(-1)?.publicText.trim()

  const receipts = run.events
    .map(contributionReceipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> => receipt?.agent === agent)
  const current = currentQualityAgents(run)
  return {
    challenges: run.events.filter((event) => event.agent === agent && isChallengeEvent(event)).length,
    acceptedCalls: run.events.filter((event) => event.type === 'decision' && event.winner === agent).length,
    edits: run.events.filter((event) => event.agent === agent && isEditEvidenceEvent(event)).length,
    tasksDone: run.tasks.filter((task) => task.status === 'done' && (task.claimedBy === agent || task.claimedBy === 'both')).length,
    repairSaves: run.events.filter((event) => event.agent === agent && event.type === 'repair.completed').length,
    acceptedContributions: current
      ? Number(current.contributions.has(agent))
      : receipts.filter(receiptIsAccepted).length,
    acceptedReviews: current ? Number(current.reviews.has(agent)) : 0,
    continuingContributions: receipts.filter((receipt) => receipt.status === 'continuing').length,
    blockedContributions: receipts.filter((receipt) => receipt.status === 'blocked').length,
    verifiedContributions: receipts.filter((receipt) => receipt.verification === 'passed').length,
    handoffs: receipts.filter((receipt) => receipt.handoffRecorded).length,
    sourceFiles: receipts.reduce((total, receipt) => total + receipt.fileCount, 0),
    ...(latestMove ? { latestMove } : {})
  }
}

export function deriveEvidenceMomentum(run: RunSnapshot): EvidenceMomentumSnapshot {
  const claude = deriveAgentEvidence(run, 'claude')
  const codex = deriveAgentEvidence(run, 'codex')
  return {
    agents: {
      claude,
      codex
    },
    shared: {
      tasksDone: run.tasks.filter((task) => task.status === 'done').length,
      tasksTotal: run.tasks.length,
      buildPasses: releaseVerificationPassCount(run.events, run.releaseStatus),
      buildFailures: verificationFailureCount(run.events),
      checkpoints: run.events.filter((event) => event.type === 'git.checkpoint').length,
      acceptedContributions: Number(claude.acceptedContributions > 0) + Number(codex.acceptedContributions > 0),
      acceptedContributionGoal: 2,
      acceptedReviews: Number(claude.acceptedReviews > 0) + Number(codex.acceptedReviews > 0),
      acceptedReviewGoal: 2,
      brief: deriveBriefQualityEvidence(run),
      browser: deriveBrowserQualityEvidence(run)
    }
  }
}

export function deriveAgentContribution(
  run: RunSnapshot,
  agent: BuildAgent
): AgentContributionSummary {
  return {
    turns: run.events.filter((event) => event.agent === agent && event.type === 'agent.started').length,
    edits: run.events.filter((event) => event.agent === agent && isEditEvidenceEvent(event)).length,
    messages: run.events.filter((event) => event.agent === agent && (
      event.type === 'agent.dispatch' || event.type === 'opinion'
    )).length,
    tasksDone: run.tasks.filter((task) => task.claimedBy === agent && task.status === 'done').length
  }
}
