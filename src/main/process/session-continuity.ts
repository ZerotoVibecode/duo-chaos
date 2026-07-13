import { decodeProviderEnvelope } from './provider-envelope'

export type ContinuityAgent = 'claude' | 'codex'

const EXACT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function exactSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && EXACT_SESSION_ID.test(value) ? value : undefined
}

/** Extracts only provider-authored, exact session IDs from machine-readable CLI signals. */
export function extractAgentSessionId(agent: ContinuityAgent, line: string): string | undefined {
  for (const input of decodeProviderEnvelope(line)) {
    if (agent === 'codex') {
      const id = input.type === 'thread.started' ? exactSessionId(input.thread_id) : undefined
      if (id) return id
      continue
    }
    const id = input.type === 'system' && input.subtype === 'init'
      ? exactSessionId(input.session_id)
      : undefined
    if (id) return id
  }
  return undefined
}
