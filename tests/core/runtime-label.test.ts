import { describe, expect, it } from 'vitest'
import {
  formatModelLabel,
  formatRuntimeObservation,
  formatRuntimeProfile,
  formatRuntimeRequest
} from '../../src/renderer/src/lib/runtime-label'

describe('runtime labels', () => {
  it('turns versioned provider model ids into short on-camera names', () => {
    expect(formatModelLabel('claude-fable-5[1m]')).toBe('Fable')
    expect(formatModelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet')
    expect(formatModelLabel('gpt-5.6-sol')).toBe('Sol')
    expect(formatRuntimeProfile({ model: 'claude-fable-5[1m]', effort: 'max', source: 'cli-config' })).toBe('Fable · Max')
  })

  it('preserves unknown custom model ids', () => {
    expect(formatModelLabel('vendor-next-custom')).toBe('vendor-next-custom')
  })

  it('separates the requested runtime from provider observation', () => {
    expect(formatRuntimeRequest({ model: 'gpt-5.6-sol', effort: 'max', source: 'studio' })).toBe('Requested: Sol · Max')
    expect(formatRuntimeRequest({ model: 'fable', effort: 'medium', source: 'cli-config' })).toBe('Requested via CLI config: Fable · Medium')
    expect(formatRuntimeRequest({ source: 'cli-default' })).toBe('Requested via CLI default: CLI default')
    expect(formatRuntimeObservation({
      observation: {
        model: 'claude-opus-4-8',
        effort: 'high',
        source: 'claude-system-init',
        recordedAt: '2026-07-16T10:30:00.000Z'
      },
      simulation: false
    })).toBe('Provider observed: Opus · High')
    expect(formatRuntimeObservation({ simulation: false })).toBe('Provider runtime not recorded by Duo')
    expect(formatRuntimeObservation({ simulation: true })).toBe('Simulation · no provider runtime')
  })
})
