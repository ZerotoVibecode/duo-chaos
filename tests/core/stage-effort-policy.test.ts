import { describe, expect, it } from 'vitest'
import { resolveStageEffort } from '../../src/main/orchestrator/stage-effort-policy'

describe('quality-per-token stage effort policy', () => {
  it('treats a premium Claude selection as a ceiling instead of spending Max on long tool loops', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'repair', qualityRouting: 'balanced'
    })).toBe('high')
  })

  it('keeps dialogue and mechanical stages bounded while preserving a premium evidence review', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'dialogue', turnKind: 'critique', qualityRouting: 'balanced'
    })).toBe('medium')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'dialogue', turnKind: 'consensus', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'dialogue', turnKind: 'critique',
      phase: 'round.consensus', qualityRouting: 'balanced'
    })).toBe('high')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('max')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'recovery', turnKind: 'review', qualityRouting: 'balanced'
    })).toBe('low')
  })

  it('resolves an unknown CLI default to a bounded explicit effort for Claude work', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'default', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('high')
  })

  it('allows an explicit force-selected profile without changing low-effort selections', () => {
    expect(resolveStageEffort({
      agent: 'claude', selected: 'max', stage: 'work', turnKind: 'code', qualityRouting: 'force-selected'
    })).toBe('max')
    expect(resolveStageEffort({
      agent: 'claude', selected: 'low', stage: 'work', turnKind: 'code', qualityRouting: 'balanced'
    })).toBe('low')
  })
})
