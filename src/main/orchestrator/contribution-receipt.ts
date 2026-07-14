import type { DuoEvent, DuoTask } from '@shared/types'
import type { AppChangeSummary } from '@main/git/git-manager'
import type { RealTurnKind } from './real-turn-plan'

export type ContributionReceiptStatus = 'complete' | 'continuing' | 'blocked' | 'rejected'
export type ContributionVerification = 'passed' | 'failed' | 'unknown'

export interface ContributionTaskProof {
  taskId: string
  impact?: 'core' | 'substantial'
  expectedOutcome: string
  acceptanceChecks: string[]
  expectedFiles: string[]
  touchedFiles: string[]
  materialContract: boolean
  boundaryMatched: boolean
  acceptanceSatisfied: boolean
}

export interface ContributionReceipt {
  schemaVersion: 2
  id: string
  runId: string
  round: number
  turnId: string
  agent: 'claude' | 'codex'
  kind: RealTurnKind
  status: ContributionReceiptStatus
  taskIds: string[]
  /** Private supervisor proof. Public events expose only aggregate counts. */
  taskProof: ContributionTaskProof[]
  files: string[]
  fileCount: number
  insertions: number
  deletions: number
  sourceChanged: boolean
  verification: ContributionVerification
  handoffRecorded: boolean
  /** Supervisor event ids that prove the reply-linked teammate handoff. */
  handoffEventIds: string[]
  accepted: boolean
  unresolvedRisks: string[]
  baseRevision: number
  resultRevision: number
  baseFingerprint: string
  resultFingerprint: string
}

export interface BuildContributionReceiptInput {
  runId: string
  round: number
  turnId: string
  agent: 'claude' | 'codex'
  kind: RealTurnKind
  tasks: DuoTask[]
  events: DuoEvent[]
  diff: AppChangeSummary
  verification: ContributionVerification
  accepted: boolean
  baseRevision: number
  resultRevision: number
  baseFingerprint: string
  resultFingerprint: string
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/')
}

function boundaryMatchesFile(boundary: string, file: string): boolean {
  const expected = normalizedPath(boundary)
  const actual = normalizedPath(file)
  if (!expected || expected === '[WORKSPACE_FILE]') return false
  const pattern = expected
    .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*')
  return new RegExp(`^${pattern}${expected.endsWith('/') ? '.*' : ''}$`, 'iu').test(actual)
}

function taskProofFor(
  task: DuoTask,
  changedFiles: string[],
  verification: ContributionVerification
): ContributionTaskProof {
  const expectedFiles = [...(task.privateFiles?.length ? task.privateFiles : task.files)]
  const materialExpectedFiles = expectedFiles.filter((file) => file !== '[WORKSPACE_FILE]')
  const acceptanceChecks = [...(task.privateAcceptanceChecks ?? [])]
  const expectedOutcome = task.privateExpectedOutcome ?? task.privateDescription ?? task.publicDescription ?? task.publicTitle
  const materialContract = Boolean(
    task.impact && task.privateExpectedOutcome && acceptanceChecks.length > 0 && materialExpectedFiles.length > 0
  )
  const touchedFiles = materialExpectedFiles.length > 0
    ? changedFiles.filter((file) => materialExpectedFiles.some((boundary) => boundaryMatchesFile(boundary, file)))
    : [...changedFiles]
  return {
    taskId: task.id,
    ...(task.impact ? { impact: task.impact } : {}),
    expectedOutcome,
    acceptanceChecks: acceptanceChecks.length > 0
      ? acceptanceChecks
      : [`Complete and verify ${task.publicTitle}.`],
    expectedFiles,
    touchedFiles,
    materialContract,
    boundaryMatched: touchedFiles.length > 0,
    acceptanceSatisfied: task.status === 'done' && verification === 'passed'
  }
}

