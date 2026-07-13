import { describe, expect, it } from 'vitest'
import { formatModelLabel, formatRuntimeProfile } from '../../src/renderer/src/lib/runtime-label'

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
})
