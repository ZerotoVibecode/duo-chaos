import { describe, expect, it } from 'vitest'
import { CommandBuildError, buildAgentCommand } from '../../src/main/process/command-builder'

describe('CLI command builder', () => {
  it('allows Codex to run inside supervisor-owned workspaces without embedded Git metadata', () => {
    const command = buildAgentCommand({
      agent: 'codex',
      executionMode: 'chaos',
      binary: 'codex',
      workspacePath: 'C:\\DuoChaos\\workspaces\\external-git-metadata',
      prompt: 'Open the next turn.',
      dangerousModeConfirmed: false,
      model: 'gpt-5.6-terra',
      effort: 'low',
      extraArgs: []
    })

    const execIndex = command.args.indexOf('exec')
    expect(command.args[execIndex + 1]).toBe('--skip-git-repo-check')
  })

  it('places Codex approval flags before the exec subcommand', () => {
    const command = buildAgentCommand({
      agent: 'codex',
      executionMode: 'chaos',
      binary: 'codex',
      workspacePath: 'C:\\Work spaces\\duo-run',
      prompt: 'Build the next claimed task.',
      dangerousModeConfirmed: false,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      extraArgs: []
    })

    expect(command.bin).toBe('codex')
    expect(command.args).toEqual([
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
      '--disable',
      'plugins',
      '--disable',
      'apps',
      '--disable',
      'multi_agent',
      '--disable',
      'hooks',
      '-c',
      'skills.include_instructions=false',
      '-c',
      'mcp_servers={}',
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="ultra"',
      '--cd',
      'C:\\Work spaces\\duo-run',
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--ephemeral',
      '-'
    ])
    expect(command.stdin).toBe('Build the next claimed task.')
  })

  it('builds Claude stream-json arguments without shell concatenation', () => {
    const command = buildAgentCommand({
      agent: 'claude',
      executionMode: 'safe',
      binary: 'claude',
      workspacePath: '/tmp/duo run',
      prompt: 'Review the current turn.',
      dangerousModeConfirmed: false,
      model: 'opus',
      effort: 'high',
      extraArgs: ['--include-partial-messages']
    })

    expect(command).toEqual({
      bin: 'claude',
      args: [
        '--print',
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--safe-mode',
        '--disable-slash-commands',
        '--exclude-dynamic-system-prompt-sections',
        '--prompt-suggestions',
        'false',
        '--permission-mode',
        'acceptEdits',
        '--no-session-persistence',
        '--model',
        'opus',
        '--effort',
        'high'
      ],
      cwd: '/tmp/duo run',
      stdin: 'Review the current turn.'
    })
    expect(command.args).not.toContain('Review the current turn.')
    expect(command.args).not.toContain('--include-partial-messages')
  })

  it('runs deep Claude contributions with only workspace-essential tools in a fresh lean session', () => {
    const command = buildAgentCommand({
      agent: 'claude',
      executionMode: 'chaos',
      binary: 'claude',
      workspacePath: 'C:\\DuoChaos\\workspaces\\lean-source',
      prompt: 'Make one cohesive contribution and finish with a handoff.',
      dangerousModeConfirmed: false,
      model: 'fable',
      effort: 'max',
      extraArgs: [],
      // A stale persisted caller may still carry the removed `bare` field.
      // Source contributions must ignore it because `--bare` disables OAuth
      // and keychain reads in Claude Code.
      sourcePolicy: { toolPolicy: 'workspace-essential', bare: true }
    } as never)

    expect(command.args).toEqual(expect.arrayContaining([
      '--safe-mode',
      '--tools',
      'Read,Glob,Grep,Edit,Write,Bash',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Glob,Grep,Edit,Write,Bash(node --check *),Bash(node.exe --check *),Bash(node --test *),Bash(node.exe --test *),Bash(npm install --ignore-scripts *),Bash(npm.cmd install --ignore-scripts *),Bash(npm ci --ignore-scripts *),Bash(npm.cmd ci --ignore-scripts *),Bash(npm run *),Bash(npm.cmd run *),Bash(npm test *),Bash(npm.cmd test *)',
      '--no-session-persistence'
    ]))
    expect(command.args).not.toContain('auto')
    expect(command.args).not.toContain('--dangerously-skip-permissions')
    expect(command.args).not.toContain('--bare')
    expect(command.args).not.toContain('--resume')
  })

  it('enables the user-level Claude toolbelt only for an explicit smart source stage', () => {
    const command = buildAgentCommand({
      agent: 'claude', executionMode: 'chaos', binary: 'claude', workspacePath: '/tmp/run',
      prompt: 'Use relevant local capabilities on demand.', dangerousModeConfirmed: false,
      model: 'fable', effort: 'high', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'smart' }
    })

    expect(command.args).toEqual(expect.arrayContaining(['--setting-sources', 'user']))
    expect(command.args).toEqual(expect.arrayContaining([
      '--settings', '{"disableAllHooks":true,"includeGitInstructions":false}'
    ]))
    expect(command.args).not.toContain('--safe-mode')
    expect(command.args).toContain('--disable-slash-commands')
    expect(command.args).not.toContain('Read,Glob,Grep,Edit,Write,Bash')
    expect(command.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'acceptEdits',
      '--allowedTools',
      'Read,Glob,Grep,Edit,Write,Bash(node --check *),Bash(node.exe --check *),Bash(node --test *),Bash(node.exe --test *),Bash(npm install --ignore-scripts *),Bash(npm.cmd install --ignore-scripts *),Bash(npm ci --ignore-scripts *),Bash(npm.cmd ci --ignore-scripts *),Bash(npm run *),Bash(npm.cmd run *),Bash(npm test *),Bash(npm.cmd test *),mcp__*'
    ]))
    expect(command.args).not.toContain('auto')
    expect(command.args).not.toContain('--dangerously-skip-permissions')
    expect(command.args).toEqual(expect.arrayContaining(['--disallowedTools', 'Agent,Task']))
  })

  it('never trusts generated-workspace settings, hooks, or subagent fan-out in full-local source stages', () => {
    const claude = buildAgentCommand({
      agent: 'claude', executionMode: 'chaos', binary: 'claude', workspacePath: '/tmp/generated-run',
      prompt: 'Use relevant local capabilities on demand.', dangerousModeConfirmed: false,
      model: 'fable', effort: 'high', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'full-local' }
    })
    const codex = buildAgentCommand({
      agent: 'codex', executionMode: 'chaos', binary: 'codex', workspacePath: '/tmp/generated-run',
      prompt: 'Use relevant local capabilities on demand.', dangerousModeConfirmed: false,
      model: 'gpt-5.6-terra', effort: 'low', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'full-local' }
    })

    expect(claude.args).toEqual(expect.arrayContaining([
      '--setting-sources', 'user', '--settings',
      '{"disableAllHooks":true,"includeGitInstructions":false}',
      '--disallowedTools', 'Agent,Task'
    ]))
    expect(claude.args).not.toContain('user,project,local')
    expect(claude.args).not.toContain('--disable-slash-commands')
    expect(claude.args).toEqual(expect.arrayContaining([
      '--permission-mode', 'acceptEdits',
      '--allowedTools',
      'Read,Glob,Grep,Edit,Write,Bash(node --check *),Bash(node.exe --check *),Bash(node --test *),Bash(node.exe --test *),Bash(npm install --ignore-scripts *),Bash(npm.cmd install --ignore-scripts *),Bash(npm ci --ignore-scripts *),Bash(npm.cmd ci --ignore-scripts *),Bash(npm run *),Bash(npm.cmd run *),Bash(npm test *),Bash(npm.cmd test *),mcp__*'
    ]))
    expect(claude.args).not.toContain('auto')
    expect(claude.args).not.toContain('--dangerously-skip-permissions')
    expect(codex.args).toEqual(expect.arrayContaining([
      '--disable', 'multi_agent', '--disable', 'hooks'
    ]))
    expect(codex.args).not.toContain('skills.include_instructions=false')
  })

  it('enables Codex MCPs, apps, and plugins while suppressing skills, hidden subagents, and hooks in smart source stages', () => {
    const command = buildAgentCommand({
      agent: 'codex', executionMode: 'chaos', binary: 'codex', workspacePath: '/tmp/run',
      prompt: 'Use relevant local capabilities on demand.', dangerousModeConfirmed: false,
      model: 'gpt-5.6-terra', effort: 'low', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'smart' }
    })

    expect(command.args).toEqual(expect.arrayContaining(['--disable', 'multi_agent', '--disable', 'hooks']))
    expect(command.args).toContain('skills.include_instructions=false')
    expect(command.args).not.toContain('mcp_servers={}')
    expect(command.args).not.toEqual(expect.arrayContaining(['--disable', 'plugins']))
    expect(command.args).not.toEqual(expect.arrayContaining(['--disable', 'apps']))
  })

  it('keeps structured dialogue locked even when a stale caller asks for local capabilities', () => {
    const command = buildAgentCommand({
      agent: 'claude', executionMode: 'chaos', binary: 'claude', workspacePath: '/tmp/run',
      prompt: 'Debate only.', dangerousModeConfirmed: false, extraArgs: [],
      dialoguePolicy: {
        kind: 'structured-dialogue', outputSchema: { type: 'object' },
        outputSchemaPath: '/tmp/schema.json', toolPolicy: 'none'
      },
      sourcePolicy: undefined
    })

    expect(command.args).toContain('--safe-mode')
    expect(command.args).toContain('--disable-slash-commands')
    expect(command.args).toEqual(expect.arrayContaining(['--tools', '']))
    expect(command.args).not.toContain('--allowedTools')
  })

  it('rejects Smart or Broad source toolbelts in unattended Safe execution', () => {
    expect(() => buildAgentCommand({
      agent: 'claude', executionMode: 'safe', binary: 'claude', workspacePath: '/tmp/run',
      prompt: 'Use an MCP.', dangerousModeConfirmed: false, extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'smart' }
    })).toThrow(/safe.*core|core.*safe/i)
  })

  it('keeps Safe Claude source work shell-free while still allowing supervised file edits', () => {
    const command = buildAgentCommand({
      agent: 'claude', executionMode: 'safe', binary: 'claude', workspacePath: '/tmp/safe-run',
      prompt: 'Implement the owned source task without running commands.', dangerousModeConfirmed: false,
      model: 'sonnet', effort: 'low', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'core' }
    })

    expect(command.args).toEqual(expect.arrayContaining([
      '--tools', 'Read,Glob,Grep,Edit,Write',
      '--allowedTools', 'Read,Glob,Grep,Edit,Write'
    ]))
    expect(command.args.join(' ')).not.toMatch(/Bash|mcp__/u)
  })

  it('does not preapprove arbitrary runtimes, package executors, or lifecycle installs', () => {
    const command = buildAgentCommand({
      agent: 'claude', executionMode: 'chaos', binary: 'claude', workspacePath: '/tmp/bounded-run',
      prompt: 'Implement and verify the owned source task.', dangerousModeConfirmed: false,
      model: 'opus', effort: 'high', extraArgs: [],
      sourcePolicy: { toolPolicy: 'workspace-essential', customizationProfile: 'core' }
    })
    const allowed = command.args[command.args.indexOf('--allowedTools') + 1]

    expect(allowed).toContain('Bash(node --test *)')
    expect(allowed).toContain('Bash(npm install --ignore-scripts *)')
    expect(allowed).not.toContain('Bash(node *)')
    expect(allowed).not.toMatch(/npx|pnpm|yarn|bun/iu)
    expect(allowed).not.toContain('Bash(npm *)')
  })

  it('ignores legacy extra arguments that could override the visible loadout or permission mode', () => {
    const codex = buildAgentCommand({
      agent: 'codex', executionMode: 'chaos', binary: 'codex', workspacePath: '/tmp/run',
      prompt: 'Build.', dangerousModeConfirmed: false, model: 'gpt-5.6-sol', effort: 'max',
      extraArgs: ['--model', 'attacker-model', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="low"']
    })
    const claude = buildAgentCommand({
      agent: 'claude', executionMode: 'safe', binary: 'claude', workspacePath: '/tmp/run',
      prompt: 'Build.', dangerousModeConfirmed: false, model: 'fable', effort: 'max',
      extraArgs: ['--model', 'attacker-model', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
    })

    expect(codex.args).toContain('gpt-5.6-sol')
    expect(codex.args).not.toContain('attacker-model')
    expect(codex.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(claude.args).toContain('fable')
    expect(claude.args).not.toContain('attacker-model')
    expect(claude.args).not.toContain('--dangerously-skip-permissions')
  })

  it('starts a persistent Codex session without weakening the workspace sandbox', () => {
    const command = buildAgentCommand({
      agent: 'codex',
      executionMode: 'chaos',
      binary: 'codex',
      workspacePath: 'C:\\DuoChaos\\workspaces\\persistent-codex',
      prompt: 'Open the broadcast turn.',
      dangerousModeConfirmed: false,
      model: 'gpt-5.6-sol',
      effort: 'low',
      extraArgs: [],
      session: { mode: 'start' }
    })

    expect(command.args).toEqual(expect.arrayContaining([
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
      'exec',
      '--json',
      '-'
    ]))
    expect(command.stdin).toBe('Open the broadcast turn.')
    expect(command.args).not.toContain('--ephemeral')
    expect(command.args).not.toContain('resume')
    expect(command.args).not.toContain('--last')
  })

  it('resumes only the exact Codex session requested by the orchestrator', () => {
    const sessionId = '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
    const command = buildAgentCommand({
      agent: 'codex',
      executionMode: 'chaos',
      binary: 'codex',
      workspacePath: 'C:\\DuoChaos\\workspaces\\persistent-codex',
      prompt: 'Continue with the selected-effort work lease.',
      dangerousModeConfirmed: false,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      extraArgs: [],
      session: { mode: 'resume', id: sessionId }
    })

    const execIndex = command.args.indexOf('exec')
    expect(command.args.slice(execIndex)).toEqual([
      'exec',
      '--skip-git-repo-check',
      'resume',
      '--json',
      sessionId,
      '-'
    ])
    expect(command.stdin).toBe('Continue with the selected-effort work lease.')
    expect(command.args).toEqual(expect.arrayContaining([
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write'
    ]))
    expect(command.args).not.toContain('--ephemeral')
    expect(command.args).not.toContain('--last')
  })

  it('starts and resumes Claude with an exact session ID while keeping prompts on stdin', () => {
    const sessionId = 'c3aead27-8052-44db-8284-c588d31552a7'
    const base = {
      agent: 'claude' as const,
      executionMode: 'chaos' as const,
      binary: 'claude',
      workspacePath: 'C:\\DuoChaos\\workspaces\\persistent-claude',
      dangerousModeConfirmed: false,
      model: 'fable',
      extraArgs: []
    }
    const started = buildAgentCommand({
      ...base,
      prompt: 'Open the broadcast turn.',
      effort: 'low',
      session: { mode: 'start', id: sessionId }
    })
    const resumed = buildAgentCommand({
      ...base,
      prompt: 'Continue with the selected-effort work lease.',
      effort: 'max',
      session: { mode: 'resume', id: sessionId }
    })

    expect(started.args).toEqual(expect.arrayContaining(['--session-id', sessionId]))
    expect(started.args).not.toContain('--resume')
    expect(started.args).not.toContain('--no-session-persistence')
    expect(started.stdin).toBe('Open the broadcast turn.')

    expect(resumed.args).toEqual(expect.arrayContaining(['--resume', sessionId]))
    expect(resumed.args).not.toContain('--session-id')
    expect(resumed.args).not.toContain('--continue')
    expect(resumed.args).not.toContain('--no-session-persistence')
    expect(resumed.stdin).toBe('Continue with the selected-effort work lease.')
    expect(resumed.args).not.toContain('Continue with the selected-effort work lease.')
  })

  it('keeps the existing ephemeral commands explicit and non-resumable', () => {
    const codex = buildAgentCommand({
      agent: 'codex', executionMode: 'safe', binary: 'codex', workspacePath: '/tmp/ephemeral',
      prompt: 'One isolated turn.', dangerousModeConfirmed: false, extraArgs: []
    })
    const claude = buildAgentCommand({
      agent: 'claude', executionMode: 'safe', binary: 'claude', workspacePath: '/tmp/ephemeral',
      prompt: 'One isolated turn.', dangerousModeConfirmed: false, extraArgs: []
    })

    expect(codex.args).toContain('--ephemeral')
    expect(codex.args).not.toContain('resume')
    expect(codex.args).not.toContain('--last')
    expect(claude.args).toContain('--no-session-persistence')
    expect(claude.args).not.toContain('--resume')
    expect(claude.args).not.toContain('--continue')
  })

  it.each([
    ['codex', '--last'],
    ['codex', ''],
    ['claude', 'continue'],
    ['claude', '--resume']
  ] as const)('rejects non-exact %s resume identifiers', (agent, id) => {
    expect(() => buildAgentCommand({
      agent,
      executionMode: 'chaos',
      binary: agent,
      workspacePath: '/tmp/exact-session',
      prompt: 'Resume only the named session.',
      dangerousModeConfirmed: false,
      extraArgs: [],
      session: { mode: 'resume', id }
    })).toThrow(/session|identifier|uuid/i)
  })

  it('refuses Codex-only Ultra effort for automated Claude runs', () => {
    expect(() => buildAgentCommand({
      agent: 'claude',
      executionMode: 'chaos',
      binary: 'claude',
      workspacePath: '/tmp/duo',
      prompt: 'Build.',
      dangerousModeConfirmed: false,
      effort: 'ultra',
      extraArgs: []
    } as never)).toThrow(/Claude.*Max|Ultra.*Claude/i)
  })

  it('refuses dangerous flags without an explicit sandbox confirmation', () => {
    expect(() =>
      buildAgentCommand({
        agent: 'codex',
        executionMode: 'yolo-sandbox',
        binary: 'codex',
        workspacePath: '/tmp/run',
        prompt: 'Build.',
        dangerousModeConfirmed: false,
        extraArgs: []
      })
    ).toThrow(CommandBuildError)
  })

  it('builds explicitly confirmed container-only commands for both agents', () => {
    const codex = buildAgentCommand({
      agent: 'codex', executionMode: 'yolo-sandbox', binary: 'codex', workspacePath: '/tmp/run', prompt: 'Build.', dangerousModeConfirmed: true, extraArgs: []
    })
    const claude = buildAgentCommand({
      agent: 'claude', executionMode: 'yolo-sandbox', binary: 'claude', workspacePath: '/tmp/run', prompt: 'Review.', dangerousModeConfirmed: true, extraArgs: []
    })
    expect(codex.args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(claude.args).toContain('--dangerously-skip-permissions')
  })

  it.each([
    [{ binary: '', workspacePath: '/tmp/run', prompt: 'Build.' }, /binary/i],
    [{ binary: 'codex', workspacePath: '', prompt: 'Build.' }, /workspace/i],
    [{ binary: 'codex', workspacePath: '/tmp/run', prompt: ' ' }, /prompt/i]
  ])('rejects incomplete command input', (patch, message) => {
    const base = {
      agent: 'codex' as const,
      executionMode: 'safe' as const,
      binary: 'codex',
      workspacePath: '/tmp/run',
      prompt: 'Build.',
      dangerousModeConfirmed: false,
      extraArgs: []
    }
    expect(() => buildAgentCommand({ ...base, ...patch })).toThrow(message)
  })
})
