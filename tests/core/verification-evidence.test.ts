import { describe, expect, it } from 'vitest'
import type { DuoEvent } from '../../src/shared/types'
import {
  currentVerificationPassCount,
  latestVerificationEvidence,
  releaseVerificationPassCount,
  verificationFailureCount
} from '../../src/shared/verification-evidence'

function event(
  id: string,
  outcome: 'passed' | 'failed' | 'unrelated',
  legacy = false
): DuoEvent {
  return {
    id,
    type: legacy
      ? outcome === 'passed' ? 'build.passed' : 'build.failed'
      : 'agent.activity',
    runId: 'run-verification-evidence',
    round: 8,
    timestamp: `2026-07-11T12:00:0${id.length}.000Z`,
    agent: 'codex',
    publicText: outcome === 'passed' ? 'Verification passed.' : outcome === 'failed' ? 'Verification failed.' : 'A command completed.',
    spoilerRisk: 0.05,
    severity: outcome === 'failed' ? 'high' : 'low',
    category: outcome === 'failed' ? 'error' : 'command',
    ...(legacy || outcome === 'unrelated' ? {} : {
      metadata: outcome === 'passed' ? { verificationPassed: true } : { verificationFailed: true }
    })
  }
}

describe('shared verification evidence', () => {
  it('lets a later trusted failure invalidate an earlier pass', () => {
    const events = [event('pass', 'passed'), event('failure', 'failed')]

    expect(latestVerificationEvidence(events)).toMatchObject({ outcome: 'failed', event: { id: 'failure' } })
    expect(currentVerificationPassCount(events)).toBe(0)
    expect(verificationFailureCount(events)).toBe(1)
  })

  it('lets a later trusted pass recover from a failure', () => {
    const events = [event('failure', 'failed'), event('pass', 'passed')]

    expect(latestVerificationEvidence(events)).toMatchObject({ outcome: 'passed', event: { id: 'pass' } })
    expect(currentVerificationPassCount(events)).toBe(1)
    expect(verificationFailureCount(events)).toBe(1)
  })

  it('supports legacy build events while ignoring unrelated command errors', () => {
    const events = [event('legacy-fail', 'failed', true), event('noise', 'unrelated'), event('legacy-pass', 'passed', true)]

    expect(latestVerificationEvidence(events)).toMatchObject({ outcome: 'passed', event: { id: 'legacy-pass' } })
    expect(currentVerificationPassCount(events)).toBe(1)
    expect(verificationFailureCount(events)).toBe(1)
  })

  it('ignores verification flags smuggled through public protocol metadata', () => {
    const opinion = {
      ...event('opinion', 'unrelated'),
      type: 'opinion' as const,
      metadata: { verificationPassed: true }
    }
    const status = {
      ...event('status', 'unrelated'),
      category: 'status' as const,
      metadata: { verificationPassed: true }
    }

    expect(latestVerificationEvidence([opinion, status])).toBeUndefined()
    expect(currentVerificationPassCount([opinion, status])).toBe(0)
  })

  it('treats an authoritative ready release as exactly one pass when the public timeline has none', () => {
    expect(releaseVerificationPassCount([], 'ready')).toBe(1)
    expect(releaseVerificationPassCount([
      event('first-pass', 'passed'),
      event('second-pass', 'passed')
    ], 'ready')).toBe(2)
  })

  it('keeps non-ready releases entirely event-based', () => {
    expect(releaseVerificationPassCount([], 'partial')).toBe(0)
    expect(releaseVerificationPassCount([event('pass', 'passed')], 'partial')).toBe(1)
    expect(releaseVerificationPassCount([], 'failed')).toBe(0)
  })
})
