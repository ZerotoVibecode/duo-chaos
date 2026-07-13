import { describe, expect, it } from 'vitest'
import {
  assessTurnAcceptance,
  hasDurableWorkEvidence,
  reusableDurableWorkEvidence
} from '../../src/main/orchestrator/turn-acceptance'
import type { DuoEvent } from '../../src/shared/types'

function event(type: DuoEvent['type'], additions: Partial<DuoEvent> = {}): DuoEvent {
  return {
    id: `${type}-${crypto.randomUUID()}`,
    type,
    runId: 'run-acceptance',
    round: 1,
    timestamp: new Date().toISOString(),
    agent: 'claude',
    publicText: 'Claude says I think the smaller [FEATURE] is stronger.',
    spoilerRisk: 0.02,
    severity: 'low',
    ...additions
  }
}

describe('turn acceptance', () => {
  it('accepts a streamed verification pass even when the queued UI event has not flushed yet', () => {
    expect(hasDurableWorkEvidence({
      durableSourceChanged: false,
      preservedOpeningSource: false,
      queuedVerification: undefined,
      streamedVerification: 'passed',
      successfulWorkspaceCommand: false,
      protocolBuildFailed: false
    })).toBe(true)

    expect(hasDurableWorkEvidence({
      durableSourceChanged: false,
      preservedOpeningSource: false,
      queuedVerification: 'passed',
      streamedVerification: 'passed',
      successfulWorkspaceCommand: false,
      protocolBuildFailed: true
    })).toBe(true)

    expect(hasDurableWorkEvidence({
      durableSourceChanged: false,
      preservedOpeningSource: false,
      queuedVerification: 'failed',
      streamedVerification: 'failed',
      successfulWorkspaceCommand: false,
      protocolBuildFailed: true
    })).toBe(false)

    expect(hasDurableWorkEvidence({
      durableSourceChanged: false,
      preservedOpeningSource: false,
      queuedVerification: undefined,
      streamedVerification: undefined,
      successfulWorkspaceCommand: true,
      protocolBuildFailed: false
    })).toBe(true)
  })

  it('reuses a preserved receipt only for the same unchanged stage revision', () => {
    const receipt = {
      turnId: 'turn-06-codex-code',
      stage: 'work' as const,
      durableWorkEvidence: true,
      evidenceFingerprint: 'revision-a'
    }
    expect(reusableDurableWorkEvidence(receipt, 'turn-06-codex-code', 'work', 'revision-a')).toBe(true)
    expect(reusableDurableWorkEvidence(receipt, 'turn-06-codex-code', 'work', 'revision-b')).toBe(false)
    expect(reusableDurableWorkEvidence(receipt, 'turn-07-claude-review', 'work', 'revision-a')).toBe(false)
  })

  it('accepts only a successful turn with same-round dispatch and opinion', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude', round: 1,
      result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' },
      events: [event('agent.dispatch'), event('opinion')]
    })
    expect(assessment).toEqual({ accepted: true, outcome: 'accepted', reasons: [] })
  })

  it('rejects a no-task response even when malformed output mimics protocol success', () => {
    const assessment = assessTurnAcceptance({
      agent: 'claude', round: 1,
      result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' },
      events: [
        event('agent.dispatch'),
        event('opinion'),
        event('cli.log', { privateText: '{"type":"result","result":"What would you like me to help with?"}' })
      ]
    })
    expect(assessment.accepted).toBe(false)
    expect(assessment.reasons).toContain('no-task-response')
  })

  it('reports missing protocol artifacts and process failure separately', () => {
    const assessment = assessTurnAcceptance({
      agent: 'codex', round: 2,
      result: { exitCode: 1, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' },
      events: []
    })
    expect(assessment.reasons).toEqual(expect.arrayContaining(['process-failed', 'missing-dispatch', 'missing-opinion']))
  })

  it('rejects a code turn that talks about implementation without source-change evidence', () => {
    const result = { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' }
    const speech = [event('agent.dispatch'), event('opinion')]

    const rejected = assessTurnAcceptance({
      agent: 'claude', round: 1, result, events: speech, requiresSourceChange: true
    })
    expect(rejected.accepted).toBe(false)
    expect(rejected.reasons).toContain('missing-source-change')
    expect(assessTurnAcceptance({
      agent: 'claude', round: 1, result, requiresSourceChange: true,
      events: [...speech, event('agent.activity', { category: 'file' })]
    })).toEqual({ accepted: true, outcome: 'accepted', reasons: [] })
  })

  it('accepts successful code from a durable stage delta even without a CLI file signal', () => {
    const result = { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' }
    expect(assessTurnAcceptance({
      agent: 'claude',
      round: 1,
      stage: 'work',
      result,
      events: [],
      requiresSourceChange: true,
      durableSourceChanged: true,
      durableWorkEvidence: true
    })).toEqual({ accepted: true, outcome: 'accepted', reasons: [] })
  })

  it('accepts a no-op integration when independent work evidence proves the existing source', () => {
    const result = { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: '', finishedAt: '' }
    expect(assessTurnAcceptance({
      agent: 'codex',
      round: 6,
      stage: 'work',
      result,
      events: [],
      requiresSourceChange: false,
      requiresWorkEvidence: true,
      durableSourceChanged: false,
      durableWorkEvidence: true
    })).toEqual({ accepted: true, outcome: 'accepted', reasons: [] })
  })
})
