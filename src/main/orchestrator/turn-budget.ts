import type { TurnStageName } from '@shared/types'

export interface TurnBudgetPolicy {
  dialogueSeconds: number
  workLeaseSeconds: number
  verdictSeconds: number
  recoverySeconds: number
  runTimeoutSeconds: number
}

export const TURN_BUDGET_LIMITS = {
  dialogueSeconds: 600,
  workLeaseSeconds: 28_800,
  verdictSeconds: 180,
  recoverySeconds: 600,
  runTimeoutSeconds: 86_400
} as const

export const DEFAULT_TURN_BUDGET_POLICY: TurnBudgetPolicy = {
  dialogueSeconds: 600,
  workLeaseSeconds: 7_200,
  verdictSeconds: 180,
  recoverySeconds: 600,
  runTimeoutSeconds: 86_400
}

function assertBoundedInteger(
  label: string,
  value: number,
  maximum: number
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${String(maximum)} seconds.`)
  }
}

export function validateTurnBudgetPolicy(policy: TurnBudgetPolicy): TurnBudgetPolicy {
  assertBoundedInteger('Dialogue budget', policy.dialogueSeconds, TURN_BUDGET_LIMITS.dialogueSeconds)
  assertBoundedInteger('Work lease', policy.workLeaseSeconds, TURN_BUDGET_LIMITS.workLeaseSeconds)
  assertBoundedInteger('Verdict budget', policy.verdictSeconds, TURN_BUDGET_LIMITS.verdictSeconds)
  assertBoundedInteger('Recovery budget', policy.recoverySeconds, TURN_BUDGET_LIMITS.recoverySeconds)
  assertBoundedInteger('Run timeout', policy.runTimeoutSeconds, TURN_BUDGET_LIMITS.runTimeoutSeconds)
  return policy
}

export function resolveStageBudgetSeconds(
  stage: TurnStageName,
  policy: TurnBudgetPolicy,
  remainingRunSeconds: number,
  remainingStageSeconds?: number
): number {
  validateTurnBudgetPolicy(policy)
  const stageSeconds = stage === 'work'
    ? policy.workLeaseSeconds
    : stage === 'verdict'
      ? policy.verdictSeconds
      : stage === 'recovery'
        ? policy.recoverySeconds
        : policy.dialogueSeconds
  const remaining = Number.isFinite(remainingRunSeconds)
    ? Math.max(0, Math.floor(remainingRunSeconds))
    : 0
  const stageRemaining = remainingStageSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(remainingStageSeconds)
      ? Math.max(0, Math.floor(remainingStageSeconds))
      : 0
  return Math.min(stageSeconds, remaining, stageRemaining)
}

export function remainingStageLeaseSeconds(deadlineAt: string, nowMs: number): number {
  const deadlineMs = Date.parse(deadlineAt)
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0
  return Math.max(0, Math.floor((deadlineMs - nowMs) / 1_000))
}

/**
 * Contract recovery contains no source work and is only reached after a
 * completed provider call missed the broadcast contract. If that tiny lease
 * is rejected or expires as the battle is durably paused, an explicit Resume
 * needs one fresh bounded recovery window; a partial remainder may be too short
 * even to start the replacement provider call. Recovery cannot change source
 * and remains capped at ten minutes. Premium high-effort models can take more
 * than two minutes to assemble a large schema-valid consensus capsule, so the
 * recovery ceiling matches the normal dialogue ceiling. Source-work and normal
 * dialogue leases remain exact and cannot be renewed by this helper.
 */
export function resolveResumeStageLeaseSeconds(
  stage: TurnStageName,
  remainingStageSeconds: number,
  policy: TurnBudgetPolicy
): number {
  validateTurnBudgetPolicy(policy)
  const remaining = Number.isFinite(remainingStageSeconds)
    ? Math.max(0, Math.floor(remainingStageSeconds))
    : 0
  return stage === 'recovery' ? policy.recoverySeconds : remaining
}

export function extendStageDeadlineForPause(
  deadlineAt: string,
  pausedAtMs: number,
  resumedAtMs: number
): string {
  const deadlineMs = Date.parse(deadlineAt)
  if (!Number.isFinite(deadlineMs)) throw new Error('Stage deadline must be a valid timestamp.')
  const pausedDurationMs = Math.max(0, resumedAtMs - pausedAtMs)
  return new Date(deadlineMs + pausedDurationMs).toISOString()
}
