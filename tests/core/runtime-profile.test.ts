import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../src/main/settings/settings-store'
import {
  parseClaudeRuntimeConfig,
  parseCodexRuntimeConfig,
  resolveRuntimeProfile
} from '../../src/main/health/runtime-profile'

describe('agent runtime profiles', () => {
  it('reads only top-level Codex model and reasoning effort values', () => {
    expect(parseCodexRuntimeConfig(`
model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"

[profiles.fast]
model = "gpt-5.6-terra"
model_reasoning_effort = "low"
`)).toEqual({ model: 'gpt-5.6-sol', effort: 'ultra' })
  })

  it('reads supported Claude model and effort settings without exposing other configuration', () => {
    expect(parseClaudeRuntimeConfig(JSON.stringify({ model: 'opus', effort: 'high', apiKey: 'never-return-this' })))
      .toEqual({ model: 'opus', effort: 'high' })
    expect(parseClaudeRuntimeConfig(JSON.stringify({ model: 'fable', effort: 'ultra' })))
      .toEqual({ model: 'fable' })
  })

  it('prefers Studio overrides and labels unresolved models as CLI defaults', () => {
    const settings = defaultSettings('C:\\runs')
    expect(resolveRuntimeProfile('codex', { ...settings, codexModel: 'gpt-5.6-terra', codexEffort: 'max' }, { model: 'gpt-5.6-sol', effort: 'xhigh' }))
      .toEqual({ model: 'gpt-5.6-terra', effort: 'max', source: 'studio' })
    expect(resolveRuntimeProfile('claude', settings, {})).toEqual({ source: 'cli-default' })
    expect(resolveRuntimeProfile('claude', settings, { effort: 'ultra' })).toEqual({ source: 'cli-default' })
  })
})
