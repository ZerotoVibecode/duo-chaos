import { describe, expect, it } from 'vitest'
import {
  buildContributionReceipt,
  contributionBalance,
  parseContributionReceiptsJsonl,
  receiptCompletesOwnedContribution,
  survivingContributionReceipts
} from '../../src/main/orchestrator/contribution-receipt'
import type { DuoEvent, DuoTask } from '../../src/shared/types'

const tasks: DuoTask[] = [
  {
    id: 'claude-ui', publicTitle: 'Experience shell', status: 'done', claimedBy: 'claude', risk: 'high',
    impact: 'core', privateExpectedOutcome: 'The complete interaction is usable with pointer and keyboard input.',
    privateAcceptanceChecks: ['Pointer journey passes.', 'Keyboard journey passes.'],
    files: ['[WORKSPACE_FILE]'], privateFiles: ['app/src/**']
  },
  {
    id: 'codex-engine', publicTitle: 'Artifact engine', status: 'done', claimedBy: 'codex', risk: 'high',
    impact: 'core', privateExpectedOutcome: 'The complete state engine is deterministic and verified.',
    privateAcceptanceChecks: ['State transition tests pass.'],
    files: ['[WORKSPACE_FILE]'], privateFiles: ['app/engine/**']
  }
]

function dispatch(agent: 'claude' | 'codex', round = 5, replyTo = 'opponent-dispatch'): DuoEvent {
  return {
    id: `${agent}-handoff`, type: 'agent.dispatch', runId: 'run-receipt', round,
    timestamp: '2026-07-14T10:00:00.000Z', agent,
    targetAgent: agent === 'claude' ? 'codex' : 'claude', replyTo,
    publicText: 'I completed and verified my owned [FEATURE] slice.',
    spoilerRisk: 0.02, severity: 'low'
  }
}