export function buildContributionReceipt(input: BuildContributionReceiptInput): ContributionReceipt {
  const ownedTasks = input.tasks.filter((task) => task.claimedBy === input.agent)
  const completedOwnedTasks = ownedTasks.filter((task) => task.status === 'done')
  const ownedTaskComplete = completedOwnedTasks.length > 0
  const ownedTaskBlocked = ownedTasks.some((task) => task.status === 'blocked')
  // One turn may legitimately close one material task while another owned task
  // remains open. Bind this receipt only to contracts completed by this turn;
  // later tasks must earn their own proof instead of invalidating real work.
  const taskProof = completedOwnedTasks.map((task) => taskProofFor(task, input.diff.files, input.verification))
  const materialProofComplete = taskProof.length > 0 && taskProof.every((proof) =>
    proof.materialContract && proof.boundaryMatched && proof.acceptanceSatisfied
  )
  const handoffEvents = input.events.filter((event) =>
    event.type === 'agent.dispatch' && event.agent === input.agent && event.round === input.round &&
    event.targetAgent === (input.agent === 'claude' ? 'codex' : 'claude') && Boolean(event.replyTo)
  )
  const handoffEventIds = [...new Set(handoffEvents.map((event) => event.id))]
  const handoffRecorded = handoffEventIds.length > 0
  const unresolvedRisks: string[] = []
  if (!ownedTaskComplete) unresolvedRisks.push('owned-task-incomplete')
  if (taskProof.length === 0 || taskProof.some((proof) => !proof.materialContract)) {
    unresolvedRisks.push('owned-task-contract-missing')
  }
  if (taskProof.some((proof) => proof.materialContract && !proof.boundaryMatched)) {
    unresolvedRisks.push('owned-task-boundary-missed')
  }
  if (taskProof.some((proof) => proof.materialContract && !proof.acceptanceSatisfied)) {
    unresolvedRisks.push('owned-task-acceptance-unproven')
  }
  if (!input.diff.changed) unresolvedRisks.push('no-source-delta')
  if (input.verification !== 'passed') unresolvedRisks.push(
    input.verification === 'failed' ? 'verification-failed' : 'verification-missing'
  )
  if (!handoffRecorded) unresolvedRisks.push('reply-linked-handoff-missing')
  if (!input.accepted) unresolvedRisks.push('stage-not-accepted')
  const revisionBound = validFingerprint(input.baseFingerprint) && validFingerprint(input.resultFingerprint) &&
    (input.diff.changed
      ? input.resultRevision === input.baseRevision + 1 && input.baseFingerprint !== input.resultFingerprint
      : input.resultRevision === input.baseRevision && input.baseFingerprint === input.resultFingerprint)
  if (!revisionBound) unresolvedRisks.push('revision-proof-missing')

  const complete = input.accepted && ownedTaskComplete && input.diff.changed &&
    input.verification === 'passed' && handoffRecorded && revisionBound && materialProofComplete
  const status: ContributionReceiptStatus = complete
    ? 'complete'
    : ownedTaskBlocked
      ? 'blocked'
      : input.accepted || input.diff.changed
        ? 'continuing'
        : 'rejected'

  return {
    schemaVersion: 2,
    id: `contribution-${input.turnId}-${input.agent}-${String(input.round)}`,
    runId: input.runId,
    round: input.round,
    turnId: input.turnId,
    agent: input.agent,
    kind: input.kind,
    status,
    taskIds: completedOwnedTasks.map((task) => task.id),
    taskProof,
    files: [...input.diff.files],
    fileCount: input.diff.fileCount,
    insertions: input.diff.insertions,
    deletions: input.diff.deletions,
    sourceChanged: input.diff.changed,
    verification: input.verification,
    handoffRecorded,
    handoffEventIds,
    accepted: input.accepted,
    unresolvedRisks,
    baseRevision: input.baseRevision,
    resultRevision: input.resultRevision,
    baseFingerprint: input.baseFingerprint,
    resultFingerprint: input.resultFingerprint
  }
}

