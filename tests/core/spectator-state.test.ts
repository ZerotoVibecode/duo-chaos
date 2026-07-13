import { describe, expect, it } from 'vitest'
import { deriveArenaEvent, recentDistinctActivity } from '../../src/renderer/src/lib/spectator-state'
import type { DuoEvent } from '../../src/shared/types'

function event(overrides: Partial<DuoEvent>): DuoEvent {
  return {
    id: crypto.randomUUID(),
    type: 'agent.activity',
    runId: 'run-arena',
    round: 1,
    timestamp: new Date().toISOString(),
    agent: 'claude',
    publicText: 'Claude is inspecting the shared workspace.',
    spoilerRisk: 0.05,
    severity: 'low',
    ...overrides
  }
}

describe('spectator arena state', () => {
  it('shows truthful activity before either agent files a public position', () => {
    const arena = deriveArenaEvent([
      event({ agent: 'claude', publicText: 'Claude is comparing hidden proposals.' }),
      event({ agent: 'codex', publicText: 'Codex is checking build constraints.' })
    ])

    expect(arena).toMatchObject({
      type: 'conflict',
      publicTopic: 'Evidence is accumulating',
      claudePosition: 'Claude is comparing hidden proposals.',
      codexPosition: 'Codex is checking build constraints.'
    })
  })

  it('puts both real spoiler-safe opinions into the arena without inventing a winner', () => {
    const arena = deriveArenaEvent([
      event({ type: 'opinion', agent: 'codex', round: 3, publicText: 'Codex wants a smaller [FEATURE].', topic: 'critique', tone: 'skeptical' }),
      event({ type: 'opinion', agent: 'claude', round: 6, publicText: 'Claude wants a stronger verification pass.', topic: 'product-opinion', tone: 'confident' })
    ])

    expect(arena).toMatchObject({
      publicTopic: 'Two positions are live',
      claudePosition: 'Claude wants a stronger verification pass.',
      codexPosition: 'Codex wants a smaller [FEATURE].'
    })
    expect(arena?.winner).toBeUndefined()
    expect(arena?.resolution).toMatch(/build evidence/i)
  })

  it('keeps the live pulse varied instead of repeating identical CLI signals', () => {
    const events: DuoEvent[] = [
      event({ id: 'a1', publicText: 'Claude is inspecting the shared workspace.' }),
      event({ id: 'a2', publicText: 'Claude is inspecting the shared workspace.' }),
      event({ id: 'a3', publicText: 'Claude is editing a workspace file.', category: 'file' }),
      event({ id: 'a4', agent: 'codex', publicText: 'Codex is testing the current build.', category: 'command' })
    ]

    expect(recentDistinctActivity(events, 6).map((item) => item.id)).toEqual(['a4', 'a3', 'a2'])
  })
})
