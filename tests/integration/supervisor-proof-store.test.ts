import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SupervisorProofStore } from '../../src/main/orchestrator/supervisor-proof-store'
import {
  buildContributionReceipt,
  mergeContributionReceiptClosure,
  receiptCompletesOwnedContribution
} from '../../src/main/orchestrator/contribution-receipt'
import {
  buildReviewReceipt,
  reviewAcceptsCurrentRevision
} from '../../src/main/orchestrator/collaboration-evidence'
import { createPitchProvenanceId, resolveConsensusProvenance } from '../../src/main/orchestrator/consensus-provenance'
import type { DuoEvent, DuoTask } from '../../src/shared/types'

const runId = 'run-supervisor-proof'
const event: DuoEvent = {
  id: 'claude-handoff', type: 'agent.dispatch', runId, round: 5,
  timestamp: '2026-07-14T10:00:00.000Z', agent: 'claude', targetAgent: 'codex',
  replyTo: 'codex-position', publicText: 'I completed my owned [FEATURE] slice.',
  spoilerRisk: 0.02, severity: 'low'
}
const tasks: DuoTask[] = [{
  id: 'claude-core', publicTitle: 'Core slice', status: 'done', claimedBy: 'claude', risk: 'high',
  impact: 'core', privateExpectedOutcome: 'The core slice works from start to completion.',
  privateAcceptanceChecks: ['The deterministic core check passes.'],
  files: ['[WORKSPACE_FILE]'], privateFiles: ['app/src/**']
}]