function handoffEvidenceMatches(receipt: ContributionReceipt, supervisorEvents: DuoEvent[]): boolean {
  if (receipt.handoffEventIds.length === 0) return false
  const events = new Map(supervisorEvents.map((event) => [event.id, event]))
  return receipt.handoffEventIds.every((id) => {
    const event = events.get(id)
    return event?.type === 'agent.dispatch' && event.agent === receipt.agent && event.round === receipt.round &&
      event.targetAgent === (receipt.agent === 'claude' ? 'codex' : 'claude') && Boolean(event.replyTo)
  })
}

export function receiptCompletesOwnedContribution(
  receipt: ContributionReceipt,
  supervisorEvents: DuoEvent[]
): boolean {
  const taskProofComplete = receipt.taskProof.length > 0 && receipt.taskProof.every((proof) =>
    proof.materialContract && proof.boundaryMatched && proof.acceptanceSatisfied
  )
  return receipt.schemaVersion === 2 && validRevisionTransition(receipt) &&
    receipt.status === 'complete' && receipt.sourceChanged && receipt.accepted &&
    receipt.verification === 'passed' && receipt.handoffRecorded && receipt.taskIds.length > 0 && taskProofComplete &&
    handoffEvidenceMatches(receipt, supervisorEvents)
}

function validFingerprint(value: string): boolean {
  return /^sha256:[a-f0-9]{6,}$/u.test(value) || /^sha256:[a-z0-9-]{3,}$/u.test(value)
}

function validRevisionTransition(receipt: ContributionReceipt): boolean {
  if (!validFingerprint(receipt.baseFingerprint) || !validFingerprint(receipt.resultFingerprint)) return false
  return receipt.sourceChanged
    ? receipt.resultRevision === receipt.baseRevision + 1 && receipt.baseFingerprint !== receipt.resultFingerprint
    : receipt.resultRevision === receipt.baseRevision && receipt.baseFingerprint === receipt.resultFingerprint
}

/**
 * Reconstructs the exact supervisor-recorded app ancestry ending at the current
 * fingerprint. A receipt outside that chain cannot be used as current quality
 * proof, even if an older manifest still listed its agent as accepted.
 */
export function survivingContributionReceipts(
  receipts: ContributionReceipt[],
  currentRevision: number,
  currentFingerprint: string | undefined,
  supervisorEvents: DuoEvent[]
): ContributionReceipt[] {
  if (!currentFingerprint || !validFingerprint(currentFingerprint) || currentRevision < 1) return []
  const transitions = receipts.filter((receipt) =>
    receipt.schemaVersion === 2 && receipt.sourceChanged && validRevisionTransition(receipt)
  )
  const ancestry: ContributionReceipt[] = []
  let revision = currentRevision
  let fingerprint = currentFingerprint
  const visited = new Set<string>()
  while (revision > 0) {
    const transition = transitions
      .filter((receipt) => receipt.resultRevision === revision && receipt.resultFingerprint === fingerprint)
      .sort((left, right) => right.round - left.round)[0]
    if (!transition || visited.has(transition.id)) return []
    visited.add(transition.id)
    ancestry.push(transition)
    revision = transition.baseRevision
    fingerprint = transition.baseFingerprint
  }
  return ancestry
    .filter((receipt) => receiptCompletesOwnedContribution(receipt, supervisorEvents))
    .sort((left, right) => left.resultRevision - right.resultRevision)
}

export function contributionBalance(receipts: ContributionReceipt[], supervisorEvents: DuoEvent[]): {
  claude: number
  codex: number
  balanced: boolean
} {
  const accepted = receipts.filter((receipt) => receiptCompletesOwnedContribution(receipt, supervisorEvents))
  const claude = accepted.filter((receipt) => receipt.agent === 'claude').length
  const codex = accepted.filter((receipt) => receipt.agent === 'codex').length
  return { claude, codex, balanced: claude > 0 && codex > 0 }
}

