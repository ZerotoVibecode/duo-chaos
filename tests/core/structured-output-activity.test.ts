import { describe, expect, it } from 'vitest'
import { containsStructuredWorkspaceActivity } from '../../src/main/orchestrator/structured-output-activity'

const schema = {
  type: 'object',
  properties: {
    opening: { type: 'object' },
    counter: { type: 'object' },
    verdict: { type: 'object' },
    opinion: { type: 'object' },
    tasks: { type: 'array' }
  }
}

describe('structured output activity boundary', () => {
  it('does not mistake provider schema assembly for workspace tool activity', () => {
    expect(containsStructuredWorkspaceActivity([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'counter' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'verdict' }] } }
    ], schema)).toBe(false)
  })

  it.each(['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'mcp__browser__open']) (
    'detects a real %s tool request during a tool-free structured turn',
    (name) => {
      expect(containsStructuredWorkspaceActivity([
        { type: 'assistant', message: { content: [{ type: 'tool_use', name }] } }
      ], schema)).toBe(true)
    }
  )

  it('detects Codex command and file-change records', () => {
    expect(containsStructuredWorkspaceActivity([
      { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }
    ], schema)).toBe(true)
    expect(containsStructuredWorkspaceActivity([
      { type: 'item.completed', item: { type: 'file_change', changes: [] } }
    ], schema)).toBe(true)
  })
})
