import type { AgentRuntimeProfile } from '@shared/types'

const MODEL_LABELS: Record<string, string> = {
  'gpt-5.6-sol': 'Sol',
  'gpt-5.6-terra': 'Terra',
  fable: 'Fable',
  'claude-fable-5': 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet'
}

const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' } as const

export function formatModelLabel(model: string): string {
  const normalized = model.trim()
  if (!normalized) return 'CLI default'
  const key = normalized.toLowerCase()
  const exact = MODEL_LABELS[key]
  if (exact) return exact
  const family = [
    ['fable', 'Fable'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['sol', 'Sol'],
    ['terra', 'Terra']
  ].find(([token]) => new RegExp(`\\b${token}\\b`, 'i').test(key))
  return family?.[1] ?? normalized
}

export function formatRuntimeProfile(runtime?: AgentRuntimeProfile): string {
  if (!runtime) return 'CLI default'
  const model = formatModelLabel(runtime.model ?? '')
  return runtime.effort ? `${model} · ${EFFORT_LABELS[runtime.effort]}` : model
}
