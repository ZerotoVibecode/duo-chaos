import { describe, expect, it } from 'vitest'
import {
  resolveStageEffort,
  resolveStageEffortDecision
} from '../../src/main/orchestrator/stage-effort-policy'

describe('quality-per-token stage effort policy', () => {
  it.each(['claude', 'codex'] as const)('routes equivalent %s work through the same semantic effort target', (agent) => {
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'work', turnKind: 'repair', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'work', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('xhigh')
  })

  it.each(['claude', 'codex'] as const)('keeps %s dialogue and mechanical stages bounded', (agent) => {
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'dialogue', turnKind: 'critique', qualityRouting: 'balanced'
    })).toBe('medium')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'dialogue', turnKind: 'consensus', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'dialogue', turnKind: 'critique',
      phase: 'round.consensus', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'work', turnKind: 'verify', qualityRouting: 'balanced'
    })).toBe('medium')
    expect(resolveStageEffort({
      agent, selected: 'max', stage: 'recovery', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('low')
  })

  it('resolves unknown CLI defaults to the same explicit work target', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'default', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'codex', selected: 'default', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('high')
  })

  it('treats a lower explicit selection as a ceiling for either provider', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'low', stage: 'work', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('low')
    expect(resolveStageEffort({
      agent: 'codex', selected: 'medium', stage: 'work', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('medium')
  })

  it('allows force-selected routing without creating an agent-specific default', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'code', qualityRouting: 'force-selected'
    })).toBe('max')
    expect(resolveStageEffort({
      agent: 'codex', selected: 'max', stage: 'work', turnKind: 'code', qualityRouting: 'force-selected'
    })).toBe('max')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'default', stage: 'work', turnKind: 'code', qualityRouting: 'force-selected'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'codex', selected: 'default', stage: 'work', turnKind: 'code', qualityRouting: 'force-selected'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'dialogue', turnKind: 'critique', qualityRouting: 'force-selected'
    })).toBe('medium')
    expect(resolveStageEffort({
      agent: 'codex', selected: 'ultra', stage: 'work', turnKind: 'verify', qualityRouting: 'force-selected'
    })).toBe('medium')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'recovery', turnKind: 'repair', qualityRouting: 'force-selected'
    })).toBe('low')
  })

  it('falls back to the closest supported level without silently upgrading cost', () => {
    const decision = resolveStageEffortDecision({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'review', qualityRouting: 'balanced',
      supportedEfforts: ['low', 'medium', 'high', 'max']
    })

    expect(decision).toMatchObject({
      selected: 'max',
      target: 'xhigh',
      requested: 'high',
      fallbackFrom: 'xhigh',
      cappedBySelection: false
    })
    expect(decision.reason).toMatch(/review|supported/i)
  })

  it('exposes a truthful requested-effort decision for UI and run receipts', () => {
    expect(resolveStageEffortDecision({
      agent: 'codex', selected: 'ultra', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toEqual(expect.objectContaining({
      agent: 'codex',
      selected: 'ultra',
      target: 'high',
      requested: 'high',
      qualityRouting: 'balanced',
      cappedBySelection: false,
      fallbackFrom: undefined
    }))
  })
})
