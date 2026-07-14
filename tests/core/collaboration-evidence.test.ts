import { describe, expect, it } from 'vitest'
import {
  buildReviewReceipt,
  hasCompletedOwnedTask,
  hasReciprocalReviewEvidence,
  parseReviewReceiptsJsonl,
  reviewAcceptsCurrentRevision
} from '../../src/main/orchestrator/collaboration-evidence'
import { buildContributionReceipt } from '../../src/main/orchestrator/contribution-receipt'
import type { DuoEvent, DuoTask } from '../../src/shared/types'

function dispatch(
  id: string,
  agent: 'claude' | 'codex',
  round: number,
  additions: Partial<DuoEvent> = {}
): DuoEvent {
  return {
    id,
    type: 'agent.dispatch',
    runId: 'run-collaboration-evidence',
    round,
    timestamp: `2026-07-11T12:00:0${String(round)}.000Z`,
    agent,
    targetAgent: agent === 'claude' ? 'codex' : 'claude',
    dispatchKind: 'opening',
    publicText: 'I think the shared [FEATURE] needs one concrete change.',
    spoilerRisk: 0.02,
    severity: 'low',
    ...additions
  }
}

describe('collaboration evidence', () => {
  it('requires a review turn to reply to a real opponent dispatch', () => {
    const opponent = dispatch('codex-source-verdict', 'codex', 6)
    const linked = dispatch('claude-review-opening', 'claude', 7, { replyTo: opponent.id })

    expect(hasReciprocalReviewEvidence([opponent, linked], 'claude', 7)).toBe(true)
    expect(hasReciprocalReviewEvidence([opponent, { ...linked, replyTo: 'missing' }], 'claude', 7)).toBe(false)
    expect(hasReciprocalReviewEvidence([opponent, { ...linked, targetAgent: 'claude' }], 'claude', 7)).toBe(false)
    expect(hasReciprocalReviewEvidence([opponent, { ...linked, replyTo: undefined }], 'claude', 7)).toBe(false)
  })

  it('requires each agent to own a completed task before duo readiness', () => {
    const tasks: DuoTask[] = [
      { id: 'claude-slice', publicTitle: 'First slice', status: 'done', claimedBy: 'claude', risk: 'medium', files: ['app/a.ts'] },
      { id: 'codex-slice', publicTitle: 'Second slice', status: 'review', claimedBy: 'codex', risk: 'medium', files: ['app/b.ts'] }
    ]

    expect(hasCompletedOwnedTask(tasks, 'claude')).toBe(true)
    expect(hasCompletedOwnedTask(tasks, 'codex')).toBe(false)
  })

  it('binds an accepted review to one opponent contribution and the exact reviewed revision', () => {
    const target = buildContributionReceipt({
      runId: 'run-collaboration-evidence', round: 5, turnId: 'turn-5', agent: 'codex', kind: 'code',
      tasks: [{
        id: 'codex-slice', publicTitle: 'Slice', status: 'done', claimedBy: 'codex', risk: 'medium',
        impact: 'core', privateExpectedOutcome: 'The exact implementation slice works and is verified.',
        privateAcceptanceChecks: ['The implementation verification passes.'],
        files: ['[WORKSPACE_FILE]'], privateFiles: ['app/**']
      }],
      events: [dispatch('codex-handoff', 'codex', 5, { replyTo: 'claude-source' })],
      diff: { changed: true, files: ['app/codex.ts'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:codex'
    })
    const reviewEvent = dispatch('claude-review', 'claude', 6, { replyTo: 'codex-handoff' })
    const review = buildReviewReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', reviewer: 'claude',
      targetContribution: target, reviewedRevision: 1, reviewedFingerprint: 'sha256:codex',
      events: [dispatch('codex-handoff', 'codex', 5, { replyTo: 'claude-source' }), reviewEvent], verification: 'passed',
      accepted: true, sourceChanged: false
    })

    expect(review).toBeDefined()
    if (!review) throw new Error('Expected revision-bound review receipt.')
    const supervisorEvents = [dispatch('codex-handoff', 'codex', 5, { replyTo: 'claude-source' }), reviewEvent]
    expect(reviewAcceptsCurrentRevision(review, [target], 1, 'sha256:codex', supervisorEvents)).toBe(true)
    expect(reviewAcceptsCurrentRevision(review, [target], 2, 'sha256:later-edit', supervisorEvents)).toBe(false)
    expect(reviewAcceptsCurrentRevision(review, [target], 1, 'sha256:codex', supervisorEvents.filter((event) => event.id !== reviewEvent.id))).toBe(false)
  })

  it('rejects a generic handoff and legacy review record as final review proof', () => {
    expect(buildReviewReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', reviewer: 'claude',
      reviewedRevision: 1, reviewedFingerprint: 'sha256:codex', events: [],
      verification: 'passed', accepted: true, sourceChanged: false
    })).toBeUndefined()
    expect(parseReviewReceiptsJsonl(JSON.stringify({ id: 'legacy', runId: 'run-collaboration-evidence' }), 'run-collaboration-evidence')).toEqual([])
  })
})
