import { describe, expect, it } from 'vitest'
import { StageEventLedger } from '../../src/main/orchestrator/stage-event-ledger'
import type { DuoEvent } from '../../src/shared/types'

function event(index: number): DuoEvent {
  return {
    id: `event-${String(index)}`,
    type: 'cli.log',
    runId: 'run-ledger',
    round: 6,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    agent: 'codex',
    publicText: `signal ${String(index)}`,
    spoilerRisk: 0,
    severity: 'low'
  }
}

describe('stage event ledger', () => {
  it('keeps stage evidence addressable after the renderer retention window is full', () => {
    const ledger = new StageEventLedger()
    for (let index = 0; index < 650; index += 1) ledger.append(event(index))
    const cursor = ledger.cursor()
    for (let index = 650; index < 675; index += 1) ledger.append(event(index))

    expect(ledger.since(cursor).map((item) => item.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `event-${String(index + 650)}`)
    )
  })
})
