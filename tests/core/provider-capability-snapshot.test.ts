import { describe, expect, it } from 'vitest'
import {
  pinProviderCapabilitySnapshot,
  validateProviderCapabilitySnapshot
} from '../../src/main/providers/provider-capability-snapshot'

function validSnapshot() {
  return {
    schemaVersion: 1 as const,
    agent: 'codex' as const,
    capturedAt: '2026-07-11T10:30:00.000Z',
    cliVersion: 'codex-cli 0.144.0',
    source: 'verified' as const,
    transportFormats: ['jsonl', 'text', 'jsonl'],
    structuredOutput: true,
    sessionResume: true,
    toolDisable: true,
    efforts: ['max', 'low', 'max'],
    models: [
      { id: 'gpt-5.6-terra', efforts: ['low', 'max'] },
      { id: 'gpt-5.6-sol', efforts: ['max', 'low', 'max'] }
    ],
    quotaResetAvailable: true
  }
}

describe('provider capability snapshot', () => {
  it('validates and pins a deterministic deeply frozen serializable snapshot', () => {
    const input = validSnapshot()
    const pinned = pinProviderCapabilitySnapshot(input)

    expect(pinned).toEqual({
      ...input,
      transportFormats: ['text', 'jsonl'],
      efforts: ['low', 'max'],
      models: [
        { id: 'gpt-5.6-sol', efforts: ['low', 'max'] },
        { id: 'gpt-5.6-terra', efforts: ['low', 'max'] }
      ]
    })
    expect(Object.isFrozen(pinned)).toBe(true)
    expect(Object.isFrozen(pinned.transportFormats)).toBe(true)
    expect(Object.isFrozen(pinned.models)).toBe(true)
    expect(Object.isFrozen(pinned.models[0])).toBe(true)
    expect(JSON.parse(JSON.stringify(pinned))).toEqual(pinned)
    expect(input.transportFormats).toEqual(['jsonl', 'text', 'jsonl'])
  })

  it('records unverified fallback capability sources without upgrading their confidence', () => {
    const snapshot = pinProviderCapabilitySnapshot({
      ...validSnapshot(),
      agent: 'claude',
      cliVersion: 'claude 2.1.201',
      source: 'unverified',
      transportFormats: ['stream-json', 'text'],
      efforts: ['low', 'max'],
      models: [{ id: 'fable', efforts: ['low', 'max'] }],
      quotaResetAvailable: false
    })

    expect(snapshot).toMatchObject({
      agent: 'claude',
      source: 'unverified',
      quotaResetAvailable: false,
      transportFormats: ['text', 'stream-json']
    })
  })

  it.each([
    ['unknown transport', { transportFormats: ['telepathy'] }],
    ['invalid timestamp', { capturedAt: 'tomorrow' }],
    ['blank CLI version', { cliVersion: '   ' }],
    ['unknown effort', { efforts: ['warp'] }],
    ['Claude-only invalid ultra effort', { agent: 'claude', efforts: ['ultra'], models: [{ id: 'fable', efforts: ['ultra'] }] }],
    ['model effort outside snapshot effort set', { efforts: ['low'], models: [{ id: 'gpt-5.6-sol', efforts: ['max'] }] }],
    ['unknown top-level data', { secret: 'must not be pinned' }]
  ])('rejects %s rather than pinning ambiguous capability data', (_label, override) => {
    expect(() => validateProviderCapabilitySnapshot({ ...validSnapshot(), ...override })).toThrow()
  })

  it('rejects non-JSON values and leaves the input untouched', () => {
    const input = { ...validSnapshot(), cliVersion: 4n }

    expect(() => pinProviderCapabilitySnapshot(input)).toThrow()
    expect(input.cliVersion).toBe(4n)
  })
})