describe('diff-backed contribution receipts', () => {
  it('accepts a meaningful owned contribution only when task, source, verification, and handoff all agree', () => {
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks, events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 80, deletions: 4, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.status).toBe('complete')
    expect(receipt.taskIds).toEqual(['claude-ui'])
    expect(receipt.taskProof).toEqual([expect.objectContaining({
      taskId: 'claude-ui',
      impact: 'core',
      expectedOutcome: tasks[0]!.privateExpectedOutcome,
      acceptanceChecks: tasks[0]!.privateAcceptanceChecks,
      expectedFiles: ['app/src/**'],
      touchedFiles: ['app/src/ui.tsx'],
      boundaryMatched: true,
      acceptanceSatisfied: true
    })])
    expect(receiptCompletesOwnedContribution(receipt, [dispatch('claude')])).toBe(true)
  })

  it('keeps a contribution continuing when its source delta misses the owned task boundary', () => {
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-boundary', agent: 'claude', kind: 'code',
      tasks, events: [dispatch('claude')],
      diff: { changed: true, files: ['app/engine/unrelated.ts'], fileCount: 1, insertions: 80, deletions: 4, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.status).toBe('continuing')
    expect(receipt.unresolvedRisks).toContain('owned-task-boundary-missed')
    expect(receipt.taskProof[0]).toMatchObject({ boundaryMatched: false, acceptanceSatisfied: true })
    expect(receiptCompletesOwnedContribution(receipt, [dispatch('claude')])).toBe(false)
  })

  it('keeps a durable edit in continuing state when the owned task is not complete', () => {
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks: [{ ...tasks[0]!, status: 'in-progress' }], events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'unknown', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.status).toBe('continuing')
    expect(receipt.unresolvedRisks).toContain('owned-task-incomplete')
    expect(receiptCompletesOwnedContribution(receipt, [dispatch('claude')])).toBe(false)
  })

  it('credits the completed material task without requiring every owned task to finish in one turn', () => {
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-multi-task', agent: 'claude', kind: 'code',
      tasks: [
        tasks[0]!,
        {
          ...tasks[0]!, id: 'claude-later', publicTitle: 'Later polish', status: 'open',
          privateExpectedOutcome: 'The later polish pass improves the finished experience.',
          privateAcceptanceChecks: ['The later polish review passes.'],
          privateFiles: ['app/polish/**']
        }
      ],
      events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.status).toBe('complete')
    expect(receipt.taskIds).toEqual(['claude-ui'])
    expect(receipt.taskProof).toHaveLength(1)
    expect(receiptCompletesOwnedContribution(receipt, [dispatch('claude')])).toBe(true)
  })

  it('measures accepted artifact balance rather than message counts', () => {
    const complete = (agent: 'claude' | 'codex', round: number) => buildContributionReceipt({
      runId: 'run-receipt', round, turnId: `turn-${String(round)}`, agent, kind: 'code',
      tasks, events: [dispatch(agent, round)],
      diff: {
        changed: true,
        files: [agent === 'claude' ? 'app/src/claude.ts' : 'app/engine/codex.ts'],
        fileCount: 1, insertions: 50, deletions: 2, truncated: false
      },
      verification: 'passed', accepted: true,
      baseRevision: round - 5, resultRevision: round - 4,
      baseFingerprint: round === 5 ? 'sha256:base' : 'sha256:claude',
      resultFingerprint: round === 5 ? 'sha256:claude' : 'sha256:codex'
    })

    expect(contributionBalance(
      [complete('claude', 5), complete('codex', 6)],
      [dispatch('claude', 5), dispatch('codex', 6)]
    )).toMatchObject({
      claude: 1,
      codex: 1,
      balanced: true
    })
  })

  it('restores only the newest valid receipt for the preserved run', () => {
    const first = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks: [{ ...tasks[0]!, status: 'in-progress' }], events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'unknown', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })
    const completed = { ...first, status: 'complete' as const, verification: 'passed' as const, unresolvedRisks: [] }
    const content = [
      JSON.stringify(first),
      '{not-json',
      JSON.stringify({ ...completed, runId: 'other-run' }),
      JSON.stringify(completed)
    ].join('\n')

    expect(parseContributionReceiptsJsonl(content, 'run-receipt')).toEqual([completed])
  })

  it('does not trust legacy append-only receipts without an exact revision transition', () => {
    const legacy = {
      id: 'legacy', runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      status: 'complete', taskIds: ['claude-ui'], files: ['app/src/ui.tsx'], fileCount: 1,
      insertions: 20, deletions: 0, sourceChanged: true, verification: 'passed',
      handoffRecorded: true, accepted: true, unresolvedRisks: []
    }

    expect(parseContributionReceiptsJsonl(JSON.stringify(legacy), 'run-receipt')).toEqual([])
  })

  it('keeps schema-v2 receipts resumable but never counts them without material task and event proof', () => {
    const complete = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks, events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })
    const legacyV2 = { ...complete } as Record<string, unknown>
    delete legacyV2.taskProof
    delete legacyV2.handoffEventIds

    const [restored] = parseContributionReceiptsJsonl(JSON.stringify(legacyV2), 'run-receipt')
    expect(restored).toBeDefined()
    expect(receiptCompletesOwnedContribution(restored!, [dispatch('claude')])).toBe(false)
  })

  it('requires every readiness-counted task to retain a material frozen contract', () => {
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-downgraded', agent: 'claude', kind: 'code',
      tasks: [{
        id: 'claude-ui', publicTitle: 'Experience shell', status: 'done', claimedBy: 'claude',
        risk: 'high', files: ['[WORKSPACE_FILE]']
      }],
      events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.status).toBe('continuing')
    expect(receipt.unresolvedRisks).toContain('owned-task-contract-missing')
    expect(receiptCompletesOwnedContribution(receipt, [dispatch('claude')])).toBe(false)
  })

  it('binds handoff proof to exact supervisor-recorded events', () => {
    const recorded = dispatch('claude', 5)
    const receipt = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks, events: [recorded],
      diff: { changed: true, files: ['app/src/ui.tsx'], fileCount: 1, insertions: 20, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })

    expect(receipt.handoffEventIds).toEqual([recorded.id])
    expect(receiptCompletesOwnedContribution(receipt, [recorded])).toBe(true)
    expect(receiptCompletesOwnedContribution(receipt, [{ ...recorded, id: 'different-event' }])).toBe(false)
  })

  it('keeps only complete contributions on the exact ancestry of the current app revision', () => {
    const claude = buildContributionReceipt({
      runId: 'run-receipt', round: 5, turnId: 'turn-5', agent: 'claude', kind: 'code',
      tasks, events: [dispatch('claude')],
      diff: { changed: true, files: ['app/src/claude.ts'], fileCount: 1, insertions: 50, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 0, resultRevision: 1,
      baseFingerprint: 'sha256:base', resultFingerprint: 'sha256:claude'
    })
    const codex = buildContributionReceipt({
      runId: 'run-receipt', round: 6, turnId: 'turn-6', agent: 'codex', kind: 'code',
      tasks, events: [dispatch('codex', 6)],
      diff: { changed: true, files: ['app/engine/codex.ts'], fileCount: 1, insertions: 50, deletions: 0, truncated: false },
      verification: 'passed', accepted: true,
      baseRevision: 1, resultRevision: 2,
      baseFingerprint: 'sha256:claude', resultFingerprint: 'sha256:codex'
    })

    const supervisorEvents = [dispatch('claude', 5), dispatch('codex', 6)]
    expect(survivingContributionReceipts([claude, codex], 2, 'sha256:codex', supervisorEvents)).toEqual([claude, codex])
    expect(survivingContributionReceipts([claude, codex], 2, 'sha256:drifted', supervisorEvents)).toEqual([])
  })
})
