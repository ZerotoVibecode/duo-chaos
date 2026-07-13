import { describe, expect, it } from 'vitest'
import * as healthModule from '../../src/main/health/health-check'

interface CatalogModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort?: string
}

type CatalogParser = (raw: string) => CatalogModel[]

const parseCodex = (healthModule as unknown as { parseCodexModelCatalog?: CatalogParser }).parseCodexModelCatalog
const parseClaude = (healthModule as unknown as { parseClaudeHelpCatalog?: CatalogParser }).parseClaudeHelpCatalog
const buildProbeEnvironment = (healthModule as unknown as {
  buildRuntimeProbeEnvironment?: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}).buildRuntimeProbeEnvironment

describe('local runtime catalog parsing', () => {
  it('allowlists visible Codex models and their model-specific efforts', () => {
    const raw = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'future-unknown' }],
          base_instructions: 'must never leave the parser'
        },
        { slug: 'codex-auto-review', display_name: 'Internal review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'xhigh' }] },
        { slug: 'GPT-5.6-SOL', display_name: 'Duplicate', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] }
      ]
    })

    expect(parseCodex?.(raw)).toEqual([{
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      efforts: ['low', 'ultra'],
      defaultEffort: 'low'
    }])
  })

  it('extracts only Claude model aliases and supported automated efforts from local help', () => {
    const help = `
  --effort <level>      Effort level for the current session
                        (low, medium, high, xhigh, max)
  --model <model>       Model for the current session. Provide an alias for the latest model
                        (e.g. 'fable', 'opus', or 'sonnet') or a full model name
                        (e.g. 'claude-fable-5')
  --output-format       Output format
`

    expect(parseClaude?.(help)).toEqual(['fable', 'opus', 'sonnet'].map((id) => ({
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
      efforts: ['low', 'medium', 'high', 'xhigh', 'max']
    })))
  })

  it('returns an empty safe result for malformed or unrelated output', () => {
    expect(parseCodex?.('{not-json')).toEqual([])
    expect(parseClaude?.('--permission-mode plan')).toEqual([])
  })

  it('strips ambient secrets and runtime injection flags from catalog probes', () => {
    expect(buildProbeEnvironment?.({
      PATH: 'C:\\Tools',
      SAFE_FLAG: 'visible',
      DATABASE_URL: 'postgres://private',
      SENTRY_DSN: 'https://private@sentry.example/1',
      OPENAI_API_KEY: 'private',
      ANTHROPIC_AUTH_TOKEN: 'private',
      NODE_OPTIONS: '--require malicious.js'
    })).toEqual({ PATH: 'C:\\Tools', NO_COLOR: '1', TERM: 'dumb' })
  })
})
