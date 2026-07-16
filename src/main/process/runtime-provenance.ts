import type {
  CodexEffort,
  ProviderRuntimeEvidenceSource,
  ProviderRuntimeObservation
} from '@shared/types'
import { decodeProviderEnvelope, type ProviderRecord } from './provider-envelope'

export type RuntimeProvenanceAgent = 'claude' | 'codex'

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SUPPORTED_EFFORTS = new Set<Exclude<CodexEffort, 'default'>>([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
])

const SOURCE_FOR_AGENT: Record<RuntimeProvenanceAgent, ProviderRuntimeEvidenceSource> = {
  claude: 'claude-system-init',
  codex: 'codex-thread-started'
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeModel(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_MODEL.test(value) ? value : undefined
}

function canonicalEffort(value: unknown): Exclude<CodexEffort, 'default'> | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replaceAll('_', '-').replace(/^extra-high$/u, 'xhigh')
  return SUPPORTED_EFFORTS.has(normalized as Exclude<CodexEffort, 'default'>)
    ? normalized as Exclude<CodexEffort, 'default'>
    : undefined
}

function isInitRecord(agent: RuntimeProvenanceAgent, record: ProviderRecord): boolean {
  return agent === 'claude'
    ? record.type === 'system' && record.subtype === 'init'
    : record.type === 'thread.started'
}

function topLevelEffort(agent: RuntimeProvenanceAgent, record: ProviderRecord): Exclude<CodexEffort, 'default'> | undefined {
  if (agent === 'claude') return canonicalEffort(record.effort ?? record.effort_level)
  return canonicalEffort(record.effort ?? record.reasoning_effort ?? record.model_reasoning_effort)
}

/**
 * Extracts provider-observed runtime identity only from the provider's
 * allowlisted top-level initialization record. Nested messages, assistant
 * content, requested CLI arguments, and arbitrary model-looking strings are
 * deliberately ignored.
 */
export function extractProviderRuntimeObservation(
  agent: RuntimeProvenanceAgent,
  payload: unknown,
  recordedAt = new Date().toISOString()
): ProviderRuntimeObservation | undefined {
  if (!Number.isFinite(Date.parse(recordedAt))) return undefined
  for (const record of decodeProviderEnvelope(payload)) {
    if (!isInitRecord(agent, record)) continue
    const model = safeModel(record.model)
    const effort = topLevelEffort(agent, record)
    if (!model && !effort) continue
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      source: SOURCE_FOR_AGENT[agent],
      recordedAt
    }
  }
  return undefined
}

/** Validates a persisted observation before it is projected into a run. */
export function parseProviderRuntimeObservation(
  value: unknown,
  agent: RuntimeProvenanceAgent
): ProviderRuntimeObservation | undefined {
  const record = recordOf(value)
  if (!record || record.source !== SOURCE_FOR_AGENT[agent]) return undefined
  const model = safeModel(record.model)
  const effort = canonicalEffort(record.effort)
  const recordedAt = typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt))
    ? record.recordedAt
    : undefined
  if ((!model && !effort) || !recordedAt) return undefined
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    source: SOURCE_FOR_AGENT[agent],
    recordedAt
  }
}

export function sameProviderRuntimeObservation(
  left: ProviderRuntimeObservation | undefined,
  right: ProviderRuntimeObservation
): boolean {
  return left?.model === right.model && left?.effort === right.effort && left?.source === right.source
}
