import { describe, expect, it } from 'vitest'
import * as spectatorState from '../../src/renderer/src/lib/spectator-state'
import type { AgentId, DuoEvent } from '../../src/shared/types'

type ExchangeSlot = {
  sourceEventId: string
  speaker: Extract<AgentId, 'claude' | 'codex' | 'director'>
  text: string
}

type ExchangeArc = {
  claimKey?: string
  opening?: ExchangeSlot
  counter?: ExchangeSlot
  verdict?: ExchangeSlot
}

const deriveBroadcastExchange = (spectatorState as unknown as {
  deriveBroadcastExchange?: (events: DuoEvent[]) => ExchangeArc
}).deriveBroadcastExchange

function event(overrides: Partial<DuoEvent> & Pick<DuoEvent, 'id' | 'type' | 'agent' | 'publicText'>): DuoEvent {
  return {
    runId: 'run-exchange-contract',
    round: 2,
    timestamp: '2026-07-10T18:00:00.000Z',
    spoilerRisk: 0.05,
    severity: 'medium',
    ...overrides
  }
}

describe('broadcast exchange arc', () => {
  it('builds one factual Opening -> Counter -> Verdict chain from sourced public records', () => {
    expect(deriveBroadcastExchange).toBeTypeOf('function')
    if (!deriveBroadcastExchange) return

    const exchange = deriveBroadcastExchange([
      event({
        id: 'opening-focus',
        type: 'agent.dispatch',
        agent: 'claude',
        dispatchKind: 'opening',
        claimKey: 'scope-focus',
        targetAgent: 'codex',
        publicText: 'I want one legible interaction with an explicit completion state.'
      }),
      event({
        id: 'counter-focus',
        type: 'agent.dispatch',
        agent: 'codex',
        dispatchKind: 'counter',
        claimKey: 'scope-focus',
        replyTo: 'opening-focus',
        targetAgent: 'claude',
        timestamp: '2026-07-10T18:00:20.000Z',
        publicText: 'I agree on one interaction, but it needs a second input path before release.'
      }),
      event({
        id: 'verdict-focus',
        type: 'decision',
        agent: 'director',
        claimKey: 'scope-focus',
        replyTo: 'counter-focus',
        timestamp: '2026-07-10T18:00:40.000Z',
        publicText: 'The focused interaction and alternate input path both survive.'
      })
    ])

    expect(exchange).toEqual({
      claimKey: 'scope-focus',
      opening: {
        sourceEventId: 'opening-focus',
        speaker: 'claude',
        text: 'I want one legible interaction with an explicit completion state.'
      },
      counter: {
        sourceEventId: 'counter-focus',
        speaker: 'codex',
        text: 'I agree on one interaction, but it needs a second input path before release.'
      },
      verdict: {
        sourceEventId: 'verdict-focus',
        speaker: 'director',
        text: 'The focused interaction and alternate input path both survive.'
      }
    })
  })

  it('does not fill a new exchange with replies from another claim chain', () => {
    expect(deriveBroadcastExchange).toBeTypeOf('function')
    if (!deriveBroadcastExchange) return

    const exchange = deriveBroadcastExchange([
      event({
        id: 'old-opening',
        type: 'agent.dispatch',
        agent: 'codex',
        dispatchKind: 'opening',
        claimKey: 'old-direction',
        publicText: 'An older direction opened first.'
      }),
      event({
        id: 'new-opening',
        type: 'agent.dispatch',
        agent: 'claude',
        dispatchKind: 'opening',
        claimKey: 'new-direction',
        timestamp: '2026-07-10T18:01:00.000Z',
        publicText: 'This is the new position now on the record.'
      }),
      event({
        id: 'late-old-counter',
        type: 'agent.dispatch',
        agent: 'claude',
        dispatchKind: 'counter',
        claimKey: 'old-direction',
        replyTo: 'old-opening',
        timestamp: '2026-07-10T18:01:10.000Z',
        publicText: 'This reply belongs only to the older direction.'
      }),
      event({
        id: 'unrelated-activity',
        type: 'agent.activity',
        agent: 'codex',
        category: 'command',
        timestamp: '2026-07-10T18:01:20.000Z',
        publicText: 'Codex is inspecting the workspace.'
      })
    ])

    expect(exchange.claimKey).toBe('new-direction')
    expect(exchange.opening).toMatchObject({ sourceEventId: 'new-opening' })
    expect(exchange.counter).toBeUndefined()
    expect(exchange.verdict).toBeUndefined()
    expect(JSON.stringify(exchange)).not.toContain('older direction')
    expect(JSON.stringify(exchange)).not.toContain('inspecting the workspace')
  })

  it('leaves missing counter and verdict slots empty instead of inventing dialogue', () => {
    expect(deriveBroadcastExchange).toBeTypeOf('function')
    if (!deriveBroadcastExchange) return

    const exchange = deriveBroadcastExchange([
      event({
        id: 'only-opening',
        type: 'agent.dispatch',
        agent: 'claude',
        dispatchKind: 'position',
        claimKey: 'single-record',
        publicText: 'Only this opening position has been filed.'
      })
    ])

    expect(exchange.opening).toMatchObject({ sourceEventId: 'only-opening' })
    expect(exchange.counter).toBeUndefined()
    expect(exchange.verdict).toBeUndefined()
  })
})
