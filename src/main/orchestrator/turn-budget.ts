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
  recoverySeconds: 120,
  runTimeoutSeconds: 86_400
} as const

export const DEFAULT_TURN_BUDGET_POLICY: TurnBudgetPolicy = {
  dialogueSeconds: 600,
  workLeaseSeconds: 7_200,
  verdictSeconds: 180,
  recoverySeconds: 120,
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
