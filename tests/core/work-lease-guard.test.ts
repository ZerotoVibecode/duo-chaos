import { describe, expect, it } from 'vitest'
import { ClaudeWorkLeaseGuard, WorkLeaseGuard } from '../../src/main/orchestrator/work-lease-guard'

function assistant(id: string, content: unknown[] = []): Record<string, unknown> {
  return { type: 'assistant', message: { id, content } }
}

describe('Claude internal work lease guard', () => {
  it('requests graceful finalization after the soft boundary without cancelling productive work', () => {
    const guard = new ClaudeWorkLeaseGuard(3)
    expect(guard.observe([assistant('m1')]).recommendation).toBe('continue')
    expect(guard.observe([assistant('m2')]).recommendation).toBe('continue')
    expect(guard.observe([assistant('m3', [{ type: 'tool_use', id: 'write-1', name: 'Write' }])]).recommendation).toBe('continue')
    const boundary = guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1' }] } }])
    expect(boundary).toMatchObject({
      shouldTimebox: false,
      recommendation: 'request-finalization',
      state: 'finalizing',
      inferenceSteps: 3,
      idleInferenceSteps: 0,
      progressBoundaries: 1,
      durableToolBoundary: true
    })
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

  it('eventually stops a genuine reasoning loop that never uses a tool or records progress', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1')])
    guard.observe([assistant('m2')])
    const result = guard.observe([assistant('m3')])
    expect(result).toMatchObject({
      shouldTimebox: true,
      recommendation: 'cancel-idle',
      state: 'idle',
      idleInferenceSteps: 3,
      durableToolBoundary: false
    })
  })

  it('does not timebox while a newer durable edit is still pending', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1', [{ type: 'tool_use', id: 'write-1', name: 'Write' }])])
    guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1' }] } }])

    const pending = guard.observe([assistant('m2', [{ type: 'tool_use', id: 'write-2', name: 'Edit' }])])
    expect(pending).toMatchObject({ shouldTimebox: false, durableToolBoundary: false })

    const completed = guard.observe([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-2' }] } }])
    expect(completed).toMatchObject({
      shouldTimebox: false,
      recommendation: 'request-finalization',
      durableToolBoundary: true,
      progressBoundaries: 2
    })
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
    expect(completed.shouldTimebox).toBe(false)
    expect(completed.recommendation).toBe('continue')
    expect(completed.idleInferenceSteps).toBe(0)
    expect(completed.durableToolBoundary).toBe(false)
  })

  it('continues counting from a persisted inference receipt after restart', () => {
    const guard = new ClaudeWorkLeaseGuard(3, { initialInferenceSteps: 2 })
    expect(guard.snapshot().inferenceSteps).toBe(2)
    expect(guard.observe([assistant('m3')]).shouldTimebox).toBe(false)
    expect(guard.observe([assistant('m4')])).toMatchObject({
      inferenceSteps: 4,
      idleInferenceSteps: 2,
      shouldTimebox: false,
      recommendation: 'continue'
    })
  })

  it('keeps productive sessions alive no matter how many total inference messages they use', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    for (let index = 1; index <= 12; index += 1) {
      const toolId = `edit-${index}`
      expect(guard.observe([assistant(`m${index}`, [{ type: 'tool_use', id: toolId, name: 'Edit' }])]).shouldTimebox).toBe(false)
      expect(guard.observe([{
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolId }] }
      }]).shouldTimebox).toBe(false)
    }
    expect(guard.snapshot()).toMatchObject({
      inferenceSteps: 12,
      idleInferenceSteps: 0,
      progressBoundaries: 12,
      recommendation: 'request-finalization',
      shouldTimebox: false
    })
  })

  it('recognizes provider completion as the authoritative end of work', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1')])
    expect(guard.observe([{ type: 'result', subtype: 'success' }])).toMatchObject({
      state: 'complete',
      recommendation: 'accept-complete',
      completionObserved: true,
      shouldTimebox: false
    })
  })

  it('does not mistake failed tool calls for productive progress', () => {
    const guard = new ClaudeWorkLeaseGuard(2)
    guard.observe([assistant('m1', [{ type: 'tool_use', id: 'bad-edit', name: 'Edit' }])])
    guard.observe([{
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bad-edit', is_error: true }] }
    }])
    const stalled = guard.observe([assistant('m2'), assistant('m3')])
    expect(stalled).toMatchObject({
      recommendation: 'cancel-idle',
      progressBoundaries: 0,
      durableToolBoundary: false
    })
  })
})

describe('provider-neutral work lease guard', () => {
  it('keeps productive Codex tool work alive beyond the idle boundary', () => {
    const guard = new WorkLeaseGuard(2, { agent: 'codex' })
    for (let index = 1; index <= 6; index += 1) {
      const id = `command-${String(index)}`
      expect(guard.observe([{
        type: 'item.started',
        item: { id, type: 'command_execution', command: 'npm test' }
      }]).shouldTimebox).toBe(false)
      expect(guard.observe([{
        type: 'item.completed',
        item: { id, type: 'command_execution', command: 'npm test', exit_code: 0 }
      }]).shouldTimebox).toBe(false)
    }

    expect(guard.snapshot()).toMatchObject({
      progressBoundaries: 6,
      idleInferenceSteps: 0,
      shouldTimebox: false
    })
  })

  it('recognizes Codex terminal completion without requiring Claude envelopes', () => {
    const guard = new WorkLeaseGuard(2, { agent: 'codex' })
    expect(guard.observe([{ type: 'turn.completed', usage: { input_tokens: 10 } }])).toMatchObject({
      recommendation: 'accept-complete',
      state: 'complete',
      shouldTimebox: false
    })
  })
})
