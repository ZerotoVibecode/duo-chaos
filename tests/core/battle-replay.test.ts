import { describe, expect, it } from 'vitest'
import { buildBattleReplay } from '../../src/shared/battle-replay'
import type { DuoEvent, DuoTask, RunSnapshot } from '../../src/shared/types'

function event(
  id: string,
  type: DuoEvent['type'],
  round: number,
  agent: DuoEvent['agent'],
  publicText: string,
  extras: Partial<DuoEvent> = {}
): DuoEvent {
  return {
    id,
    type,
    runId: 'run-replay',
    round,
    timestamp: `2026-07-10T12:${String(round).padStart(2, '0')}:00.000Z`,
    agent,
    publicText,
    spoilerRisk: 0.05,
    severity: 'medium',
    ...extras
  }
}

function run(events: DuoEvent[], tasks: DuoTask[] = [], status: RunSnapshot['status'] = 'complete'): RunSnapshot {
  return {
    runId: 'run-replay',
    prompt: 'Build something hidden.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: status === 'complete' ? 'complete' : 'reveal.ready',
    status,
    round: 12,
    startedAt: '2026-07-10T12:00:00.000Z',
    workspacePath: 'C:\\DuoChaos\\workspaces\\run-replay',
    appPath: 'C:\\DuoChaos\\workspaces\\run-replay\\app',
    events,
    tasks
  }
}