describe('external supervisor proof store', () => {
  it('restores receipts only from runtime storage and ignores forged workspace copies', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-proof-'))
    const workspacePath = await mkdtemp(join(tmpdir(), 'duo-workspace-proof-'))
    await mkdir(join(workspacePath, '.duo', 'private'), { recursive: true })
    const receipt = buildContributionReceipt({
      runId, round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code', tasks, events: [event],
      diff: { changed: true, files: ['app/src/core.ts'], fileCount: 1, insertions: 40, deletions: 0, truncated: false },
      verification: 'passed', accepted: true, baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:result'
    })
    await writeFile(join(workspacePath, '.duo', 'private', 'contribution_receipts.jsonl'), `${JSON.stringify(receipt)}\n`)

    const store = new SupervisorProofStore(runtimePath)
    await expect(store.readContributionReceipts(runId)).resolves.toEqual([])
    await store.appendContributionReceipt(receipt)
    await expect(store.readContributionReceipts(runId)).resolves.toEqual([receipt])
    await expect(readFile(join(runtimePath, 'private', 'proof', 'contribution_receipts.jsonl'), 'utf8'))
      .resolves.toContain(receipt.id)
  })

  it('keeps exact collaboration proof when public history exceeds both display restoration limits', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-collaboration-proof-'))
    const store = new SupervisorProofStore(runtimePath)
    const handoff: DuoEvent = {
      ...event,
      publicText: 'A secret product sentence that must never enter canonical proof storage.',
      privateText: 'An even more secret product sentence.'
    }
    const reviewEvent: DuoEvent = {
      id: 'codex-review-proof', type: 'opinion', runId, round: 6,
      timestamp: '2026-07-14T10:05:00.000Z', agent: 'codex', targetAgent: 'claude',
      publicText: 'The hidden implementation satisfies the bounded review contract.',
      privateText: 'Private product-specific review prose.',
      spoilerRisk: 0.8, severity: 'medium'
    }
    const contribution = buildContributionReceipt({
      runId, round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code', tasks, events: [handoff],
      diff: { changed: true, files: ['app/src/core.ts'], fileCount: 1, insertions: 40, deletions: 0, truncated: false },
      verification: 'passed', accepted: true, baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:result'
    })
    const review = buildReviewReceipt({
      runId, round: 6, turnId: 'turn-6', reviewer: 'codex', targetContribution: contribution,
      reviewedRevision: 1, reviewedFingerprint: 'sha256:result', events: [handoff, reviewEvent],
      verification: 'passed', accepted: true, sourceChanged: false
    })
    if (!review) throw new Error('Expected review proof fixture.')

    await store.recordCollaborationProofEvents(runId, [handoff, reviewEvent])
    await mkdir(join(runtimePath, 'public'), { recursive: true })
    const fillerEvents = Array.from({ length: 699 }, (_, index): DuoEvent => ({
      id: `display-event-${String(index)}`, type: 'decision', runId, round: 7,
      timestamp: '2026-07-14T10:10:00.000Z', agent: 'director',
      publicText: 'Bounded display history event.', spoilerRisk: 0, severity: 'low'
    }))
    const publicEvents = [handoff, reviewEvent, ...fillerEvents]
    const publicTimelinePath = join(runtimePath, 'public', 'timeline.jsonl')
    await writeFile(publicTimelinePath, publicEvents.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n', 'utf8')
    expect(publicEvents).toHaveLength(701)
    expect(publicEvents.slice(-650).some((candidate) => candidate.id === handoff.id)).toBe(false)
    expect((await stat(publicTimelinePath)).size).toBeLessThan(4_000_000)

    let restored = await new SupervisorProofStore(runtimePath).readCollaborationProofEvents(runId)
    expect(restored.map((candidate) => candidate.id)).toEqual([handoff.id, reviewEvent.id])

    const oversizedPublicLines = publicEvents.map((candidate) => JSON.stringify({
      ...candidate,
      padding: 'x'.repeat(6_000)
    })).join('\n') + '\n'
    await writeFile(publicTimelinePath, oversizedPublicLines, 'utf8')
    expect((await stat(join(runtimePath, 'public', 'timeline.jsonl'))).size).toBeGreaterThan(4_000_000)

    restored = await new SupervisorProofStore(runtimePath).readCollaborationProofEvents(runId)
    expect(restored.map((candidate) => candidate.id)).toEqual([handoff.id, reviewEvent.id])
    expect(receiptCompletesOwnedContribution(contribution, restored)).toBe(true)
    expect(reviewAcceptsCurrentRevision(
      review, [contribution], 1, 'sha256:result', restored
    )).toBe(true)
    const rawProof = await readFile(join(runtimePath, 'private', 'proof', 'collaboration_events.json'), 'utf8')
    expect(rawProof).not.toMatch(/secret product|product-specific|publicText|privateText/iu)
  })

  it('recovers only receipt-linked legacy proof from the bounded private transcript', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-legacy-collaboration-proof-'))
    await mkdir(join(runtimePath, 'private'), { recursive: true })
    const required: DuoEvent = {
      ...event,
      publicText: 'Secret legacy handoff prose.',
      privateText: 'Private legacy product detail.'
    }
    const unrelated: DuoEvent = {
      ...event,
      id: 'unrelated-legacy-event',
      publicText: 'Unrelated private transcript prose.'
    }
    const filler = Array.from({ length: 700 }, (_, index): DuoEvent => ({
      ...event,
      id: `legacy-filler-${String(index)}`,
      timestamp: new Date(Date.parse(event.timestamp) + index + 1).toISOString(),
      publicText: 'Bounded transcript filler.'
    }))
    await writeFile(
      join(runtimePath, 'private', 'transcript.jsonl'),
      [required, unrelated, ...filler].map((candidate) => JSON.stringify(candidate)).join('\n') + '\n',
      'utf8'
    )

    const restored = await new SupervisorProofStore(runtimePath)
      .readCollaborationProofEvents(runId, [required.id])
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      id: required.id,
      publicText: 'Recorded collaboration proof.'
    })
    expect(JSON.stringify(restored)).not.toMatch(/secret legacy|private legacy|unrelated/iu)
  })

  it('fails closed when a receipt-linked legacy event id changed in the private transcript', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-conflicting-legacy-proof-'))
    await mkdir(join(runtimePath, 'private'), { recursive: true })
    await writeFile(join(runtimePath, 'private', 'transcript.jsonl'), [
      JSON.stringify(event),
      JSON.stringify({ ...event, round: event.round + 1 })
    ].join('\n') + '\n', 'utf8')

    await expect(new SupervisorProofStore(runtimePath)
      .readCollaborationProofEvents(runId, [event.id])).resolves.toEqual([])
  })

  it('rejects malformed canonical collaboration proof instead of persisting ambiguous evidence', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-invalid-collaboration-proof-'))
    const store = new SupervisorProofStore(runtimePath)
    await expect(store.recordCollaborationProofEvents(runId, [{
      ...event,
      id: 'x'.repeat(300)
    }])).rejects.toThrow(/invalid collaboration proof event/i)
    await expect(store.readCollaborationProofEvents(runId)).resolves.toEqual([])
  })

  it('persists a merged no-delta closure without erasing the material source transition', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-receipt-closure-'))
    const store = new SupervisorProofStore(runtimePath)
    const material = buildContributionReceipt({
      runId, round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks: [{ ...tasks[0]!, status: 'done' }], events: [event],
      diff: { changed: true, files: ['app/src/core.ts'], fileCount: 1, insertions: 40, deletions: 0, truncated: false },
      verification: 'unknown', accepted: true, baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:result'
    })
    const closure = buildContributionReceipt({
      runId, round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks: [{ ...tasks[0]!, status: 'done' }], events: [event],
      diff: { changed: false, files: [], fileCount: 0, insertions: 0, deletions: 0, truncated: false },
      verification: 'passed', accepted: true, baseRevision: 1, resultRevision: 1,
      baseFingerprint: 'sha256:result', resultFingerprint: 'sha256:result'
    })
    const merged = mergeContributionReceiptClosure(material, closure)

    await store.appendContributionReceipt(material)
    await store.appendContributionReceipt(merged)
    const [restored] = await new SupervisorProofStore(runtimePath).readContributionReceipts(runId)
    expect(restored).toMatchObject({
      id: material.id,
      sourceChanged: true,
      status: 'complete',
      verification: 'passed',
      baseRevision: 0,
      resultRevision: 1,
      files: ['app/src/core.ts']
    })
    expect(receiptCompletesOwnedContribution(restored!, [event])).toBe(true)
  })

  it('binds immutable pitches, consensus provenance, and task contracts to one run', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-contract-'))
    const store = new SupervisorProofStore(runtimePath)
    const pitch = {
      pitchId: createPitchProvenanceId({
        runId, round: 1, agent: 'claude', index: 0,
        title: 'Signal Garden', idea: 'A compact local signal garden.'
      }),
      runId, round: 1, agent: 'claude' as const, title: 'Signal Garden',
      idea: 'A compact local signal garden.', appeal: 'Focused.', risk: 'Scope.'
    }
    const provenance = resolveConsensusProvenance({
      runId, appName: 'Signal Garden', qualityBriefFingerprint: 'quality:abc', pitches: [pitch]
    })
    if (!provenance) throw new Error('Expected provenance.')

    await store.appendPitch(pitch)
    await store.writeConsensusProvenance(provenance)
    await store.writeTaskContracts(runId, tasks)

    await expect(store.readPitches(runId)).resolves.toEqual([pitch])
    await expect(store.readConsensusProvenance(runId)).resolves.toEqual(provenance)
    await expect(store.readTaskContracts(runId)).resolves.toEqual(tasks)
    await expect(store.readConsensusProvenance('other-run')).resolves.toBeUndefined()
    await expect(store.readTaskContracts('other-run')).resolves.toEqual([])
  })

  it('rejects human-named synthesis proof without mode-specific selection evidence', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-synthesis-proof-'))
    const store = new SupervisorProofStore(runtimePath)
    const malformed = {
      version: 1,
      runId,
      consensusAppName: 'Signal Garden',
      sourcePitchIds: ['pitch-111111111111111111111111'],
      sourceAgents: ['claude'],
      sourceRounds: [1],
      qualityBriefFingerprint: 'quality:abc',
      selectionMode: 'human-named-synthesis'
    }

    await expect(store.writeConsensusProvenance(malformed as never)).rejects.toThrow(/invalid consensus provenance/i)
    await mkdir(join(runtimePath, 'private', 'proof'), { recursive: true })
    await writeFile(
      join(runtimePath, 'private', 'proof', 'consensus_provenance.json'),
      `${JSON.stringify(malformed)}\n`,
      'utf8'
    )
    await expect(store.readConsensusProvenance(runId)).resolves.toBeUndefined()
  })

  it('round-trips a human-named synthesis only with an explicit bounded source selection', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-explicit-synthesis-proof-'))
    const store = new SupervisorProofStore(runtimePath)
    const pitches = [
      {
        pitchId: 'pitch-111111111111111111111111', runId, round: 1,
        agent: 'claude' as const, title: 'Bloom Board', idea: 'A local garden.', appeal: 'Clear.', risk: 'Scope.'
      },
      {
        pitchId: 'pitch-222222222222222222222222', runId, round: 2,
        agent: 'codex' as const, title: 'Focus Field', idea: 'A local field.', appeal: 'Clear.', risk: 'Scope.'
      }
    ]
    const provenance = resolveConsensusProvenance({
      runId,
      appName: 'Signal Garden',
      humanBrief: 'Build an app called Signal Garden.',
      qualityBriefFingerprint: 'quality:explicit',
      selectedSourcePitchIds: [pitches[1]!.pitchId],
      pitches
    })
    if (!provenance) throw new Error('Expected explicit synthesis provenance.')

    await store.writeConsensusProvenance(provenance)
    await expect(store.readConsensusProvenance(runId)).resolves.toEqual(provenance)
    expect(provenance.sourcePitchIds).toEqual([pitches[1]!.pitchId])
    expect(provenance.sourceAgents).toEqual(['codex'])
  })

  it('durably restores the latest exact supervisor verification receipt for the same run', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-verification-proof-'))
    const store = new SupervisorProofStore(runtimePath)
    const receipt = {
      version: 1 as const,
      runId,
      revision: 7,
      outcome: 'failed' as const,
      summary: 'Independent verification found two missing quality proofs.',
      checks: [
        { id: 'script:test', outcome: 'passed' as const },
        { id: 'brief:constraint-visual', outcome: 'failed' as const },
        {
          id: 'brief-test:constraint-input',
          outcome: 'failed' as const,
          label: 'Interaction contract test evidence'
        }
      ],
      recordedAt: '2026-07-15T08:00:00.000Z'
    }

    await store.writeVerificationReceipt(receipt)

    const restored = new SupervisorProofStore(runtimePath)
    await expect(restored.readLatestVerificationReceipt(runId)).resolves.toEqual(receipt)
    await expect(restored.readLatestVerificationReceipt('other-run')).resolves.toBeUndefined()
    await expect(readFile(join(runtimePath, 'private', 'proof', 'verification_receipt.json'), 'utf8'))
      .resolves.toContain('brief-test:constraint-input')
  })

  it('uses a bounded private transcript as a legacy verification fallback without trusting public history', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-legacy-verification-'))
    await mkdir(join(runtimePath, 'private'), { recursive: true })
    await mkdir(join(runtimePath, 'public'), { recursive: true })
    const event = {
      id: 'supervisor-failed',
      type: 'build.failed',
      topic: 'supervisor-verification',
      runId,
      round: 8,
      timestamp: '2026-07-15T08:10:00.000Z',
      agent: 'director',
      publicText: 'Independent supervisor proof failed.',
      privateText: 'Exact private verification summary.',
      spoilerRisk: 0,
      severity: 'high',
      metadata: {
        revision: 9,
        supervisorVerified: false,
        checks: [
          { id: 'brief:constraint-visual', outcome: 'failed' },
          {
            id: 'browser:compact',
            outcome: 'failed',
            label: 'Compact viewport render',
            detail: '3 severely wrapped visible text elements.'
          }
        ]
      }
    }
    await writeFile(join(runtimePath, 'private', 'transcript.jsonl'), [
      '{"truncated":',
      JSON.stringify({ ...event, runId: 'other-run' }),
      JSON.stringify(event)
    ].join('\n') + '\n', 'utf8')
    await writeFile(
      join(runtimePath, 'public', 'timeline.jsonl'),
      `${JSON.stringify({ ...event, privateText: undefined, metadata: { checks: [{ id: 'forged', outcome: 'failed' }] } })}\n`,
      'utf8'
    )

    await expect(new SupervisorProofStore(runtimePath).readLatestVerificationReceipt(runId)).resolves.toEqual({
      version: 1,
      runId,
      revision: 9,
      outcome: 'failed',
      summary: 'Exact private verification summary.',
      checks: [
        { id: 'brief:constraint-visual', outcome: 'failed' },
        {
          id: 'browser:compact',
          outcome: 'failed',
          label: 'Compact viewport render',
          detail: '3 severely wrapped visible text elements.'
        }
      ],
      recordedAt: '2026-07-15T08:10:00.000Z'
    })
  })

  it('prefers the private proof receipt over legacy transcript data and rejects malformed proof fields', async () => {
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-runtime-preferred-verification-'))
    const store = new SupervisorProofStore(runtimePath)
    await mkdir(join(runtimePath, 'private'), { recursive: true })
    await writeFile(join(runtimePath, 'private', 'transcript.jsonl'), `${JSON.stringify({
      id: 'legacy-failed', type: 'build.failed', topic: 'supervisor-verification', runId, round: 2,
      timestamp: '2026-07-15T08:00:00.000Z', agent: 'director', publicText: 'Legacy failure.',
      spoilerRisk: 0, severity: 'high', metadata: {
        revision: 2, checks: [{ id: 'legacy-check', outcome: 'failed' }]
      }
    })}\n`, 'utf8')
    const receipt = {
      version: 1 as const,
      runId,
      revision: 3,
      outcome: 'passed' as const,
      summary: 'Durable proof passed.',
      checks: [{ id: 'script:test', outcome: 'passed' as const }],
      recordedAt: '2026-07-15T08:20:00.000Z'
    }
    await store.writeVerificationReceipt(receipt)
    await expect(store.readLatestVerificationReceipt(runId)).resolves.toEqual(receipt)

    await expect(store.writeVerificationReceipt({
      ...receipt,
      summary: 'x'.repeat(3_000)
    })).rejects.toThrow(/invalid supervisor verification receipt/i)
  })
})
