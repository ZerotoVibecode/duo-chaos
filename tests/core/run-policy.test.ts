import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateRunRequest } from '../../src/main/security/run-policy'

const validRequest = {
  prompt: 'Build a surprising local app.',
  workspaceRoot: join(homedir(), 'DuoChaos', 'workspaces'),
  executionMode: 'chaos' as const,
  visibilityMode: 'spoiler-shield' as const,
  maxTurns: 12,
  maxRepairLoops: 3,
  turnTimeoutSeconds: 7_200,
  runTimeoutSeconds: 43_200,
  dangerousModeConfirmed: false,
  unsafeWorkspaceRootConfirmed: false
}

describe('run safety policy', () => {
  it('defaults legacy requests to surprise missions and accepts an explicit serious brief', () => {
    expect(validateRunRequest(validRequest)).toMatchObject({ missionProfile: 'surprise' })
    expect(validateRunRequest({ ...validRequest, missionProfile: 'serious' })).toMatchObject({ missionProfile: 'serious' })
  })

  it('accepts a dedicated nested workspace root', () => {
    expect(validateRunRequest(validRequest).workspaceRoot).toContain('DuoChaos')
  })

  it('rejects blank prompts and invalid budgets', () => {
    expect(() => validateRunRequest({ ...validRequest, prompt: ' ' })).toThrow(/prompt/i)
    expect(() => validateRunRequest({ ...validRequest, maxTurns: 0 })).toThrow(/turn/i)
  })

  it('requires the complete seven-call collaboration core', () => {
    expect(() => validateRunRequest({ ...validRequest, maxTurns: 6 })).toThrow(/seven|7|turn/i)
    expect(validateRunRequest({ ...validRequest, maxTurns: 7 })).toMatchObject({ maxTurns: 7 })
  })

  it('permits explicitly shortened deterministic harness plans without weakening the default', () => {
    expect(validateRunRequest(
      { ...validRequest, maxTurns: 2 },
      { minimumTurns: 2 }
    )).toMatchObject({ maxTurns: 2 })
  })

  it('accepts long recording budgets up to the published hard ceilings', () => {
    expect(validateRunRequest({
      ...validRequest,
      turnTimeoutSeconds: 28_800,
      runTimeoutSeconds: 86_400
    })).toMatchObject({ turnTimeoutSeconds: 28_800, runTimeoutSeconds: 86_400 })

    expect(() => validateRunRequest({ ...validRequest, turnTimeoutSeconds: 28_801 })).toThrow(/turn|work|lease/i)
    expect(() => validateRunRequest({ ...validRequest, runTimeoutSeconds: 86_401 })).toThrow(/run|timeout|ceiling/i)
  })

  it('requires explicit confirmation for YOLO Sandbox', () => {
    expect(() =>
      validateRunRequest({ ...validRequest, executionMode: 'yolo-sandbox' })
    ).toThrow(/confirmation/i)
  })

  it('does not require local capability trust for Simulation Mode because no provider is launched', () => {
    expect(validateRunRequest({
      ...validRequest,
      executionMode: 'simulation',
      codexCustomizationProfile: 'smart',
      claudeCustomizationProfile: 'smart',
      trustedLocalCapabilitiesConfirmed: false
    })).toMatchObject({ executionMode: 'simulation' })

    expect(() => validateRunRequest({
      ...validRequest,
      codexCustomizationProfile: 'smart',
      trustedLocalCapabilitiesConfirmed: false
    })).toThrow(/trust confirmation/i)
  })

  it('keeps Safe execution on Core tools because unattended MCP approvals cannot be requested', () => {
    expect(() => validateRunRequest({
      ...validRequest,
      executionMode: 'safe',
      codexCustomizationProfile: 'smart',
      claudeCustomizationProfile: 'smart',
      trustedLocalCapabilitiesConfirmed: true
    })).toThrow(/safe.*core|core.*safe/i)

    expect(validateRunRequest({
      ...validRequest,
      executionMode: 'safe',
      codexCustomizationProfile: 'core',
      claudeCustomizationProfile: 'core'
    })).toMatchObject({ executionMode: 'safe' })
  })

  it('rejects a home-directory root unless separately confirmed', () => {
    expect(() => validateRunRequest({ ...validRequest, workspaceRoot: homedir() })).toThrow(
      /protected root/i
    )
    expect(
      validateRunRequest({
        ...validRequest,
        workspaceRoot: homedir(),
        unsafeWorkspaceRootConfirmed: true
      }).workspaceRoot
    ).toBe(homedir())
  })
})
