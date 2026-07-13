import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURN_BUDGET_POLICY,
  resolveStageBudgetSeconds,
  validateTurnBudgetPolicy
} from '../../src/main/orchestrator/turn-budget'

describe('broadcast turn budget policy', () => {
  it('keeps dialogue, verdict, and recovery bounded while allowing long work leases', () => {
    expect(DEFAULT_TURN_BUDGET_POLICY).toMatchObject({
      workLeaseSeconds: 7_200,
      runTimeoutSeconds: 86_400,
      verdictSeconds: 180,
      recoverySeconds: 120
    })
    expect(DEFAULT_TURN_BUDGET_POLICY.dialogueSeconds).toBeLessThanOrEqual(600)

    expect(resolveStageBudgetSeconds('dialogue', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBeLessThanOrEqual(600)
    expect(resolveStageBudgetSeconds('opening', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBeLessThanOrEqual(600)
    expect(resolveStageBudgetSeconds('verdict', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBe(180)
    expect(resolveStageBudgetSeconds('recovery', DEFAULT_TURN_BUDGET_POLICY, 86_400)).toBe(120)
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
    expect(() => validateTurnBudgetPolicy({ ...maximum, recoverySeconds: 121 })).toThrow(/recovery/i)
    expect(() => validateTurnBudgetPolicy({ ...maximum, runTimeoutSeconds: 86_401 })).toThrow(/run|ceiling|timeout/i)
  })

  it('never grants a stage more time than remains in the overall run', () => {
    expect(resolveStageBudgetSeconds('work', DEFAULT_TURN_BUDGET_POLICY, 75)).toBe(75)
    expect(resolveStageBudgetSeconds('verdict', DEFAULT_TURN_BUDGET_POLICY, 45)).toBe(45)
    expect(resolveStageBudgetSeconds('recovery', DEFAULT_TURN_BUDGET_POLICY, 0)).toBe(0)
  })
})
