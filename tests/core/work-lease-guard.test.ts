import { describe, expect, it } from 'vitest'
import { ClaudeWorkLeaseGuard } from '../../src/main/orchestrator/work-lease-guard'

function assistant(id: string, content: unknown[] = []): Record<string, unknown> {
  return { type: 'assistant', message: { id, content } }
}

describe('Claude internal work lease guard', () => {
  it('waits for a completed durable write boundary before requesting a timebox', () => {
    const guard = new ClaudeWorkLeaseGuard(3)
    expect(guard.observe([assistant('m1')]).shouldTimebox).toBe(false)
    expect(guard.observe([assistant('m2')]).shouldTimebox).toBe(false)
    expect(guard.observe([assistant('m3', [{ type: 'tool_use', id: 'write-1', name: 'Write' }])]).shouldTimebox).toBe(false)
    const boundary = guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1' }] } }])
    expect(boundary).toMatchObject({ shouldTimebox: true, inferenceSteps: 3, durableToolBoundary: true })
  })

  it('deduplicates repeated stream records for the same assistant message', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('same')])
    guard.observe([assistant('same')])
    expect(guard.snapshot().inferenceSteps).toBe(1)
  })

  it('deduplicates replayed anonymous assistant envelopes instead of burning the lease on stream framing', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    const replayed = { type: 'assistant', message: { content: [{ type: 'text', text: 'Inspecting the owned task.' }] } }
    guard.observe([replayed])
    guard.observe([replayed])
    expect(guard.snapshot().inferenceSteps).toBe(1)
  })

  it('eventually stops a reasoning loop even when it never writes source', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1')])
    guard.observe([assistant('m2')])
    const result = guard.observe([assistant('m3')])
    expect(result).toMatchObject({ shouldTimebox: true, durableToolBoundary: false })
  })

  it('does not timebox while a newer durable edit is still pending', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1', [{ type: 'tool_use', id: 'write-1', name: 'Write' }])])
    guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1' }] } }])

    const pending = guard.observe([assistant('m2', [{ type: 'tool_use', id: 'write-2', name: 'Edit' }])])
    expect(pending).toMatchObject({ shouldTimebox: false, durableToolBoundary: false })

    const completed = guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-2' }] } }])
    expect(completed).toMatchObject({ shouldTimebox: true, durableToolBoundary: true })
  })

  it.each(['Bash', 'Skill', 'mcp__browser__inspect'])('never timeboxes an in-flight %s tool', (name) => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1')])
    const pending = guard.observe([assistant('m2', [{ type: 'tool_use', id: `tool-${name}`, name }])])
    expect(pending.shouldTimebox).toBe(false)
    expect(guard.observe([assistant('m3')]).shouldTimebox).toBe(false)

    const completed = guard.observe([{
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `tool-${name}` }] }
    }])
    expect(completed.shouldTimebox).toBe(true)
    expect(completed.durableToolBoundary).toBe(false)
  })

  it('continues counting from a persisted inference receipt after restart', () => {
    const guard = new ClaudeWorkLeaseGuard(3, { initialInferenceSteps: 2 })
    expect(guard.snapshot().inferenceSteps).toBe(2)
    expect(guard.observe([assistant('m3')]).shouldTimebox).toBe(false)
    expect(guard.observe([assistant('m4')])).toMatchObject({
      inferenceSteps: 4,
      shouldTimebox: true
    })
  })
})
