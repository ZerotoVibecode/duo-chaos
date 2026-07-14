import { describe, expect, it } from 'vitest'
import {
  createPitchProvenanceId,
  resolveConsensusProvenance,
  validateConsensusProvenance
} from '../../src/main/orchestrator/consensus-provenance'

describe('supervisor consensus provenance', () => {
  it('requires the exact run, brief fingerprint, pitch ids, agents, and rounds from immutable pitch records', () => {
    const pitch = {
      pitchId: createPitchProvenanceId({
        runId: 'run-proof', round: 1, agent: 'claude', index: 0,
        title: 'Signal Garden', idea: 'A compact local signal garden.'
      }),
      runId: 'run-proof', round: 1, agent: 'claude' as const,
      title: 'Signal Garden', idea: 'A compact local signal garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    const record = resolveConsensusProvenance({
      runId: 'run-proof', appName: 'Signal Garden', qualityBriefFingerprint: 'quality:abc', pitches: [pitch]
    })
    expect(record).toBeDefined()
    expect(validateConsensusProvenance({
      record: record!, runId: 'run-proof', qualityBriefFingerprint: 'quality:abc', immutablePitches: [pitch]
    })).toBe(true)
    expect(validateConsensusProvenance({
      record: { ...record!, sourcePitchIds: ['pitch-forged'] },
      runId: 'run-proof', qualityBriefFingerprint: 'quality:abc', immutablePitches: [pitch]
    })).toBe(false)
    expect(validateConsensusProvenance({
      record: record!, runId: 'other-run', qualityBriefFingerprint: 'quality:abc', immutablePitches: [pitch]
    })).toBe(false)
  })
})
