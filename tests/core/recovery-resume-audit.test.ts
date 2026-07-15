import { describe, expect, it } from 'vitest'
import {
  RECOVERY_RESUME_ADVISORY_THRESHOLD,
  recoveryResumeAuditKey,
  recordExplicitRecoveryResume
} from '../../src/main/orchestrator/recovery-resume-audit'

describe('explicit recovery resume audit', () => {
  it('uses a stable bounded key without exposing run or turn text', () => {
    const first = recoveryResumeAuditKey({
      runId: 'duo-run-private-name',
      turnId: 'turn-with-private-product-name',
      originStage: 'dialogue'
    })
    const second = recoveryResumeAuditKey({
      runId: 'duo-run-private-name',
      turnId: 'turn-with-private-product-name',
      originStage: 'dialogue'
    })

    expect(first).toBe(second)
    expect(first).toMatch(/^recovery-resume:[a-f0-9]{32}$/u)
    expect(first).not.toContain('private')
  })

  it('keeps distinct bounded contract-failure categories independent on the same turn', () => {
    const missingDispatch = recoveryResumeAuditKey({
      runId: 'duo-run-audit', turnId: 'turn-1', originStage: 'work', reasonCategory: 'missing-dispatch'
    })
    const missingEvidence = recoveryResumeAuditKey({
      runId: 'duo-run-audit', turnId: 'turn-1', originStage: 'work', reasonCategory: 'missing-work-evidence'
    })

    expect(missingDispatch).not.toBe(missingEvidence)
    expect(missingDispatch).not.toContain('dispatch')
    expect(missingEvidence).not.toContain('evidence')
  })

  it('persists an advisory counter without ever hard-blocking explicit recovery', () => {
    const key = recoveryResumeAuditKey({ runId: 'duo-run-audit', turnId: 'turn-1', originStage: 'work' })
    let records: Parameters<typeof recordExplicitRecoveryResume>[0] = []

    for (let attempts = 1; attempts <= RECOVERY_RESUME_ADVISORY_THRESHOLD + 1; attempts += 1) {
      const recorded = recordExplicitRecoveryResume(records, {
        idempotencyKey: key,
        reason: 'provider-protocol',
        updatedAt: `2026-07-15T00:00:0${String(attempts)}.000Z`
      })
      records = recorded.records
      expect(recorded.attempts).toBe(attempts)
      expect(recorded.advisory).toBe(attempts >= RECOVERY_RESUME_ADVISORY_THRESHOLD)
      expect(recorded.allowed).toBe(true)
    }

    expect(records).toEqual([{
      idempotencyKey: key,
      attempts: RECOVERY_RESUME_ADVISORY_THRESHOLD + 1,
      lastReason: 'provider-protocol',
      updatedAt: `2026-07-15T00:00:0${String(RECOVERY_RESUME_ADVISORY_THRESHOLD + 1)}.000Z`
    }])
  })

  it('keeps logical recoveries independent and bounds the durable ledger', () => {
    let records: Parameters<typeof recordExplicitRecoveryResume>[0] = []
    for (let index = 0; index < 205; index += 1) {
      records = recordExplicitRecoveryResume(records, {
        idempotencyKey: `recovery-resume:${String(index).padStart(32, '0')}`,
        reason: 'provider-protocol',
        updatedAt: new Date(Date.UTC(2026, 6, 15, 0, 0, index)).toISOString()
      }).records
    }

    expect(records).toHaveLength(200)
    expect(records[0]?.idempotencyKey).toBe(`recovery-resume:${String(5).padStart(32, '0')}`)
    expect(records.at(-1)?.idempotencyKey).toBe(`recovery-resume:${String(204).padStart(32, '0')}`)
  })
})
