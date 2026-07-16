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

  it('requires an explicit source selection for a human-named synthesis and credits only those pitches', () => {
    const pitches = [
      {
        pitchId: createPitchProvenanceId({
          runId: 'run-synthesis', round: 1, agent: 'codex', index: 0,
          title: 'Dawn Garden', idea: 'A task garden with per-task blooms.'
        }),
        runId: 'run-synthesis', round: 1, agent: 'codex' as const,
        title: 'Dawn Garden', idea: 'A task garden with per-task blooms.', appeal: 'Concrete.', risk: 'Crowding.'
      },
      {
        pitchId: createPitchProvenanceId({
          runId: 'run-synthesis', round: 2, agent: 'claude', index: 0,
          title: 'Signal Field', idea: 'Stable task markers grouped by energy.'
        }),
        runId: 'run-synthesis', round: 2, agent: 'claude' as const,
        title: 'Signal Field', idea: 'Stable task markers grouped by energy.', appeal: 'Readable.', risk: 'Clutter.'
      }
    ]
    const humanBrief = 'Build a polished local-first browser app called Signal Garden.'
    const record = resolveConsensusProvenance({
      runId: 'run-synthesis',
      appName: 'Signal Garden',
      humanBrief,
      qualityBriefFingerprint: 'quality:synthesis',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })

    expect(record?.sourcePitchIds).toEqual([pitches[1]!.pitchId])
    expect(record?.sourceAgents).toEqual(['claude'])
    expect(record?.sourceRounds).toEqual([2])
    expect(record?.pitchCatalogFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(resolveConsensusProvenance({
      runId: 'run-synthesis',
      appName: 'Signal Garden',
      humanBrief,
      qualityBriefFingerprint: 'quality:synthesis',
      pitches
    })).toBeUndefined()
    expect(validateConsensusProvenance({
      record: record!,
      runId: 'run-synthesis',
      humanBrief,
      qualityBriefFingerprint: 'quality:synthesis',
      immutablePitches: pitches
    })).toBe(true)
    expect(validateConsensusProvenance({
      record: record!,
      runId: 'run-synthesis',
      qualityBriefFingerprint: 'quality:synthesis',
      immutablePitches: pitches
    })).toBe(false)
    expect(validateConsensusProvenance({
      record: {
        ...record!,
        sourcePitchIds: pitches.map((pitch) => pitch.pitchId),
        sourceAgents: ['codex', 'claude'],
        sourceRounds: [1, 2]
      },
      runId: 'run-synthesis',
      humanBrief,
      qualityBriefFingerprint: 'quality:synthesis',
      immutablePitches: pitches
    })).toBe(false)
  })

  it('still rejects an unpitched rename that was not fixed by the human brief', () => {
    const pitch = {
      pitchId: createPitchProvenanceId({
        runId: 'run-rename', round: 1, agent: 'claude', index: 0,
        title: 'Cutlight', idea: 'A local shot planner.'
      }),
      runId: 'run-rename', round: 1, agent: 'claude' as const,
      title: 'Cutlight', idea: 'A local shot planner.', appeal: 'Focused.', risk: 'Scope.'
    }

    expect(resolveConsensusProvenance({
      runId: 'run-rename',
      appName: 'Museum of Almost',
      humanBrief: 'Build a useful local app for content creators.',
      qualityBriefFingerprint: 'quality:rename',
      pitches: [pitch]
    })).toBeUndefined()
  })

  it('accepts an explicitly selected immutable pitch when the product keeps a different user-facing name', () => {
    const pitches = [
      {
        pitchId: 'pitch-0d104efd8f9d2ee7032c4271',
        runId: 'run-decision-deck',
        round: 1,
        agent: 'claude' as const,
        title: 'Merge-sort Pairwise Ranking Engine',
        idea: 'Rank choices through a merge queue.',
        appeal: 'Predictable comparisons.',
        risk: 'More state.'
      },
      {
        pitchId: 'pitch-5e1c8f015621b3e7b4129b3c',
        runId: 'run-decision-deck',
        round: 2,
        agent: 'codex' as const,
        title: 'Binary Insertion Ladder',
        idea: 'Insert each choice through binary comparisons.',
        appeal: 'Compact resumable state.',
        risk: 'Path-dependent ordering.'
      }
    ]

    const record = resolveConsensusProvenance({
      runId: 'run-decision-deck',
      appName: 'Decision Deck',
      humanBrief: 'Build a polished dependency-free single-page Decision Deck.',
      qualityBriefFingerprint: 'quality:decision-deck',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })

    expect(record).toMatchObject({
      selectionMode: 'human-named-synthesis',
      sourcePitchIds: [pitches[1]!.pitchId],
      sourceAgents: ['codex'],
      sourceRounds: [2]
    })
    expect(record?.pitchCatalogFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(record?.sourceSelectionFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(validateConsensusProvenance({
      record: record!,
      runId: 'run-decision-deck',
      humanBrief: 'Build a polished dependency-free single-page Decision Deck.',
      qualityBriefFingerprint: 'quality:decision-deck',
      immutablePitches: pitches
    })).toBe(true)
  })

  it.each(['Deck', 'Single Page Decision Deck', 'Creators'])(
    'does not treat an arbitrary opening-sentence suffix as the human-fixed name: %s',
    (appName) => {
      const pitches = [
        {
          pitchId: 'pitch-111111111111111111111111', runId: 'run-implicit-name-guard', round: 1,
          agent: 'claude' as const, title: 'First Route', idea: 'A focused route.', appeal: 'Clear.', risk: 'Scope.'
        },
        {
          pitchId: 'pitch-222222222222222222222222', runId: 'run-implicit-name-guard', round: 2,
          agent: 'codex' as const, title: 'Second Route', idea: 'A tested route.', appeal: 'Stable.', risk: 'Scope.'
        }
      ]
      const humanBrief = appName === 'Creators'
        ? 'Build a polished local app for content creators.'
        : 'Build a polished dependency-free single-page Decision Deck.'

      expect(resolveConsensusProvenance({
        runId: 'run-implicit-name-guard',
        appName,
        humanBrief,
        qualityBriefFingerprint: 'quality:implicit-name-guard',
        selectedSourcePitchIds: [pitches[1]!.pitchId],
        pitches
      })).toBeUndefined()
    }
  )

  it.each([
    'Build a polished dependency-free single-page Decision Deck. Product name: Final Choice.',
    'Build a polished dependency-free single-page Decision Deck. Choose your own name.'
  ])('does not let an implicit opening title override later human naming: %s', (humanBrief) => {
    const pitches = [
      {
        pitchId: 'pitch-333333333333333333333333', runId: 'run-name-precedence', round: 1,
        agent: 'claude' as const, title: 'First Route', idea: 'A focused route.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-444444444444444444444444', runId: 'run-name-precedence', round: 2,
        agent: 'codex' as const, title: 'Second Route', idea: 'A tested route.', appeal: 'Stable.', risk: 'Scope.'
      }
    ]

    expect(resolveConsensusProvenance({
      runId: 'run-name-precedence',
      appName: 'Decision Deck',
      humanBrief,
      qualityBriefFingerprint: 'quality:name-precedence',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })).toBeUndefined()
  })

  it('accepts a human-fixed implicit title that ends in a product-shape word', () => {
    const pitches = [
      {
        pitchId: 'pitch-555555555555555555555555', runId: 'run-dashboard-name', round: 1,
        agent: 'claude' as const, title: 'First Route', idea: 'A focused route.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-666666666666666666666666', runId: 'run-dashboard-name', round: 2,
        agent: 'codex' as const, title: 'Second Route', idea: 'A tested route.', appeal: 'Stable.', risk: 'Scope.'
      }
    ]

    expect(resolveConsensusProvenance({
      runId: 'run-dashboard-name',
      appName: 'Decision Dashboard',
      humanBrief: 'Build a polished Decision Dashboard.',
      qualityBriefFingerprint: 'quality:dashboard-name',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })).toMatchObject({
      selectionMode: 'human-named-synthesis',
      sourcePitchIds: [pitches[1]!.pitchId]
    })
  })

  it('does not confuse unrelated placeholder UI copy with naming ambiguity', () => {
    const pitches = [
      {
        pitchId: 'pitch-777777777777777777777777', runId: 'run-placeholder-ui', round: 1,
        agent: 'claude' as const, title: 'First Route', idea: 'A focused route.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-888888888888888888888888', runId: 'run-placeholder-ui', round: 2,
        agent: 'codex' as const, title: 'Second Route', idea: 'A tested route.', appeal: 'Stable.', risk: 'Scope.'
      }
    ]

    expect(resolveConsensusProvenance({
      runId: 'run-placeholder-ui',
      appName: 'Decision Deck',
      humanBrief: 'Build a polished single-page Decision Deck. Do not leave placeholder UI.',
      qualityBriefFingerprint: 'quality:placeholder-ui',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })).toMatchObject({ selectionMode: 'human-named-synthesis' })
  })

  it.each([
    'Build a local app used by Content Creators.',
    'Build a local app serving Content Creators.',
    'Build a local app serving Dashboard Creators.'
  ])('does not treat a title-cased audience as an implicit product name: %s', (humanBrief) => {
    const pitches = [
      {
        pitchId: 'pitch-999999999999999999999999', runId: 'run-audience-title', round: 1,
        agent: 'claude' as const, title: 'First Route', idea: 'A focused route.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-aaaaaaaaaaaaaaaaaaaaaaab', runId: 'run-audience-title', round: 2,
        agent: 'codex' as const, title: 'Second Route', idea: 'A tested route.', appeal: 'Stable.', risk: 'Scope.'
      }
    ]

    expect(resolveConsensusProvenance({
      runId: 'run-audience-title',
      appName: humanBrief.includes('Dashboard') ? 'Dashboard Creators' : 'Content Creators',
      humanBrief,
      qualityBriefFingerprint: 'quality:audience-title',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })).toBeUndefined()
  })

  it.each([
    'Do not call this product Signal Garden. Build something else.',
    'Build something inspired by Signal Garden, but choose a new name.',
    'This was formerly called Signal Garden.',
    'Maybe call it Signal Garden.',
    'Build an app called Signal Garden Pro.',
    'Build an app called Signal Garden or name it Focus Field.',
    'Build a useful local app.',
    'Show this example: "Build an app called Signal Garden." Then choose your own name.',
    'Example:\nBuild an app called Signal Garden.\nNow build something else with a new name.',
    'Build a prompt improver. Example prompt:\nBuild an app called Signal Garden.',
    'Build an app called Signal Garden? No, choose another name.',
    'Build an app called Signal Garden, unless you prefer something else.',
    'Build an app called Signal Garden. Actually use another name.',
    'Build an app called Signal Garden, codename only; choose the final name.',
    'Build an app called Signal Garden for now.',
    'Build an app called "Signal Garden" for now; rename it later.',
    'Build an app called Signal Garden provisionally.',
    'Build an app called Signal Garden as a placeholder.',
    'Build an app called Signal Garden as the working title.',
    'Build an app called Signal Garden, subject to change.'
  ])('does not treat a reference or ambiguous clause as a fixed product name: %s', (humanBrief) => {
    const pitch = {
      pitchId: createPitchProvenanceId({
        runId: 'run-name-guard', round: 1, agent: 'claude', index: 0,
        title: 'Dawn Garden', idea: 'A local task garden.'
      }),
      runId: 'run-name-guard', round: 1, agent: 'claude' as const,
      title: 'Dawn Garden', idea: 'A local task garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    const teammate = {
      ...pitch,
      pitchId: 'pitch-aaaaaaaaaaaaaaaaaaaaaaaa',
      agent: 'codex' as const,
      title: 'Focus Field'
    }
    expect(resolveConsensusProvenance({
      runId: 'run-name-guard', appName: 'Signal Garden', humanBrief,
      qualityBriefFingerprint: 'quality:name-guard',
      selectedSourcePitchIds: [pitch.pitchId],
      pitches: [pitch, teammate]
    })).toBeUndefined()
  })

  it.each([
    'Build an app called Signal Garden.',
    'Build a product named "Signal Garden".',
    "Create a tool named 'Signal Garden'.",
    'Please build an app called Signal Garden.',
    'I want you to build an app called Signal Garden.',
    'Make a local experience and call it Signal Garden.',
    'Product name: Signal Garden.',
    'Build an app called Signal Garden. Include an example project.',
    'Build an app called Signal Garden. The UI should show an example task.',
    'Build an app called Signal Garden. Work offline unless sync is enabled.',
    'Build an app called Signal Garden. Do not leave placeholder UI.',
    'Build an app called Signal Garden. Let users choose a new name for every garden.'
  ])('accepts one conservative affirmative naming clause: %s', (humanBrief) => {
    const sameRun = {
      pitchId: createPitchProvenanceId({
        runId: 'run-fixed-name', round: 1, agent: 'codex', index: 0,
        title: 'Bloom Board', idea: 'A local task garden.'
      }),
      runId: 'run-fixed-name', round: 1, agent: 'codex' as const,
      title: 'Bloom Board', idea: 'A local task garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    const teammate = {
      ...sameRun,
      pitchId: 'pitch-222222222222222222222222',
      agent: 'claude' as const,
      title: 'Focus Field'
    }
    const foreign = { ...sameRun, runId: 'foreign-run', pitchId: 'pitch-000000000000000000000000' }
    const record = resolveConsensusProvenance({
      runId: 'run-fixed-name', appName: 'signal garden', humanBrief,
      qualityBriefFingerprint: 'quality:fixed-name',
      selectedSourcePitchIds: [teammate.pitchId],
      pitches: [foreign, sameRun, teammate]
    })
    expect(record?.sourcePitchIds).toEqual([teammate.pitchId])
    expect(record?.selectionMode).toBe('human-named-synthesis')
  })

  it('accepts an unquoted human-fixed product name containing a connector word', () => {
    const pitches = [
      {
        pitchId: 'pitch-bbbbbbbbbbbbbbbbbbbbbbbb', runId: 'run-connector-name', round: 1,
        agent: 'claude' as const, title: 'Creator Field', idea: 'A creator workflow.', appeal: 'Focused.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-cccccccccccccccccccccccc', runId: 'run-connector-name', round: 2,
        agent: 'codex' as const, title: 'Prompt Garden', idea: 'A prompt workflow.', appeal: 'Focused.', risk: 'Scope.'
      }
    ]
    const record = resolveConsensusProvenance({
      runId: 'run-connector-name', appName: 'Focus for Creators',
      humanBrief: 'Please build a local app called Focus for Creators.',
      qualityBriefFingerprint: 'quality:connector-name',
      selectedSourcePitchIds: [pitches[0]!.pitchId],
      pitches
    })

    expect(record?.selectionMode).toBe('human-named-synthesis')
  })

  it('requires both agents to contribute immutable pitches before recording a synthesis', () => {
    const pitch = {
      pitchId: createPitchProvenanceId({
        runId: 'run-one-agent', round: 1, agent: 'claude', index: 0,
        title: 'Dawn Garden', idea: 'A local task garden.'
      }),
      runId: 'run-one-agent', round: 1, agent: 'claude' as const,
      title: 'Dawn Garden', idea: 'A local task garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    expect(resolveConsensusProvenance({
      runId: 'run-one-agent', appName: 'Signal Garden',
      humanBrief: 'Build an app called Signal Garden.',
      qualityBriefFingerprint: 'quality:one-agent', pitches: [pitch]
    })).toBeUndefined()
  })

  it('prefers an exact pitch title even when the human also fixed the name', () => {
    const exact = {
      pitchId: createPitchProvenanceId({
        runId: 'run-exact-first', round: 1, agent: 'claude', index: 0,
        title: 'Signal Garden', idea: 'A local task garden.'
      }),
      runId: 'run-exact-first', round: 1, agent: 'claude' as const,
      title: 'Signal Garden', idea: 'A local task garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    const alternative = {
      ...exact,
      pitchId: 'pitch-111111111111111111111111',
      agent: 'codex' as const,
      title: 'Bloom Board'
    }
    const record = resolveConsensusProvenance({
      runId: 'run-exact-first', appName: 'Signal Garden',
      humanBrief: 'Build an app called Signal Garden.',
      qualityBriefFingerprint: 'quality:exact-first', pitches: [exact, alternative]
    })
    expect(record?.sourcePitchIds).toEqual([exact.pitchId])
    expect(record?.selectionMode).toBe('pitch-title')
  })

  it('records an explicit mixed selection as a human-named synthesis', () => {
    const exact = {
      pitchId: 'pitch-1206f237541e0c65df98249e', runId: 'run-mixed-selection', round: 1,
      agent: 'codex' as const, title: 'Signal Garden: Focus Horizon',
      idea: 'A focused horizon for task energy.', appeal: 'Clear.', risk: 'Scope.'
    }
    const teammate = {
      pitchId: 'pitch-e696f1d02378b6f9b6418be8', runId: 'run-mixed-selection', round: 2,
      agent: 'claude' as const, title: 'Rooted Signals',
      idea: 'A tactile task garden with visible growth.', appeal: 'Expressive.', risk: 'Motion.'
    }
    const record = resolveConsensusProvenance({
      runId: 'run-mixed-selection', appName: 'Signal Garden',
      humanBrief: 'Build a local app called Signal Garden.',
      qualityBriefFingerprint: 'quality:mixed-selection',
      selectedSourcePitchIds: [teammate.pitchId, exact.pitchId],
      pitches: [exact, teammate]
    })

    expect(record?.selectionMode).toBe('human-named-synthesis')
    expect(record?.sourcePitchIds).toEqual([teammate.pitchId, exact.pitchId])
    expect(record?.sourceAgents).toEqual(['claude', 'codex'])
  })

  it('keeps a sealed synthesis valid if a later same-run pitch record appears', () => {
    const pitches = [
      {
        pitchId: 'pitch-333333333333333333333333', runId: 'run-cutoff', round: 1,
        agent: 'codex' as const, title: 'Bloom Board', idea: 'A garden.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-444444444444444444444444', runId: 'run-cutoff', round: 2,
        agent: 'claude' as const, title: 'Focus Field', idea: 'A field.', appeal: 'Clear.', risk: 'Scope.'
      }
    ]
    const humanBrief = 'Build an app called Signal Garden.'
    const record = resolveConsensusProvenance({
      runId: 'run-cutoff', appName: 'Signal Garden', humanBrief,
      qualityBriefFingerprint: 'quality:cutoff',
      selectedSourcePitchIds: [pitches[0]!.pitchId],
      pitches
    })!
    const laterPitch = {
      pitchId: 'pitch-555555555555555555555555',
      runId: 'run-cutoff',
      round: 7,
      agent: 'codex' as const,
      title: 'Late Candidate',
      idea: 'A late idea.',
      appeal: 'Late.',
      risk: 'Late.'
    }

    expect(validateConsensusProvenance({
      record, runId: 'run-cutoff', humanBrief,
      qualityBriefFingerprint: 'quality:cutoff', immutablePitches: [...pitches, laterPitch]
    })).toBe(true)
  })

  it('rejects missing, duplicate, foreign, or oversized source selections', () => {
    const pitches = [
      {
        pitchId: 'pitch-666666666666666666666666', runId: 'run-selection', round: 1,
        agent: 'claude' as const, title: 'First', idea: 'First idea.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-777777777777777777777777', runId: 'run-selection', round: 2,
        agent: 'codex' as const, title: 'Second', idea: 'Second idea.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-888888888888888888888888', runId: 'run-selection', round: 2,
        agent: 'codex' as const, title: 'Third', idea: 'Third idea.', appeal: 'Clear.', risk: 'Scope.'
      }
    ]
    const base = {
      runId: 'run-selection', appName: 'Signal Garden', humanBrief: 'Build an app called Signal Garden.',
      qualityBriefFingerprint: 'quality:selection', pitches
    }

    expect(resolveConsensusProvenance({
      ...base,
      selectedSourcePitchIds: [pitches[0]!.pitchId, pitches[0]!.pitchId]
    })).toBeUndefined()
    expect(resolveConsensusProvenance({
      ...base,
      selectedSourcePitchIds: ['pitch-999999999999999999999999']
    })).toBeUndefined()
    expect(resolveConsensusProvenance({
      ...base,
      selectedSourcePitchIds: pitches.map((pitch) => pitch.pitchId)
    })).toBeUndefined()
  })
})
