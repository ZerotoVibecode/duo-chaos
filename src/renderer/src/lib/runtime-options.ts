import type {
  AgentEffort,
  AgentModelCapability,
  AgentRuntimeCatalog,
  CodexEffort,
  ToolHealth
} from '@shared/types'
import { formatModelLabel } from './runtime-label'

export type EffortOption = readonly [CodexEffort, string]

export const CLAUDE_EFFORT_OPTIONS: ReadonlyArray<readonly [AgentEffort, string]> = [
  ['default', 'CLI default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra High'],
  ['max', 'Max']
]

export const CODEX_EFFORT_OPTIONS: ReadonlyArray<EffortOption> = [
  ...CLAUDE_EFFORT_OPTIONS,
  ['ultra', 'Ultra']
]

export const CODEX_MODEL_SUGGESTIONS = ['gpt-5.6-sol', 'gpt-5.6-terra'] as const
export const CLAUDE_MODEL_SUGGESTIONS = ['fable', 'opus', 'sonnet'] as const

const capability = (
  id: string,
  efforts: AgentModelCapability['efforts']
): AgentModelCapability => ({ id, label: formatModelLabel(id), efforts })

export const FALLBACK_CODEX_MODELS: ReadonlyArray<AgentModelCapability> = CODEX_MODEL_SUGGESTIONS.map((id) =>
  capability(id, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
)

export const FALLBACK_CLAUDE_MODELS: ReadonlyArray<AgentModelCapability> = CLAUDE_MODEL_SUGGESTIONS.map((id) =>
  capability(id, ['low', 'medium', 'high', 'xhigh', 'max'])
)

export function runtimeModels(
  health: ToolHealth | undefined,
  fallback: ReadonlyArray<AgentModelCapability>
): ReadonlyArray<AgentModelCapability> {
  return health?.catalog?.models.length ? health.catalog.models : fallback
}

function capabilityFor(
  model: string,
  models: ReadonlyArray<AgentModelCapability>
): AgentModelCapability | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return undefined
  return models.find((candidate) => candidate.id.toLowerCase() === normalized)
}

export function effortOptionsForModel(
  model: string,
  models: ReadonlyArray<AgentModelCapability>,
  available: ReadonlyArray<EffortOption>
): ReadonlyArray<EffortOption> {
  const selected = capabilityFor(model, models)
  if (!selected) return available
  const supported = new Set<CodexEffort>(selected.efforts)
  return available.filter(([effort]) => effort === 'default' || supported.has(effort))
}

export function compatibleEffort(
  effort: CodexEffort,
  model: string,
  models: ReadonlyArray<AgentModelCapability>
): CodexEffort {
  if (effort === 'default') return effort
  const selected = capabilityFor(model, models)
  return !selected || selected.efforts.includes(effort) ? effort : 'default'
}

export function catalogSourceLabel(catalog?: AgentRuntimeCatalog): string {
  switch (catalog?.source) {
    case 'cli-live': return 'Live CLI catalog'
    case 'cli-bundled': return 'Bundled CLI catalog'
    case 'cli-help': return 'CLI help catalog'
    case 'fallback': return 'Built-in fallback catalog'
    default: return 'Built-in fallback catalog'
  }
}