describe('battle replay derivation', () => {
  it('replays only recorded public evidence in chronological order and keeps source ids', () => {
    const task: DuoTask = {
      id: 'task-1',
      publicTitle: 'Polish the sealed interaction',
      privateTitle: 'Private app noun must not appear',
      status: 'done',
      claimedBy: 'both',
      risk: 'medium',
      files: []
    }
    const events = [
      event('reveal', 'reveal.ready', 8, 'director', 'The sealed result is ready to reveal.'),
      event('repair', 'repair.completed', 6, 'claude', 'Claude repaired the recorded failure.'),
      event('counter', 'agent.dispatch', 2, 'codex', 'Codex counters with a smaller runnable path.', {
        dispatchKind: 'counter',
        replyTo: 'challenge'
      }),
      event('failure', 'build.failed', 5, 'codex', 'The first verification command failed.'),
      event('challenge', 'agent.dispatch', 1, 'claude', 'Claude challenges the overloaded direction.', {
        dispatchKind: 'challenge',
        privateText: 'Private app name and hidden feature.'
      }),
      event('decision', 'decision', 3, 'director', 'The smaller interaction was recorded as the shared direction.', {
        winner: 'split',
        resolution: 'Both positions contributed.'
      }),
      event('task-done', 'task.updated', 4, 'claude', 'The shared implementation task was completed.', {
        relatedTaskIds: ['task-1'],
        task
      }),
      event('verified', 'build.passed', 7, 'codex', 'The final verification command passed.')
    ]

    const replay = buildBattleReplay(run(events, [task]))

    expect(replay).toHaveLength(8)
    expect(replay.map((scene) => scene.kind)).toEqual([
      'challenge',
      'counter',
      'decision',
      'task',
      'failure',
      'repair',
      'verification',
      'reveal'
    ])
    expect(replay.flatMap((scene) => scene.sourceEventIds).every((id) => events.some((item) => item.id === id))).toBe(true)
    expect(JSON.stringify(replay)).not.toContain('Private app')
    const taskScene = replay.find((scene) => scene.kind === 'task')
    expect(taskScene?.body).toContain(task.publicTitle)
    expect((taskScene as unknown as { sourceTaskIds?: string[] })?.sourceTaskIds).toEqual(['task-1'])
  })

  it('does not invent missing conflict, repairs, winners, or victory language', () => {
    const events = [
      event('verified', 'build.passed', 2, 'codex', 'One recorded check passed.'),
      event('partial-reveal', 'reveal.ready', 3, 'director', 'A partial workspace is available for inspection.')
    ]

    const replay = buildBattleReplay(run(events, [], 'reveal-ready'))
    const serialized = JSON.stringify(replay)

    expect(replay.map((scene) => scene.kind)).toEqual(['verification', 'reveal'])
    expect(serialized).not.toMatch(/winner|won|victory|repaired/i)
  })

  it('uses neutral labels for an alternating public exchange without explicit clash metadata', () => {
    const events = [
      event('claude-opinion', 'opinion', 1, 'claude', 'Claude argues for one cinematic interaction.', { targetAgent: 'codex' }),
      event('codex-opinion', 'opinion', 1, 'codex', 'Codex agrees on focus but insists the core must run first.', { targetAgent: 'claude' }),
      event('director-conflict', 'conflict', 2, 'director', 'The director recorded the disagreement.')
    ]

    const replay = buildBattleReplay(run(events))

    expect(replay.slice(0, 2).map((scene) => scene.kind)).toEqual(['position', 'response'])
    expect(replay[0]?.body).toBe(events[0]?.publicText)
    expect(replay[1]?.body).toBe(events[1]?.publicText)
    expect(JSON.stringify(replay.slice(0, 2))).not.toMatch(/challenge|counter/i)
  })

  it('uses the final recorded failure and its following repair evidence', () => {
    const events = [
      event('failure-one', 'build.failed', 2, 'director', 'The first check failed.'),
      event('repair-one', 'repair.completed', 3, 'claude', 'Claude fixed the first check.'),
      event('pass-one', 'build.passed', 4, 'director', 'The first repair passed.'),
      event('failure-two', 'build.failed', 5, 'director', 'The release check found one final fault.'),
      event('repair-two', 'repair.completed', 6, 'codex', 'Codex fixed the final fault.'),
      event('pass-two', 'build.passed', 7, 'director', 'The release check passed.'),
      event('reveal', 'reveal.ready', 8, 'director', 'Reveal ready.')
    ]

    const replay = buildBattleReplay(run(events))

    expect(replay.find((scene) => scene.kind === 'failure')?.sourceEventIds).toEqual(['failure-two'])
    expect(replay.find((scene) => scene.kind === 'repair')?.sourceEventIds).toEqual(['repair-two'])
    expect(replay.find((scene) => scene.kind === 'verification')?.sourceEventIds).toEqual(['pass-two'])
  })

  it('shows the latest recorded decision when the agents changed course', () => {
    const events = [
      event('decision-one', 'decision', 2, 'director', 'The first direction was recorded.'),
      event('decision-two', 'decision', 3, 'director', 'The agents later narrowed the direction.'),
      event('reveal', 'reveal.ready', 4, 'director', 'Reveal ready.')
    ]

    const replay = buildBattleReplay(run(events))

    expect(replay.find((scene) => scene.kind === 'decision')?.sourceEventIds).toEqual(['decision-two'])
  })

  it('treats a typed verification failure after a pass as the current release evidence', () => {
    const events = [
      event('typed-pass', 'agent.activity', 2, 'claude', 'Claude finished a verification command.', {
        category: 'command',
        metadata: { verificationPassed: true }
      }),
      event('typed-failure', 'agent.activity', 3, 'codex', 'Codex found a later verification failure.', {
        category: 'error',
        metadata: { verificationFailed: true }
      }),
      event('partial-reveal', 'reveal.ready', 4, 'director', 'The partial workspace is preserved.')
    ]

    const replay = buildBattleReplay(run(events, [], 'reveal-ready'))

    expect(replay.find((scene) => scene.kind === 'failure')?.sourceEventIds).toEqual(['typed-failure'])
    expect(replay.some((scene) => scene.kind === 'verification')).toBe(false)
  })

  it('is deterministic and caps the replay at eight scenes', () => {
    const challenge = event('challenge', 'agent.dispatch', 1, 'claude', 'Claude files a challenge.', { dispatchKind: 'challenge' })
    const counter = event('counter', 'agent.dispatch', 2, 'codex', 'Codex files a direct counter.', { dispatchKind: 'counter', replyTo: 'challenge' })
    const events = [
      challenge,
      counter,
      event('decision', 'decision', 3, 'director', 'A direction was recorded.'),
      event('task', 'task.updated', 4, 'codex', 'A task was completed.', { task: { id: 't', publicTitle: 'Build the shared shell', status: 'done', risk: 'low', files: [] } }),
      event('failure', 'build.failed', 5, 'codex', 'A check failed.'),
      event('repair-start', 'repair.started', 6, 'claude', 'A repair began.'),
      event('repair-done', 'repair.completed', 7, 'claude', 'The repair completed.'),
      event('verified', 'build.passed', 8, 'codex', 'Verification passed.'),
      event('reveal', 'reveal.ready', 9, 'director', 'Reveal ready.'),
      event('complete', 'run.completed', 10, 'director', 'Run complete.')
    ]

    const first = buildBattleReplay(run(events))
    const second = buildBattleReplay(run([...events]))

    expect(first).toEqual(second)
    expect(first.length).toBeLessThanOrEqual(8)
  })
})
