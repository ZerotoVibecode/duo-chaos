const ENVELOPE_KEYS = [
  'batch',
  'batches',
  'data',
  'envelope',
  'events',
  'payload',
  'records',
  'response',
  'responses'
] as const

const MAX_ENVELOPE_DEPTH = 8
const MAX_PROVIDER_RECORDS = 2_048

export type ProviderRecord = Record<string, unknown>

function recordOf(value: unknown): ProviderRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ProviderRecord
    : undefined
}

/**
 * Decodes one machine-readable provider payload into ordered top-level records.
 *
 * Provider records are leaves: their nested message/tool/capsule data is never
 * reinterpreted as another provider event. Untyped wrapper objects are unwrapped
 * only through known envelope keys, with strict depth and record-count bounds.
 */
export function decodeProviderEnvelope(payload: unknown): ProviderRecord[] {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      return []
    }
  }

  const records: ProviderRecord[] = []
  const visited = new WeakSet<object>()

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_ENVELOPE_DEPTH || records.length >= MAX_PROVIDER_RECORDS) return
    if (Array.isArray(value)) {
      if (visited.has(value)) return
      visited.add(value)
      for (const item of value) visit(item, depth + 1)
      return
    }

    const record = recordOf(value)
    if (!record || visited.has(record)) return
    visited.add(record)

    if (typeof record.type === 'string') {
      records.push(record)
      return
    }

    const children = ENVELOPE_KEYS
      .map((key) => record[key])
      .filter((child) => Array.isArray(child) || recordOf(child) !== undefined)
    if (children.length === 0) {
      records.push(record)
      return
    }
    for (const child of children) visit(child, depth + 1)
  }

  visit(parsed, 0)
  return records
}
