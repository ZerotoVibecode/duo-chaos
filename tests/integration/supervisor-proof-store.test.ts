import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SupervisorProofStore } from '../../src/main/orchestrator/supervisor-proof-store'
import { buildContributionReceipt } from '../../src/main/orchestrator/contribution-receipt'
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
})