export function parseContributionReceiptsJsonl(
  content: string,
  expectedRunId: string
): ContributionReceipt[] {
  const latest = new Map<string, ContributionReceipt>()
  for (const line of content.split(/\r?\n/u).slice(-500)) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (!isContributionReceipt(value, expectedRunId)) continue
    // Receipts written before material task contracts remain resumable. Every
    // newly-built receipt includes explicit task proof.
    if (!Array.isArray(value.taskProof)) value.taskProof = []
    if (!Array.isArray(value.handoffEventIds)) value.handoffEventIds = []
    latest.set(value.id, value)
  }
  return [...latest.values()].sort((left, right) => left.round - right.round)
}

function isContributionReceipt(value: unknown, expectedRunId: string): value is ContributionReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Partial<ContributionReceipt>
  return receipt.schemaVersion === 2 &&
    typeof receipt.id === 'string' && receipt.id.length > 0 &&
    receipt.runId === expectedRunId &&
    typeof receipt.round === 'number' && Number.isInteger(receipt.round) && receipt.round > 0 &&
    typeof receipt.turnId === 'string' &&
    (receipt.agent === 'claude' || receipt.agent === 'codex') &&
    ['pitch', 'critique', 'consensus', 'tasking', 'code', 'review', 'verify', 'repair'].includes(receipt.kind ?? '') &&
    ['complete', 'continuing', 'blocked', 'rejected'].includes(receipt.status ?? '') &&
    Array.isArray(receipt.taskIds) && receipt.taskIds.every((item) => typeof item === 'string') &&
    (receipt.taskProof === undefined || isTaskProofArray(receipt.taskProof)) &&
    Array.isArray(receipt.files) && receipt.files.every((item) => typeof item === 'string') &&
    typeof receipt.fileCount === 'number' &&
    typeof receipt.insertions === 'number' &&
    typeof receipt.deletions === 'number' &&
    typeof receipt.sourceChanged === 'boolean' &&
    ['passed', 'failed', 'unknown'].includes(receipt.verification ?? '') &&
    typeof receipt.handoffRecorded === 'boolean' &&
    (receipt.handoffEventIds === undefined || (
      Array.isArray(receipt.handoffEventIds) && receipt.handoffEventIds.every((id) => typeof id === 'string' && id.length > 0)
    )) &&
    typeof receipt.accepted === 'boolean' &&
    Array.isArray(receipt.unresolvedRisks) && receipt.unresolvedRisks.every((item) => typeof item === 'string') &&
    typeof receipt.baseRevision === 'number' && Number.isInteger(receipt.baseRevision) && receipt.baseRevision >= 0 &&
    typeof receipt.resultRevision === 'number' && Number.isInteger(receipt.resultRevision) && receipt.resultRevision >= 0 &&
    typeof receipt.baseFingerprint === 'string' && validFingerprint(receipt.baseFingerprint) &&
    typeof receipt.resultFingerprint === 'string' && validFingerprint(receipt.resultFingerprint) &&
    validRevisionTransition(receipt as ContributionReceipt)
}

function isTaskProofArray(value: unknown): value is ContributionTaskProof[] {
  return Array.isArray(value) && value.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const proof = candidate as Partial<ContributionTaskProof>
    return typeof proof.taskId === 'string' &&
      (proof.impact === undefined || proof.impact === 'core' || proof.impact === 'substantial') &&
      typeof proof.expectedOutcome === 'string' &&
      Array.isArray(proof.acceptanceChecks) && proof.acceptanceChecks.every((item) => typeof item === 'string') &&
      Array.isArray(proof.expectedFiles) && proof.expectedFiles.every((item) => typeof item === 'string') &&
      Array.isArray(proof.touchedFiles) && proof.touchedFiles.every((item) => typeof item === 'string') &&
      typeof proof.materialContract === 'boolean' &&
      typeof proof.boundaryMatched === 'boolean' &&
      typeof proof.acceptanceSatisfied === 'boolean'
  })
}
