import { describe, expect, it } from 'vitest'
import { canReveal, transitionRun } from '../../src/main/orchestrator/state-machine'

describe('run state machine', () => {
  it('moves through the valid opening lifecycle', () => {
    expect(transitionRun('idle', 'START')).toBe('preflight')
    expect(transitionRun('preflight', 'PREFLIGHT_OK')).toBe('workspace.create')
    expect(transitionRun('workspace.create', 'WORKSPACE_READY')).toBe('round.pitch')
  })

  it('supports cancellation from an active state', () => {
    expect(transitionRun('round.code', 'CANCEL')).toBe('cancelled')
  })

  it('suspends active work and allows an explicit resume preflight', () => {
    expect(transitionRun('round.code', 'PAUSE')).toBe('paused')
    expect(transitionRun('paused', 'RESUME')).toBe('preflight')
  })

  it('rejects invalid state transitions', () => {
    expect(() => transitionRun('idle', 'REVEAL_READY')).toThrow(/Invalid transition/)
  })

  it('only enables reveal for the reveal-ready and complete states', () => {
    expect(canReveal('round.verify')).toBe(false)
    expect(canReveal('reveal.ready')).toBe(true)
    expect(canReveal('complete')).toBe(true)
  })
})
