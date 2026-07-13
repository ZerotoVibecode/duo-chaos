import { describe, expect, it } from 'vitest'
import { VisibleActivityBudget } from '../../src/main/events/activity-budget'
import type { DuoEvent } from '../../src/shared/types'

function activity(id: string, category: DuoEvent['category'], type: DuoEvent['type'] = 'agent.activity'): DuoEvent {
  return {
    id,
    type,
    runId: 'run-budget',
    round: 1,
    timestamp: new Date().toISOString(),
    agent: 'codex',
    source: 'codex',
    stream: category === 'error' ? 'stderr' : 'stdout',
    publicText: category === 'error' ? 'Codex reported a private CLI error.' : 'Codex is inspecting the shared workspace.',
    spoilerRisk: 0.05,
    severity: category === 'error' ? 'high' : 'low',
    category
  }
}

describe('visible activity budget', () => {
  it('collapses multiline stderr fan-out into one visible error pair', () => {
    const budget = new VisibleActivityBudget()
    const accepted = Array.from({ length: 40 }, (_, index) => [
      activity(`log-${String(index)}`, 'error', 'cli.log'),
      activity(`activity-${String(index)}`, 'error')
    ]).flat().filter((event) => budget.accept(event))

    expect(accepted).toHaveLength(2)
    expect(accepted.map((event) => event.type)).toEqual(['cli.log', 'agent.activity'])
  })

  it('keeps useful categories bounded during a noisy turn', () => {
    const budget = new VisibleActivityBudget({ maxVisible: 12, maxRepeated: 2 })
    const accepted = Array.from({ length: 100 }, (_, index) =>
      activity(`event-${String(index)}`, index % 2 === 0 ? 'command' : 'file')
    ).filter((event) => budget.accept(event))

    expect(accepted.length).toBeLessThanOrEqual(4)
  })

  it('opens a fresh bounded activity window during a long work lease', () => {
    let now = 0
    const budget = new VisibleActivityBudget({
      maxVisible: 2,
      maxRepeated: 1,
      windowMs: 60_000,
      now: () => now
    })

    expect(budget.accept(activity('first-inspection', 'command'))).toBe(true)
    expect(budget.accept(activity('duplicate-inspection', 'command'))).toBe(false)
    expect(budget.accept(activity('first-edit', 'file'))).toBe(true)
    expect(budget.accept(activity('window-full', 'status'))).toBe(false)

    now = 60_001

    expect(budget.accept(activity('next-window-inspection', 'command'))).toBe(true)
    expect(budget.accept(activity('next-window-edit', 'file'))).toBe(true)
  })

  it.each([
    ['passed', { verificationPassed: true }],
    ['failed', { verificationFailed: true }]
  ])('never drops trusted verification %s proof behind visible or repeated activity caps', (_outcome, metadata) => {
    const budget = new VisibleActivityBudget({ maxVisible: 1, maxRepeated: 1 })
    const verification = {
      ...activity('verification-proof', 'command'),
      publicText: 'Claude finished a verification command.',
      metadata
    }

    expect(budget.accept(activity('window-full', 'status'))).toBe(true)
    expect(budget.accept(verification)).toBe(true)
    expect(budget.accept({ ...verification, id: 'repeated-verification-proof' })).toBe(true)
  })
})
