import { describe, expect, it } from 'vitest'
import {
  buildAgentCommand,
  type BuildAgentCommandInput
} from '../../src/main/process/command-builder'

const dialogueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['opening', 'counter', 'verdict', 'opinion', 'tasks'],
  properties: {
    opening: { type: 'object' },
    counter: { type: 'object' },
    verdict: { type: 'object' },
    opinion: { type: 'object' },
    tasks: { type: 'array' }
  }
} as const

const dialoguePolicy = {
  kind: 'structured-dialogue',
  outputSchema: dialogueSchema,
  outputSchemaPath: 'C:\\duo-run\\.duo\\contracts\\dialogue-capsule.schema.json',
  toolPolicy: 'none'
} as const

const recoveryPolicy = {
  kind: 'structured-recovery',
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['dispatch', 'opinion', 'redactions'],
    properties: {
      dispatch: { type: 'object' },
      opinion: { type: 'null' },
      redactions: { type: 'array' }
    }
  },
  outputSchemaPath: 'C:\\duo-run\\.duo\\contracts\\recovery-capsule.schema.json',
  toolPolicy: 'none'
} as const

function input(agent: 'claude' | 'codex'): BuildAgentCommandInput {
  return {
    agent,
    binary: agent,
    model: agent === 'claude' ? 'sonnet' : 'gpt-5.6-terra',
    effort: 'low',
    extraArgs: [],
    executionMode: 'chaos',
    workspacePath: 'C:\\duo-run',
    prompt: 'Answer the teammate with one bounded product exchange.',
    dangerousModeConfirmed: false,
    dialoguePolicy
  } as unknown as BuildAgentCommandInput
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('structured tool-free dialogue command policy', () => {
  it('runs Claude as one schema-constrained response with every tool disabled and no persistent session', () => {
    const command = buildAgentCommand(input('claude'))

    expect(valueAfter(command.args, '--output-format')).toBe('json')
    expect(valueAfter(command.args, '--tools')).toBe('')
    expect(valueAfter(command.args, '--json-schema')).toBe(JSON.stringify(dialogueSchema))
    expect(command.args).toContain('--no-session-persistence')
    expect(command.args).toContain('--exclude-dynamic-system-prompt-sections')
    expect(valueAfter(command.args, '--prompt-suggestions')).toBe('false')
    expect(command.args).not.toContain('--session-id')
    expect(command.args).not.toContain('--resume')
    expect(command.stdin).toContain('Return exactly one dialogue capsule')
    expect(command.stdin).toContain('Do not inspect, edit, or run workspace tools')
  })

  it('runs Codex with an output schema, read-only sandbox, ephemeral context, and an explicit no-workspace contract', () => {
    const command = buildAgentCommand(input('codex'))

    expect(valueAfter(command.args, '--sandbox')).toBe('read-only')
    expect(valueAfter(command.args, '--output-schema')).toBe(dialoguePolicy.outputSchemaPath)
    expect(command.args).toContain('--ephemeral')
    expect(command.args).toContain('--ignore-user-config')
    expect(command.args).toContain('--ignore-rules')
    expect(command.args.some((value, index) => value === '--disable' && command.args[index + 1] === 'shell_tool')).toBe(true)
    expect(command.args.indexOf('--ignore-user-config')).toBeGreaterThan(command.args.indexOf('exec'))
    expect(command.args.indexOf('--ignore-rules')).toBeGreaterThan(command.args.indexOf('exec'))
    expect(command.args).not.toContain('resume')
    expect(command.args.at(-1)).toBe('-')
    expect(command.stdin).toContain('Return exactly one dialogue capsule')
    expect(command.stdin).toContain('Do not inspect, edit, or run workspace tools')
  })

  it('drops custom arguments that could re-enable tools, writes, or stream-only output during dialogue', () => {
    const claudeInput = input('claude')
    claudeInput.extraArgs = ['--include-partial-messages', '--tools', 'default']
    const codexInput = input('codex')
    codexInput.extraArgs = ['--sandbox', 'workspace-write']

    const claude = buildAgentCommand(claudeInput)
    const codex = buildAgentCommand(codexInput)

    expect(claude.args).not.toContain('--include-partial-messages')
    expect(claude.args).not.toContain('default')
    expect(valueAfter(claude.args, '--tools')).toBe('')
    expect(codex.args).not.toContain('workspace-write')
    expect(valueAfter(codex.args, '--sandbox')).toBe('read-only')
  })

  it.each(['claude', 'codex'] as const)('uses the same ephemeral no-tool boundary for %s staged recovery', (agent) => {
    const recoveryInput = input(agent)
    recoveryInput.dialoguePolicy = recoveryPolicy
    const command = buildAgentCommand(recoveryInput)

    expect(command.args).not.toContain('--resume')
    expect(command.args).not.toContain('workspace-write')
    if (agent === 'claude') {
      expect(valueAfter(command.args, '--tools')).toBe('')
      expect(command.args).toContain('--no-session-persistence')
      expect(command.stdin).toContain('Return exactly one recovery capsule')
    } else {
      expect(valueAfter(command.args, '--sandbox')).toBe('read-only')
      expect(command.args.some((value, index) => value === '--disable' && command.args[index + 1] === 'shell_tool')).toBe(true)
      expect(command.args).toContain('--ephemeral')
      expect(command.args.at(-1)).toBe('-')
      expect(command.stdin).toContain('Return exactly one recovery capsule')
    }
  })
})
