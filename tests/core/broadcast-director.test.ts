import { describe, expect, it } from 'vitest'
import { buildBroadcastState } from '../../src/main/orchestrator/broadcast-director'
import { buildRealTurnPlan } from '../../src/main/orchestrator/real-turn-plan'
import type { DuoEvent } from '../../src/shared/types'

const runId = 'run-broadcast-contract'
const exactClaudeQuote = 'Codex has a runnable direction, but its first impression is still too generic.'
const plan = buildRealTurnPlan(runId)

function event(overrides: Partial<DuoEvent>): DuoEvent {
  return {
    id: crypto.randomUUID(),
    type: 'agent.activity',
    runId,
    round: 2,
    timestamp: '2026-07-10T12:00:00.000Z',
    agent: 'codex',
    publicText: 'Codex is working in the shared workspace.',
    spoilerRisk: 0.05,
    severity: 'low',
    ...overrides
  }
}

function broadcastEvidence(): DuoEvent[] {
  return [
    event({
      id: 'claude-position',
      type: 'opinion',
      agent: 'claude',
      round: 1,
      timestamp: '2026-07-10T12:00:00.000Z',
      targetAgent: 'codex',
      topic: 'experience-quality',
      publicText: exactClaudeQuote
    }),
    event({
      id: 'open-conflict',
      type: 'conflict',
      agent: 'director',
      timestamp: '2026-07-10T12:00:10.000Z',
      publicText: 'The experience-quality challenge is still open.',
      publicTopic: 'Experience quality versus runnable scope',
      claudePosition: exactClaudeQuote,
      codexPosition: 'Codex has not answered with a public position yet.',
      status: 'open'
    }),
    event({
      id: 'codex-started',
      type: 'agent.started',
      timestamp: '2026-07-10T12:00:20.000Z',
      publicText: 'Codex started its pitch turn.'
    }),
    event({
      id: 'inspect-1',
      timestamp: '2026-07-10T12:00:25.000Z',
      category: 'command',
      topic: 'inspection',
      publicText: 'Codex is inspecting the shared workspace.'
    }),
    event({
      id: 'inspect-2',
      timestamp: '2026-07-10T12:00:30.000Z',
      category: 'command',
      topic: 'inspection',
      publicText: 'Codex is inspecting the shared workspace.'
    }),
    event({
      id: 'edit-1',
      timestamp: '2026-07-10T12:00:40.000Z',
      category: 'file',
      topic: 'edit',
      publicText: 'Codex changed one workspace file.'
    }),
    event({
      id: 'verify-1',
      timestamp: '2026-07-10T12:00:50.000Z',
      category: 'command',
      topic: 'verification',
      publicText: 'Codex is testing the current build.'
    }),
    event({
      id: 'failure-1',
      timestamp: '2026-07-10T12:01:00.000Z',
      category: 'error',
      topic: 'command-failure',
      severity: 'high',
      publicText: 'Codex hit a failed workspace command and is adjusting.'
    })
  ]
}

function build(tick = 0) {
  return buildBroadcastState({
    runId,
    now: '2026-07-10T12:01:50.000Z',
    tick,
    activeTurnIndex: 1,
    plan,
    events: broadcastEvidence(),
    tasks: []
  })
}

describe('broadcast director', () => {
  it('keeps agent quotes, director calls, and live evidence visibly separate and sourced', () => {
    const state = build()
    const knownIds = new Set(broadcastEvidence().map((item) => item.id))
    const quote = state.beats.find((beat) => beat.provenance === 'agent-quote')
    const director = state.beats.find((beat) => beat.provenance === 'director')
    const evidence = state.beats.find((beat) => beat.provenance === 'evidence')

    expect(quote).toMatchObject({
      speaker: 'claude',
      quote: {
        agent: 'claude',
        text: exactClaudeQuote,
        sourceEventId: 'claude-position'
      },
      sourceEventIds: ['claude-position']
    })
    expect(director).toMatchObject({ speaker: 'director', provenance: 'director' })
    expect(director?.quote).toBeUndefined()
    expect(evidence).toMatchObject({ speaker: 'director', provenance: 'evidence' })
    for (const beat of state.beats) {
      expect(beat.sourceEventIds.length).toBeGreaterThan(0)
      expect(beat.sourceEventIds.every((id) => knownIds.has(id))).toBe(true)
    }
  })

  it('reports the exact evidence counts accumulated during the active turn', () => {
    expect(build().evidence).toEqual({
      inspections: 2,
      edits: 1,
      verifications: 1,
      failures: 1
    })
  })

  it('marks the inactive agent response as due after a long single-writer turn', () => {
    const state = build()

    expect(state.responseDue).toEqual({
      agent: 'claude',
      since: '2026-07-10T12:00:20.000Z',
      waitingSeconds: 90,
      nextTurnId: plan[2]?.id
    })
  })

  it('fills an empty task board with truthful scheduled missions rather than invented claims', () => {
    const state = build()
    const queued = state.missions.filter((mission) => mission.status === 'queued')

    expect(queued.slice(0, 2)).toEqual([
      expect.objectContaining({
        turnId: plan[2]?.id,
        agent: plan[2]?.agent,
        status: 'queued'
      }),
      expect.objectContaining({
        turnId: plan[3]?.id,
        agent: plan[3]?.agent,
        status: 'queued'
      })
    ])
    expect(queued.every((mission) => mission.label.length > 0)).toBe(true)
    expect(queued.every((mission) => mission.claimed === false)).toBe(true)
  })

  it('does not invent a winner, concession, or confidence score from activity volume', () => {
    const state = build()
    const serialized = JSON.stringify(state)

    expect(state.verdict).toBeUndefined()
    expect(serialized).not.toMatch(/"winner"|\bwon\b|\bconceded\b|"confidence"/i)
  })

  it('rotates to a distinct truthful beat on the next display tick', () => {
    const first = build(0)
    const second = build(1)
    const knownIds = new Set(broadcastEvidence().map((item) => item.id))

    expect(first.beats.length).toBeGreaterThan(1)
    expect(first.activeBeat.id).not.toBe(second.activeBeat.id)
    expect(first.activeBeat.kind).not.toBe(second.activeBeat.kind)
    expect(first.activeBeat.sourceEventIds.every((id) => knownIds.has(id))).toBe(true)
    expect(second.activeBeat.sourceEventIds.every((id) => knownIds.has(id))).toBe(true)
  })
})
