import { describe, expect, it } from 'vitest'
import { assessTurnAcceptance } from '../../src/main/orchestrator/turn-acceptance'
import type { DuoEvent } from '../../src/shared/types'

function result(overrides: Partial<Parameters<typeof assessTurnAcceptance>[0]['result']> = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    startedAt: '2026-07-10T18:00:00.000Z',
    finishedAt: '2026-07-10T18:01:00.000Z',
    ...overrides
  }
}

function event(type: DuoEvent['type'], additions: Partial<DuoEvent> = {}): DuoEvent {
  return {
    id: `${type}-${crypto.randomUUID()}`,
    type,
    runId: 'run-staged-acceptance',
    round: 5,
    timestamp: '2026-07-10T18:00:30.000Z',
    agent: 'claude',
    publicText: 'I changed the shared [FEATURE] and Codex should verify the remaining edge case.',
    spoilerRisk: 0.02,
    severity: 'low',
    ...additions
  }
}

describe('staged turn acceptance outcomes', () => {
  it('timeboxes a timed-out work stage when durable source work exists', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'work',
      result: result({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
      events: [event('agent.activity', { category: 'file' })],
      requiresSourceChange: true,
      durableSourceChanged: true
    })

    expect(assessment).toMatchObject({ outcome: 'timeboxed' })
    expect(assessment.reasons).toContain('work-lease-expired')
  })

  it('timeboxes a timed-out review when completed verification evidence exists without an edit', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'work',
      result: result({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
      events: [event('agent.activity', { category: 'command', publicText: 'Claude finished a verification command.' })],
      durableSourceChanged: false,
      durableWorkEvidence: true
    })

    expect(assessment).toMatchObject({ outcome: 'timeboxed' })
    expect(assessment.reasons).toContain('work-lease-expired')
  })

  it('rejects source changes made during a coordination-only stage', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'opening',
      result: result(),
      events: [event('agent.dispatch', { dispatchKind: 'opening' })],
      durableSourceChanged: true,
      forbidsSourceChange: true
    })

    expect(assessment).toMatchObject({ outcome: 'fatal' })
    expect(assessment.reasons).toContain('forbidden-source-change')
  })

  it('rejects an evidence-free review work stage even when the process exits cleanly', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 7,
      stage: 'work',
      result: result(),
      events: [],
      requiresWorkEvidence: true,
      durableSourceChanged: false,
      durableWorkEvidence: false
    })

    expect(assessment).toMatchObject({ outcome: 'fatal' })
    expect(assessment.reasons).toContain('missing-work-evidence')
  })

  it('requests only narrow recovery when a successful verdict omits protocol records', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'verdict',
      result: result(),
      events: []
    })

    expect(assessment).toMatchObject({ outcome: 'recovery-required' })
    expect(assessment.reasons).toEqual(expect.arrayContaining(['missing-dispatch', 'missing-opinion']))
    expect(assessment.reasons).not.toContain('repeat-work')
  })

  it('allows a staged handoff to require a real dispatch without inventing a second opinion', () => {
    for (const stage of ['verdict', 'recovery'] as const) {
      const assessment = assessTurnAcceptance({
        agent: 'claude',
        round: 5,
        stage,
        result: result(),
        events: [event('agent.dispatch', { dispatchKind: stage === 'verdict' ? 'verdict' : 'closing' })],
        requiresOpinion: false
      })

      expect(assessment).toEqual({ accepted: true, outcome: 'accepted', reasons: [] })
    }
  })

  it('still requires an opinion during dialogue contract recovery', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'recovery',
      result: result(),
      events: [event('agent.dispatch', { dispatchKind: 'counter' })],
      requiresOpinion: true
    })

    expect(assessment).toMatchObject({ outcome: 'recovery-required' })
    expect(assessment.reasons).toContain('missing-opinion')
  })

  it('timeboxes a slow dialogue after its real dispatch and opinion are safely recorded', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude',
      round: 3,
      stage: 'dialogue',
      result: result({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
      events: [
        event('agent.dispatch', { round: 3, dispatchKind: 'counter' }),
        event('opinion', { round: 3, tone: 'cautious' })
      ]
    })

    expect(assessment).toMatchObject({ outcome: 'timeboxed' })
    expect(assessment.reasons).toContain('stage-timeout')
  })

  it('treats cancellation and genuine process crashes as fatal rather than salvageable', () => {
    const cancelled = assessTurnAcceptance({
      agent: 'claude',
      round: 5,
      stage: 'work',
      result: result({ exitCode: null, signal: 'SIGTERM', timedOut: true, cancelled: true }),
      events: [event('agent.activity', { category: 'file' })],
      requiresSourceChange: true,
      durableSourceChanged: true
    })
    const crashed = assessTurnAcceptance({
      agent: 'codex',
      round: 6,
      stage: 'work',
      result: result({ exitCode: 1 }),
      events: [],
      requiresSourceChange: true,
      durableSourceChanged: false
    })

    expect(cancelled).toMatchObject({ outcome: 'fatal' })
    expect(crashed).toMatchObject({ outcome: 'fatal' })
  })
})
