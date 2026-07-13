import { describe, expect, it } from 'vitest'
import { repinUnavailableProvider } from '../../src/main/orchestrator/resume-loadout'
import type { StartRunRequest } from '../../src/shared/types'

const request: StartRunRequest = {
  prompt: 'Build a durable local app.',
  workspaceRoot: 'C:\\workspace',
  executionMode: 'chaos',
  visibilityMode: 'spoiler-shield',
  missionProfile: 'surprise',
  maxTurns: 12,
  maxRepairLoops: 4,
  turnTimeoutSeconds: 7_200,
  runTimeoutSeconds: 86_400,
  dangerousModeConfirmed: false,
  unsafeWorkspaceRootConfirmed: false,
  codexModel: 'old-codex',
  codexEffort: 'high',
  claudeModel: 'old-claude',
  claudeEffort: 'max'
}

describe('model-unavailable resume loadout', () => {
  it('repins only the provider that failed to the currently applied loadout', () => {
    expect(repinUnavailableProvider(request, {
      codexModel: 'new-codex',
      codexEffort: 'low',
      claudeModel: 'new-claude',
      claudeEffort: 'medium'
    }, 'claude')).toMatchObject({
      codexModel: 'old-codex',
      codexEffort: 'high',
      claudeModel: 'new-claude',
      claudeEffort: 'medium'
    })
  })

  it('leaves pinned models unchanged for non-model pause reasons', () => {
    const result = repinUnavailableProvider(request, {
      codexModel: 'new-codex',
      codexEffort: 'low',
      claudeModel: 'new-claude',
      claudeEffort: 'medium'
    })
    expect(result).toEqual(request)
  })
})
