import { describe, expect, it } from 'vitest'
import type { ProcessRunResult } from '../../src/main/process/process-runner'
import { decodeProviderEnvelope } from '../../src/main/process/provider-envelope'
import {
  classifyProviderFailure,
  PROVIDER_FAILURE_POLICY,
  type ProviderFailureKind,
  type ProviderFailurePolicy
} from '../../src/main/providers/provider-failure'

function result(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    startedAt: '2026-07-11T10:00:00.000Z',
    finishedAt: '2026-07-11T10:00:01.000Z',
    ...overrides
  }
}

describe('provider failure classifier', () => {
  it.each([
    [
      'quota',
      'pause',
      { records: [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }] }
    ],
    [
      'auth',
      'user-action',
      { records: [{ type: 'error', error: { type: 'authentication_error' } }] }
    ],
    [
      'provider-unavailable',
      'bounded-retry',
      { text: 'The upstream service is temporarily unavailable.' }
    ],
    [
      'model-unavailable',
      'user-action',
      { records: [{ type: 'error', error: { code: 'model_not_found' } }] }
    ],
    [
      'cli-incompatible',
      'user-action',
      { text: "error: unknown option '--output-format'" }
    ],
    [
      'contract-invalid',
      'local-replay',
      { records: [{ type: 'contract.invalid', code: 'structured_output_invalid' }] }
    ],
    [
      'session-lost',
      'bounded-retry',
      { text: 'Cannot resume: session not found.' }
    ],
    [
      'stage-timeout',
      'partial',
      { result: result({ exitCode: null, timedOut: true }) }
    ],
    [
      'host-interrupted',
      'partial',
      { result: result({ exitCode: null, signal: 'SIGTERM' }) }
    ],
    [
      'workspace-drift',
      'terminal',
      { records: [{ type: 'workspace.drift', code: 'workspace_drift' }] }
    ],
    [
      'verification-failed',
      'bounded-retry',
      { records: [{ type: 'verification.failed', code: 'verification_failed' }] }
    ],
    [
      'user-cancelled',
      'terminal',
      { result: result({ exitCode: null, cancelled: true }) }
    ],
    [
      'safety-violation',
      'terminal',
      { records: [{ type: 'safety.violation', code: 'sandbox_violation' }] }
    ]
  ] as const)(
    'classifies %s with %s policy from canonical evidence',
    (kind, policy, evidence) => {
      const classified = classifyProviderFailure({
        agent: 'claude',
        result: 'result' in evidence ? evidence.result : result(),
        ...('records' in evidence ? { records: evidence.records } : {}),
        ...('text' in evidence ? { text: evidence.text } : {})
      })

      expect(classified).toMatchObject({ kind, policy, agent: 'claude' })
    }
  )

  it('treats a nonzero unrecognized CLI exit as incompatible transport rather than inventing a provider cause', () => {
    expect(classifyProviderFailure({
      agent: 'codex',
      result: result({ exitCode: 64 }),
      text: 'private output with no canonical failure marker'
    })).toEqual({
      kind: 'cli-incompatible',
      policy: 'user-action',
      source: 'process',
      agent: 'codex'
    })
  })

  it('maps an explicit unknown transport record to the CLI compatibility policy', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result(),
      records: [{ type: 'transport.error', code: 'unknown_transport' }]
    })).toMatchObject({ kind: 'cli-incompatible', policy: 'user-action', source: 'record' })
  })

  it('recognizes natural model-not-found CLI wording instead of degrading it to generic incompatibility', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result(),
      text: 'The selected model was not found.'
    })).toMatchObject({ kind: 'model-unavailable', policy: 'user-action', source: 'text' })
  })

  it('lets explicit safety evidence outrank a cancellation side effect', () => {
    expect(classifyProviderFailure({
      agent: 'codex',
      result: result({ exitCode: null, cancelled: true }),
      records: [{ type: 'safety.violation', code: 'unsafe_workspace' }]
    })).toMatchObject({ kind: 'safety-violation', policy: 'terminal', source: 'record' })
  })

  it('treats a supervisor output boundary as an explicit compatibility pause before process side effects', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
        cancelled: true,
        outputLimitExceeded: {
          stream: 'stdout',
          boundary: 'pending-line',
          limitBytes: Number.MAX_SAFE_INTEGER
        }
      })
    })).toEqual({
      kind: 'cli-incompatible',
      policy: 'user-action',
      source: 'process',
      agent: 'claude'
    })
  })

  it('treats a raw log write failure as a compatibility pause before a termination side effect', () => {
    expect(classifyProviderFailure({
      agent: 'codex',
      result: result({
        exitCode: null,
        signal: 'SIGTERM',
        rawLogWriteFailed: { stream: 'stderr', code: 'ENOSPC' }
      })
    })).toEqual({
      kind: 'cli-incompatible',
      policy: 'user-action',
      source: 'process',
      agent: 'codex'
    })
  })

  it('returns no failure for a successful process without canonical failure evidence', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({ exitCode: 0 })
    })).toBeUndefined()
  })

  it('does not classify allowed quota telemetry as a provider failure', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({ exitCode: 0 }),
      records: [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } }]
    })).toBeUndefined()
  })

  it('does not reclassify an allowed quota record when the same JSON is also present in raw text', () => {
    const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }
    expect(classifyProviderFailure({
      agent: 'codex',
      result: result({ exitCode: 0 }),
      records: [allowed],
      text: [JSON.stringify(allowed)]
    })).toBeUndefined()
  })

  it('does not mistake successful agent prose for provider failure evidence', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({ exitCode: 0 }),
      records: [{
        type: 'result',
        subtype: 'success',
        result: 'The UI should explain quota, model unavailable, and workspace safety states.'
      }]
    })).toBeUndefined()
  })

  it.each([
    'provider quota',
    'provider unavailable',
    'model unavailable',
    'authentication error'
  ])('ignores successful-process tool output echoing historical %s prose', (historicalFailureText) => {
    expect(classifyProviderFailure({
      agent: 'codex',
      result: result({ exitCode: 0 }),
      text: `.duo\\private\\dispatches.jsonl:8:{"privateText":"The earlier run mentioned ${historicalFailureText}, but this command succeeded."}`
    })).toBeUndefined()
  })

  it('still trusts a canonical rejected quota record when the process exits zero', () => {
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({ exitCode: 0 }),
      records: [{
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' }
      }],
      text: '.duo\\private\\notes.jsonl:1:{"publicText":"ordinary successful output"}'
    })).toMatchObject({ kind: 'quota', source: 'record', agent: 'claude' })
  })

  it.each([
    ['quota', "You've hit your usage limit. Try again at 7:01 AM."],
    ['auth', 'Authentication error: login required before Claude can continue.']
  ] as const)('recognizes a pretty-printed Claude error result as %s even when the process exits zero', (kind, message) => {
    const envelope = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'pretty-error-session' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: message
      }
    ], null, 2)
    expect(classifyProviderFailure({
      agent: 'claude',
      result: result({ exitCode: 0 }),
      records: decodeProviderEnvelope(envelope)
    })).toMatchObject({ kind, source: 'record', agent: 'claude' })
  })

  it('exposes an exhaustive policy pin for every canonical failure kind', () => {
    const expected: Record<ProviderFailureKind, ProviderFailurePolicy> = {
      quota: 'pause',
      auth: 'user-action',
      'provider-unavailable': 'bounded-retry',
      'model-unavailable': 'user-action',
      'cli-incompatible': 'user-action',
      'contract-invalid': 'local-replay',
      'session-lost': 'bounded-retry',
      'stage-timeout': 'partial',
      'host-interrupted': 'partial',
      'workspace-drift': 'terminal',
      'verification-failed': 'bounded-retry',
      'user-cancelled': 'terminal',
      'safety-violation': 'terminal'
    }

    expect(PROVIDER_FAILURE_POLICY).toEqual(expected)
  })
})
