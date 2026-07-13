import { describe, expect, it } from 'vitest'
import { extractAgentSessionId } from '../../src/main/process/session-continuity'

describe('agent session continuity', () => {
  it('extracts the exact Codex thread ID only from a thread.started signal', () => {
    const sessionId = '019f4d5a-b93c-7910-9f2d-a607a7f6788d'

    expect(extractAgentSessionId('codex', JSON.stringify({
      type: 'thread.started',
      thread_id: sessionId
    }))).toBe(sessionId)
    expect(extractAgentSessionId('codex', JSON.stringify({
      type: 'turn.started',
      thread_id: '00000000-0000-4000-8000-000000000001'
    }))).toBeUndefined()
  })

  it('extracts the exact Claude session ID only from the init signal', () => {
    const sessionId = 'c3aead27-8052-44db-8284-c588d31552a7'

    expect(extractAgentSessionId('claude', JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId
    }))).toBe(sessionId)
    expect(extractAgentSessionId('claude', JSON.stringify({
      type: 'system',
      subtype: 'thinking_tokens',
      session_id: '00000000-0000-4000-8000-000000000001'
    }))).toBeUndefined()
  })

  it('ignores malformed, cross-provider, and invalid session signals', () => {
    expect(extractAgentSessionId('codex', 'not-json')).toBeUndefined()
    expect(extractAgentSessionId('codex', JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'c3aead27-8052-44db-8284-c588d31552a7'
    }))).toBeUndefined()
    expect(extractAgentSessionId('claude', JSON.stringify({
      type: 'thread.started', thread_id: '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
    }))).toBeUndefined()
    expect(extractAgentSessionId('codex', JSON.stringify({
      type: 'thread.started', thread_id: '--last'
    }))).toBeUndefined()
    expect(extractAgentSessionId('claude', JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'continue'
    }))).toBeUndefined()
  })
})
