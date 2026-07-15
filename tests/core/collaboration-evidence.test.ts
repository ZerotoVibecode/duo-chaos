import { describe, expect, it } from 'vitest'
import {
  buildReviewReceipt,
  hasCompletedOwnedTask,
  hasReciprocalReviewEvidence,
  parseReviewReceiptsJsonl,
  promotedSurvivingContributionReceipts,
  reviewAcceptsCurrentRevision
} from '../../src/main/orchestrator/collaboration-evidence'
import {
  buildContributionReceipt,
  survivingContributionCandidates
} from '../../src/main/orchestrator/contribution-receipt'
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

  it('lets exact-current private supervisor proof close only an accepted no-delta review', () => {
    const targetHandoff = dispatch('codex-target-handoff', 'codex', 5, { replyTo: 'claude-opening' })
    const target = buildContributionReceipt({
      runId: 'run-collaboration-evidence', round: 5, turnId: 'turn-5', agent: 'codex', kind: 'code',
      tasks: [{
        id: 'codex-slice', publicTitle: 'Engine slice', status: 'done', claimedBy: 'codex', risk: 'high',
        impact: 'core', privateExpectedOutcome: 'The exact engine slice survives in the current artifact.',
        privateAcceptanceChecks: ['The engine behavior passes supervisor verification.'],
        files: ['[WORKSPACE_FILE]'], privateFiles: ['app/**']
      }],
      events: [targetHandoff],
      diff: { changed: true, files: ['app/engine.ts'], fileCount: 1, insertions: 40, deletions: 1, truncated: false },
      verification: 'unknown', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:current'
    })
    const reviewEvent = dispatch('claude-current-review', 'claude', 6, { replyTo: targetHandoff.id })
    const reviewerTurn = buildContributionReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', agent: 'claude', kind: 'review',
      tasks: [{
        id: 'claude-slice', publicTitle: 'Experience slice', status: 'done', claimedBy: 'claude', risk: 'high',
        impact: 'core', privateExpectedOutcome: 'The experience slice remains accepted.',
        privateAcceptanceChecks: ['The current artifact passes independent verification.'],
        files: ['[WORKSPACE_FILE]'], privateFiles: ['app/**']
      }],
      events: [reviewEvent],
      diff: { changed: false, files: [], fileCount: 0, insertions: 0, deletions: 0, truncated: false },
      verification: 'unknown', accepted: true,
      baseRevision: 1, resultRevision: 1,
      baseFingerprint: 'sha256:current', resultFingerprint: 'sha256:current'
    })
    const events = [targetHandoff, reviewEvent]
    const review = buildReviewReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', reviewer: 'claude',
      targetContribution: target, reviewedRevision: 1, reviewedFingerprint: 'sha256:current',
      events, verification: 'unknown', accepted: true, sourceChanged: false
    })
    expect(review).toBeDefined()
    if (!review) throw new Error('Expected an exact-current no-delta review receipt.')
    expect(review.disposition).toBe('changes-requested')

    const strictOptions = {
      allowPromotedTarget: true,
      independentlyVerified: true,
      reviewerTurnReceipts: [target, reviewerTurn]
    }
    expect(reviewAcceptsCurrentRevision(
      review, [target], 1, 'sha256:current', events, strictOptions
    )).toBe(true)
    expect(reviewAcceptsCurrentRevision(
      review, [target], 1, 'sha256:current', events,
      { ...strictOptions, independentlyVerified: false }
    )).toBe(false)
    expect(reviewAcceptsCurrentRevision(
      review, [target], 1, 'sha256:current', events,
      { ...strictOptions, reviewerTurnReceipts: [target] }
    )).toBe(false)
    expect(reviewAcceptsCurrentRevision(
      review, [target], 1, 'sha256:current', events,
      { ...strictOptions, reviewerTurnReceipts: [{ ...reviewerTurn, sourceChanged: true }] }
    )).toBe(false)
    expect(reviewAcceptsCurrentRevision(
      { ...review, accepted: false }, [target], 1, 'sha256:current', events, strictOptions
    )).toBe(false)
    expect(reviewAcceptsCurrentRevision(
      review, [target], 2, 'sha256:later', events, strictOptions
    )).toBe(false)
  })

  it('rejects a generic handoff and legacy review record as final review proof', () => {
    expect(buildReviewReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', reviewer: 'claude',
      reviewedRevision: 1, reviewedFingerprint: 'sha256:codex', events: [],
      verification: 'passed', accepted: true, sourceChanged: false
    })).toBeUndefined()
    expect(parseReviewReceiptsJsonl(JSON.stringify({ id: 'legacy', runId: 'run-collaboration-evidence' }), 'run-collaboration-evidence')).toEqual([])
  })

  it('promotes a surviving material edit after exact-current independent proof without demanding a no-op repair', () => {
    const tasks: DuoTask[] = [
      {
        id: 'claude-slice', publicTitle: 'Experience slice', status: 'done', claimedBy: 'claude', risk: 'high',
        impact: 'core', privateExpectedOutcome: 'The interaction remains usable in the finished artifact.',
        privateAcceptanceChecks: ['The finished interaction passes independent verification.'],
        files: ['[WORKSPACE_FILE]'], privateFiles: ['app/claude/**']
      },
      {
        id: 'codex-slice', publicTitle: 'Engine slice', status: 'done', claimedBy: 'codex', risk: 'high',
        impact: 'core', privateExpectedOutcome: 'The engine remains correct in the finished artifact.',
        privateAcceptanceChecks: ['The finished engine passes independent verification.'],
        files: ['[WORKSPACE_FILE]'], privateFiles: ['app/codex/**']
      }
    ]
    const claudeHandoff = dispatch('claude-handoff', 'claude', 5, { replyTo: 'codex-opening' })
    const codexHandoff = dispatch('codex-handoff', 'codex', 6, { replyTo: claudeHandoff.id })
    const claude = buildContributionReceipt({
      runId: 'run-collaboration-evidence', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks, events: [claudeHandoff],
      diff: { changed: true, files: ['app/claude/experience.tsx'], fileCount: 1, insertions: 60, deletions: 2, truncated: false },
      verification: 'unknown', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })
    const codex = buildContributionReceipt({
      runId: 'run-collaboration-evidence', round: 6, turnId: 'turn-6', agent: 'codex', kind: 'code',
      tasks, events: [codexHandoff],
      diff: { changed: true, files: ['app/codex/engine.ts'], fileCount: 1, insertions: 45, deletions: 1, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 1, resultRevision: 2,
      baseFingerprint: 'sha256:claude', resultFingerprint: 'sha256:current'
    })
    const reviewEvent = dispatch('codex-current-review', 'codex', 7, { replyTo: claudeHandoff.id })
    const events = [claudeHandoff, codexHandoff, reviewEvent]

    expect(claude.status).toBe('continuing')
    expect(survivingContributionCandidates([claude, codex], 2, 'sha256:current', events)).toEqual([claude, codex])
    const review = buildReviewReceipt({
      runId: 'run-collaboration-evidence', round: 7, turnId: 'turn-7', reviewer: 'codex',
      targetContribution: claude, reviewedRevision: 2, reviewedFingerprint: 'sha256:current',
      events, verification: 'passed', accepted: true, sourceChanged: false
    })
    expect(review).toBeDefined()
    if (!review) throw new Error('Expected an exact-current review of the surviving contribution.')

    expect(promotedSurvivingContributionReceipts(
      [claude, codex], [review], 2, 'sha256:current', events, { independentlyVerified: true }
    )).toEqual([claude, codex])
    expect(promotedSurvivingContributionReceipts(
      [claude, codex], [review], 2, 'sha256:current', events, { independentlyVerified: false }
    )).toEqual([codex])
    expect(promotedSurvivingContributionReceipts(
      [claude, codex], [{ ...review, reviewedFingerprint: 'sha256:stale' }],
      2, 'sha256:current', events, { independentlyVerified: true }
    )).toEqual([codex])
    expect(promotedSurvivingContributionReceipts(
      [claude, codex], [review], 2, 'sha256:current', events.filter((event) => event.id !== reviewEvent.id),
      { independentlyVerified: true }
    )).toEqual([codex])
    expect(promotedSurvivingContributionReceipts(
      [claude, codex], [review], 2, 'sha256:current', events.map((event) =>
        event.id === reviewEvent.id ? { ...event, targetAgent: 'codex' } : event
      ), { independentlyVerified: true }
    )).toEqual([codex])
  })
})
