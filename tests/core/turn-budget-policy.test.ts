import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURN_BUDGET_POLICY,
  extendStageDeadlineForPause,
  remainingStageLeaseSeconds,
  resolveResumeStageLeaseSeconds,
  resolveStageBudgetSeconds,
  validateTurnBudgetPolicy
} from '../../src/main/orchestrator/turn-budget'

describe('broadcast turn budget policy', () => {
  it('keeps dialogue, verdict, and recovery bounded while allowing long work leases', () => {
    expect(DEFAULT_TURN_BUDGET_POLICY).toMatchObject({
      workLeaseSeconds: 7_200,
      runTimeoutSeconds: 86_400,
      verdictSeconds: 180,
      recoverySeconds: 600
    })
    expect(DEFAULT_TURN_BUDGET_POLICY.dialogueSeconds).toBeLessThanOrEqual(600)

    expect(resolveStageBudgetSeconds('dialogue', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBeLessThanOrEqual(600)
    expect(resolveStageBudgetSeconds('opening', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBeLessThanOrEqual(600)
    expect(resolveStageBudgetSeconds('verdict', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBe(180)
    expect(resolveStageBudgetSeconds('recovery', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBe(600)
    expect(resolveStageBudgetSeconds('work', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBe(7_200)
  })

  it('accepts the published maxima and rejects larger budgets', () => {
    const maximum = {
      ...DEFAULT_TURN_BUDGET_POLICY,
      dialogueSeconds: 600,
      workLeaseSeconds: 28_800,
      runTimeoutSeconds: 86_400
    }

    expect(() => validateTurnBudgetPolicy(maximum)).not.toThrow()
    expect(() => validateTurnBudgetPolicy({ ...maximum, dialogueSeconds: 601 })).toThrow(/dialogue/i)
    expect(() => validateTurnBudgetPolicy({ ...maximum, workLeaseSeconds: 28_801 })).toThrow(/work|lease/i)
    expect(() => validateTurnBudgetPolicy({ ...maximum, verdictSeconds: 181 })).toThrow(/verdict/i)
    expect(() => validateTurnBudgetPolicy({ ...maximum, recoverySeconds: 601 })).toThrow(/recovery/i)
    expect(() => validateTurnBudgetPolicy({ ...maximum, runTimeoutSeconds: 86_401 })).toThrow(/run|ceiling|timeout/i)
  })

  it('never grants a stage more time than remains in the overall run', () => {
    expect(resolveStageBudgetSeconds('work', DEFAULT_TURN_BUDGET_POLICY, 75)).toBe(75)
    expect(resolveStageBudgetSeconds('verdict', DEFAULT_TURN_BUDGET_POLICY, 45)).toBe(45)
    expect(resolveStageBudgetSeconds('recovery', DEFAULT_TURN_BUDGET_POLICY, 0)).toBe(0)
  })

  it('freezes a stage lease during a pause and resumes only its exact remainder', () => {
    const deadline = '2026-07-13T12:10:00.000Z'
    const resumedDeadline = extendStageDeadlineForPause(
      deadline,
      Date.parse('2026-07-13T12:04:00.000Z'),
      Date.parse('2026-07-13T13:04:00.000Z')
    )
    expect(resumedDeadline).toBe('2026-07-13T13:10:00.000Z')
    expect(remainingStageLeaseSeconds(resumedDeadline, Date.parse('2026-07-13T13:04:00.000Z'))).toBe(360)
    expect(resolveStageBudgetSeconds('work', DEFAULT_TURN_BUDGET_POLICY, 10_000, 360)).toBe(360)
  })

  it('grants a fresh bounded contract-recovery lease on explicit resume', () => {
    expect(resolveResumeStageLeaseSeconds('recovery', 0, DEFAULT_TURN_BUDGET_POLICY)).toBe(600)
    expect(resolveResumeStageLeaseSeconds('recovery', 45, DEFAULT_TURN_BUDGET_POLICY)).toBe(600)
    expect(resolveResumeStageLeaseSeconds('work', 0, DEFAULT_TURN_BUDGET_POLICY)).toBe(0)
    expect(resolveResumeStageLeaseSeconds('dialogue', 0, DEFAULT_TURN_BUDGET_POLICY)).toBe(0)
  })
})
