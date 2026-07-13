export type VerificationOutcome = 'passed' | 'failed'

export interface VerificationEventLike {
  type?: unknown
  category?: unknown
  metadata?: unknown
}

export interface VerificationEvidence<T extends VerificationEventLike = VerificationEventLike> {
  event: T
  index: number
  outcome: VerificationOutcome
}

function metadataOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

export function verificationOutcomeOf(event: VerificationEventLike): VerificationOutcome | undefined {
  const metadata = metadataOf(event.metadata)
  if (event.type === 'build.passed') return 'passed'
  if (event.type === 'build.failed') return 'failed'
  if (event.type !== 'agent.activity') return undefined
  if (event.category === 'command' && metadata.verificationPassed === true) return 'passed'
  if ((event.category === 'command' || event.category === 'error') && metadata.verificationFailed === true) return 'failed'
  return undefined
}

export function latestVerificationEvidence<T extends VerificationEventLike>(events: T[]): VerificationEvidence<T> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    const outcome = verificationOutcomeOf(event)
    if (outcome) return { event, index, outcome }
  }
  return undefined
}

export function currentVerificationPassCount<T extends VerificationEventLike>(events: T[]): number {
  const latest = latestVerificationEvidence(events)
  if (!latest || latest.outcome !== 'passed') return 0
  let lastFailure = -1
  for (let index = latest.index - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && verificationOutcomeOf(event) === 'failed') {
      lastFailure = index
      break
    }
  }
  return events.slice(lastFailure + 1, latest.index + 1)
    .filter((event) => verificationOutcomeOf(event) === 'passed').length
}

/**
 * A supervisor-owned ready release is written only after current trusted
 * verification succeeds. Public timelines can omit that internal proof, so a
 * ready release supplies one (and only one) pass when no public pass remains.
 * Non-ready releases stay entirely event-based.
 */
export function releaseVerificationPassCount<T extends VerificationEventLike>(
  events: T[],
  releaseStatus?: unknown
): number {
  return Math.max(currentVerificationPassCount(events), releaseStatus === 'ready' ? 1 : 0)
}

export function verificationFailureCount<T extends VerificationEventLike>(events: T[]): number {
  return events.filter((event) => verificationOutcomeOf(event) === 'failed').length
}
