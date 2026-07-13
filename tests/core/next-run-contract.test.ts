import { describe, expect, it } from 'vitest'
import { buildAgentCommand, type AgentCommand } from '../../src/main/process/command-builder'
import { normalizeEvent } from '../../src/main/events/normalizer'
import { buildBroadcastState } from '../../src/main/orchestrator/broadcast-director'
import { buildRealTurnPlan } from '../../src/main/orchestrator/real-turn-plan'
import type { DuoEvent } from '../../src/shared/types'

describe('next-run safety and presentation contracts', () => {
  it('delivers the Claude task through stdin instead of a fragile positional argument', () => {
    const prompt = 'Take the opening pitch turn and publish one direct position.'
    const command = buildAgentCommand({
      agent: 'claude',
      executionMode: 'chaos',
      binary: 'claude',
      workspacePath: 'C:\\DuoChaos\\workspaces\\stdin-contract',
      prompt,
      dangerousModeConfirmed: false,
      model: 'sonnet',
      effort: 'low',
      extraArgs: []
    }) as AgentCommand & { stdin?: string }

    expect.soft(command.stdin).toBe(prompt)
    expect.soft(command.args).not.toContain(prompt)
  })

  it('repairs common UTF-8 mojibake before agent dialogue reaches the renderer', () => {
    const event = normalizeEvent(
      {
        id: 'claude-readable-opening',
        type: 'agent.dispatch',
        agent: 'claude',
        dispatchKind: 'opening',
        publicText: 'I\u00e2\u20ac\u2122ve reduced the direction and I\u00e2\u20ac\u2122m ready to defend it.'
      },
      { runId: 'run-readable-dialogue', round: 1 }
    )

    expect(event.publicText).toBe('I\u2019ve reduced the direction and I\u2019m ready to defend it.')
    expect(event.publicText).not.toMatch(/[\u00c2\u00c3\u00e2\ufffd]/u)
  })

  it('pins a reveal-ready completion beat above stale evidence for every broadcast tick', () => {
    const runId = 'run-terminal-broadcast'
    const plan = buildRealTurnPlan(runId)
    const events: DuoEvent[] = [
      {
        id: 'codex-last-command',
        type: 'agent.activity',
        runId,
        round: 8,
        timestamp: '2026-07-10T10:00:00.000Z',
        agent: 'codex',
        publicText: 'Codex finished a verification command.',
        category: 'command',
        severity: 'low',
        spoilerRisk: 0.05
      },
      {
        id: 'terminal-ready',
        type: 'reveal.ready',
        runId,
        round: 8,
        timestamp: '2026-07-10T10:00:01.000Z',
        agent: 'director',
        publicText: 'The build is fully complete and ready for reveal.',
        severity: 'high',
        spoilerRisk: 0.05
      },
      {
        id: 'late-buffered-evidence',
        type: 'agent.activity',
        runId,
        round: 8,
        timestamp: '2026-07-10T10:00:02.000Z',
        agent: 'codex',
        publicText: 'A buffered workspace signal arrived after completion.',
        category: 'file',
        severity: 'low',
        spoilerRisk: 0.05
      }
    ]

    for (const tick of [0, 1, 7, 99]) {
      const state = buildBroadcastState({
        runId,
        now: '2026-07-10T10:01:00.000Z',
        tick,
        activeTurnIndex: 7,
        plan,
        events,
        tasks: []
      })

      expect.soft(state.activeBeat.kind).toBe('resolution')
      expect.soft(state.activeBeat.provenance).toBe('director')
      expect.soft(`${state.activeBeat.headline} ${state.activeBeat.detail}`).toMatch(/fully complete|ready for reveal/i)
      expect.soft(state.activeBeat.sourceEventIds).toContain('terminal-ready')
    }
  })

  it('does not call a partial release fully complete', () => {
    const runId = 'run-partial-release'
    const state = buildBroadcastState({
      runId,
      now: '2026-07-10T10:01:00.000Z',
      tick: 4,
      activeTurnIndex: 7,
      plan: buildRealTurnPlan(runId),
      events: [{
        id: 'partial-release',
        type: 'reveal.ready',
        runId,
        round: 8,
        timestamp: '2026-07-10T10:00:00.000Z',
        agent: 'director',
        publicText: 'The run reached reveal with one documented caveat.',
        status: 'partial',
        severity: 'medium',
        spoilerRisk: 0.05
      }],
      tasks: []
    })

    expect(state.activeBeat.kind).toBe('resolution')
    expect(`${state.activeBeat.headline} ${state.activeBeat.detail}`).toMatch(/caveat|partial/i)
    expect(`${state.activeBeat.headline} ${state.activeBeat.detail}`).not.toMatch(/fully complete/i)
  })
})
