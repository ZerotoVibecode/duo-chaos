import { describe, expect, it } from 'vitest'
import {
  extractProviderRuntimeObservation,
  parseProviderRuntimeObservation
} from '../../src/main/process/runtime-provenance'

describe('provider runtime provenance', () => {
  const recordedAt = '2026-07-16T10:30:00.000Z'

  it('extracts only validated Claude system init runtime fields', () => {
    expect(extractProviderRuntimeObservation('claude', JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-fable-5-20260701',
      effort: 'high',
      session_id: '11111111-1111-4111-8111-111111111111'
    }), recordedAt)).toEqual({
      model: 'claude-fable-5-20260701',
      effort: 'high',
      source: 'claude-system-init',
      recordedAt
    })

    expect(extractProviderRuntimeObservation('claude', JSON.stringify({
      type: 'assistant',
      model: 'untrusted-assistant-model',
      effort: 'max'
    }), recordedAt)).toBeUndefined()
  })

  it('extracts only validated Codex thread started runtime fields', () => {
    expect(extractProviderRuntimeObservation('codex', JSON.stringify({
      type: 'thread.started',
      thread_id: '22222222-2222-4222-8222-222222222222',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'extra-high'
    }), recordedAt)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      source: 'codex-thread-started',
      recordedAt
    })

    expect(extractProviderRuntimeObservation('codex', JSON.stringify({
      type: 'turn.started',
      model: 'gpt-5.6-sol'
    }), recordedAt)).toBeUndefined()
  })

  it('never promotes nested, malformed, or unsupported values to runtime evidence', () => {
    expect(extractProviderRuntimeObservation('claude', JSON.stringify({
      type: 'system',
      subtype: 'init',
      message: { model: 'nested-model', effort: 'max' }
    }), recordedAt)).toBeUndefined()
    expect(extractProviderRuntimeObservation('codex', JSON.stringify({
      type: 'thread.started',
      model: '../../not-a-model',
      effort: 'impossible'
    }), recordedAt)).toBeUndefined()
    expect(extractProviderRuntimeObservation('codex', 'not-json', recordedAt)).toBeUndefined()
  })

  it('validates durable observations without trusting arbitrary manifest data', () => {
    expect(parseProviderRuntimeObservation({
      model: 'claude-opus-4-8',
      effort: 'medium',
      source: 'claude-system-init',
      recordedAt
    }, 'claude')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'medium',
      source: 'claude-system-init',
      recordedAt
    })
    expect(parseProviderRuntimeObservation({
      model: 'gpt-5.6-sol',
      source: 'claude-system-init',
      recordedAt
    }, 'codex')).toBeUndefined()
  })
})
