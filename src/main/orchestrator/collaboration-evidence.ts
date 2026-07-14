import type { DuoEvent, DuoTask } from '@shared/types'
import {
  receiptCompletesOwnedContribution,
  type ContributionReceipt,
  type ContributionVerification
} from './contribution-receipt'

type CollaboratingAgent = Extract<DuoEvent['agent'], 'claude' | 'codex'>

export type ReviewDisposition = 'accepted' | 'changes-applied' | 'changes-requested' | 'blocked'

export interface ReviewReceipt {
  schemaVersion: 1
  id: string
  runId: string
  round: number
  turnId: string
  reviewer: CollaboratingAgent
  targetAgent: CollaboratingAgent
  targetContributionId: string
  reviewedRevision: number
  reviewedFingerprint: string
  disposition: ReviewDisposition
  verification: ContributionVerification
  evidenceEventIds: string[]
  accepted: boolean
}

export interface BuildReviewReceiptInput {
  runId: string
  round: number
  turnId: string
  reviewer: CollaboratingAgent
  targetContribution?: ContributionReceipt
  reviewedRevision: number
  reviewedFingerprint?: string
  events: DuoEvent[]
  verification: ContributionVerification
  accepted: boolean
  sourceChanged: boolean
}

function validFingerprint(value: string): boolean {
  return /^sha256:[a-z0-9-]{3,}$/u.test(value)
}

/**
 * Creates review proof only when the supervisor can bind a substantive review
 * move to an exact opponent contribution and exact app revision. A reply-linked
 * message by itself is deliberately insufficient.
 */
export function buildReviewReceipt(input: BuildReviewReceiptInput): ReviewReceipt | undefined {
  const target = input.targetContribution
  const targetAgent: CollaboratingAgent = input.reviewer === 'claude' ? 'codex' : 'claude'
  if (!target || target.agent !== targetAgent || !receiptCompletesOwnedContribution(target, input.events)) return undefined
  if (!input.reviewedFingerprint || !validFingerprint(input.reviewedFingerprint)) return undefined
  const evidenceEventIds = input.events.filter((event) =>
    event.round === input.round && event.agent === input.reviewer && event.publicText.trim().length > 0 &&
    (event.type === 'agent.dispatch' || event.type === 'opinion' || event.type === 'conflict')
  ).map((event) => event.id)
  if (evidenceEventIds.length === 0) return undefined
  const disposition: ReviewDisposition = input.accepted && input.verification === 'passed'
    ? input.sourceChanged ? 'changes-applied' : 'accepted'
    : input.accepted
      ? 'changes-requested'
      : 'blocked'
  return {
    schemaVersion: 1,
    id: `review-${input.turnId}-${input.reviewer}-${String(input.round)}`,
    runId: input.runId,
    round: input.round,
    turnId: input.turnId,
    reviewer: input.reviewer,
    targetAgent,
    targetContributionId: target.id,
    reviewedRevision: input.reviewedRevision,
    reviewedFingerprint: input.reviewedFingerprint,
    disposition,
    verification: input.verification,
    evidenceEventIds,
    accepted: input.accepted
  }
}

export function reviewAcceptsCurrentRevision(
  review: ReviewReceipt,
  contributions: ContributionReceipt[],
  currentRevision: number,
  currentFingerprint: string | undefined,
  supervisorEvents: DuoEvent[]
): boolean {
  if (!currentFingerprint || review.schemaVersion !== 1) return false
  const target = contributions.find((receipt) => receipt.id === review.targetContributionId)
  const events = new Map(supervisorEvents.map((event) => [event.id, event]))
  const reviewEvidenceMatches = review.evidenceEventIds.length > 0 && review.evidenceEventIds.every((id) => {
    const event = events.get(id)
    return event?.agent === review.reviewer && event.round === review.round && event.publicText.trim().length > 0 &&
      (event.type === 'agent.dispatch' || event.type === 'opinion' || event.type === 'conflict')
  })
  return review.accepted && (review.disposition === 'accepted' || review.disposition === 'changes-applied') &&
    review.verification === 'passed' && reviewEvidenceMatches &&
    review.reviewedRevision === currentRevision && review.reviewedFingerprint === currentFingerprint &&
    target !== undefined && target.agent === review.targetAgent && target.agent !== review.reviewer &&
    receiptCompletesOwnedContribution(target, supervisorEvents)
}

export function parseReviewReceiptsJsonl(content: string, expectedRunId: string): ReviewReceipt[] {
  const latest = new Map<string, ReviewReceipt>()
  for (const line of content.split(/\r?\n/u).slice(-500)) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (!isReviewReceipt(value, expectedRunId)) continue
    latest.set(value.id, value)
  }
  return [...latest.values()].sort((left, right) => left.round - right.round)
}

function isReviewReceipt(value: unknown, expectedRunId: string): value is ReviewReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Partial<ReviewReceipt>
  return receipt.schemaVersion === 1 && receipt.runId === expectedRunId &&
    typeof receipt.id === 'string' && receipt.id.length > 0 &&
    typeof receipt.round === 'number' && Number.isInteger(receipt.round) && receipt.round > 0 &&
    typeof receipt.turnId === 'string' && receipt.turnId.length > 0 &&
    (receipt.reviewer === 'claude' || receipt.reviewer === 'codex') &&
    (receipt.targetAgent === 'claude' || receipt.targetAgent === 'codex') && receipt.reviewer !== receipt.targetAgent &&
    typeof receipt.targetContributionId === 'string' && receipt.targetContributionId.length > 0 &&
    typeof receipt.reviewedRevision === 'number' && Number.isInteger(receipt.reviewedRevision) && receipt.reviewedRevision >= 0 &&
    typeof receipt.reviewedFingerprint === 'string' && validFingerprint(receipt.reviewedFingerprint) &&
    ['accepted', 'changes-applied', 'changes-requested', 'blocked'].includes(receipt.disposition ?? '') &&
    ['passed', 'failed', 'unknown'].includes(receipt.verification ?? '') &&
    Array.isArray(receipt.evidenceEventIds) && receipt.evidenceEventIds.length > 0 &&
    receipt.evidenceEventIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof receipt.accepted === 'boolean'
}

export function hasReciprocalReviewEvidence(
  events: DuoEvent[],
  agent: CollaboratingAgent,
  round: number
): boolean {
  const opponent: CollaboratingAgent = agent === 'claude' ? 'codex' : 'claude'
  const eventIndex = new Map(events.map((event, index) => [event.id, { event, index }]))
  return events.some((event, index) => {
    if (
      event.type !== 'agent.dispatch' || event.agent !== agent || event.round !== round ||
      event.targetAgent !== opponent || !event.replyTo
    ) return false
    const replied = eventIndex.get(event.replyTo)
    return Boolean(
      replied && replied.index < index && replied.event.type === 'agent.dispatch' && replied.event.agent === opponent
    )
  })
}

export function hasCompletedOwnedTask(tasks: DuoTask[], agent: CollaboratingAgent): boolean {
  return tasks.some((task) => task.status === 'done' && task.claimedBy === agent)
}
