import { describe, expect, it } from 'vitest'
import {
  hasCompletedOwnedTask,
  hasReciprocalReviewEvidence
} from '../../src/main/orchestrator/collaboration-evidence'
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
})
