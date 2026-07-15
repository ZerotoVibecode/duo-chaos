import { createHash } from 'node:crypto'
import type { TurnStageName } from '@shared/types'

export interface RecoveryResumeAuditRecord {
  idempotencyKey: string
  attempts: number
  lastReason?: string
  updatedAt: string
}

export const RECOVERY_RESUME_ADVISORY_THRESHOLD = 3
const MAX_DURABLE_RETRY_RECORDS = 200

export function recoveryResumeAuditKey(input: {
  runId: string
  turnId: string
  originStage?: Exclude<TurnStageName, 'recovery'>
  reasonCategory?: string
}): string {
  const reasonCategory = input.reasonCategory?.trim().slice(0, 256) || 'unspecified'
  const digest = createHash('sha256')
    .update(`${input.runId}\0${input.turnId}\0${input.originStage ?? 'unknown'}\0${reasonCategory}`)
    .digest('hex')
    .slice(0, 32)
  return `recovery-resume:${digest}`
}

/**
 * Records human-authorized recovery leases for diagnostics only. A warning is
 * raised after repeated resumes, but this function deliberately never blocks:
 * a hard retry cap would strand preserved work after a provider or Duo update.
 * Source work remains forbidden in recovery, each call still has the normal
 * ten-minute lease, and the overall active-run ceiling remains authoritative.
 */
export function recordExplicitRecoveryResume(
  records: RecoveryResumeAuditRecord[],
  input: {
    idempotencyKey: string
    reason: string
    updatedAt: string
  }
): {
  records: RecoveryResumeAuditRecord[]
  attempts: number
  advisory: boolean
  allowed: true
} {
  const current = records.find((record) => record.idempotencyKey === input.idempotencyKey)
  const attempts = (current?.attempts ?? 0) + 1
  const next: RecoveryResumeAuditRecord = {
    idempotencyKey: input.idempotencyKey,
    attempts,
    lastReason: input.reason.trim().slice(0, 128) || 'unknown',
    updatedAt: input.updatedAt
  }
  const retained = records
    .filter((record) => record.idempotencyKey !== input.idempotencyKey)
    .slice(-(MAX_DURABLE_RETRY_RECORDS - 1))

  return {
    records: [...retained, next],
    attempts,
    advisory: attempts >= RECOVERY_RESUME_ADVISORY_THRESHOLD,
    allowed: true
  }
}
