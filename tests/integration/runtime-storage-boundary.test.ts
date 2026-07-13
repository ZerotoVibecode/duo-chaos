import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanRecentBuilds } from '../../src/main/history/run-history'
import { RunOrchestrator, type ProcessRunnerPort } from '../../src/main/orchestrator/run-orchestrator'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'
import { createRunWorkspace } from '../../src/main/workspace/workspace-manager'
import type { RecentBuildSummary } from '../../src/shared/types'

type RuntimeAwareWorkspaceInput = Parameters<typeof createRunWorkspace>[0] & {
  runtimeRoot: string
}

interface RecentBuildScanOptions {
  runtimeRoot: string
}

type RuntimeAwareRecentBuildScanner = (
  workspaceRoot: string,
  limit?: number,
  options?: RecentBuildScanOptions
) => Promise<RecentBuildSummary[]>

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function externalRuntimePath(runtimeRoot: string, runId: string): string {
  return resolve(runtimeRoot, runId)
}

class CapturingFailureRunner implements ProcessRunnerPort {
  readonly calls: ProcessRunOptions[] = []

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls.push(options)
    options.onLine('stdout', '{"type":"message","message":"private provider output"}')
    const now = new Date().toISOString()
    return Promise.resolve({
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      startedAt: now,
      finishedAt: now
    })
  }

  async cancelAll(): Promise<void> {}
}

describe('agent-invisible runtime storage boundary', () => {
  it.runIf(process.platform === 'win32')('rejects a differently cased runtime path nested inside the generated workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-runtime-case-boundary-'))
    const workspaceRoot = join(root, 'Generated-Workspaces')
    const runId = 'duo-run-case-isolation'
    await expect(createRunWorkspace({
      root: workspaceRoot,
      runtimeRoot: join(workspaceRoot.toUpperCase(), runId.toUpperCase(), 'runtime'),
      runId,
      prompt: 'Keep runtime storage outside this workspace.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })).rejects.toThrow(/outside|runtime|workspace/i)
  })

  it('creates telemetry outside the generated workspace while retaining only compact coordination files inside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-runtime-boundary-'))
    const workspaceRoot = join(root, 'generated-workspaces')
    const runtimeRoot = join(root, 'studio-runtime')
    const runId = 'duo-run-runtime-isolation'
    const input: RuntimeAwareWorkspaceInput = {
      root: workspaceRoot,
      runtimeRoot,
      runId,
      prompt: 'Build a private surprise without exposing supervisor telemetry.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    }

    const workspace = await createRunWorkspace(input)
    const runtimePath = externalRuntimePath(runtimeRoot, runId)
    const duoPath = join(workspace.workspacePath, '.duo')

    expect.soft(workspace.runtimePath).toBe(runtimePath)
    expect.soft(isAbsolute(runtimePath)).toBe(true)
    expect.soft(relative(workspace.workspacePath, runtimePath).startsWith('..')).toBe(true)

    for (const externalFile of [
      'run.json',
      'public/timeline.jsonl',
      'private/transcript.jsonl',
      'private/raw/claude.jsonl',
      'private/raw/codex.jsonl',
      'prompts'
    ]) {
      expect.soft(await exists(join(runtimePath, externalFile)), `${externalFile} should live in the external runtime record`).toBe(true)
    }

    for (const forbiddenWorkspaceTelemetry of [
      'run.json',
      'public/timeline.jsonl',
      'private/transcript.jsonl',
      'private/raw',
      'prompts'
    ]) {
      expect.soft(
        await exists(join(duoPath, forbiddenWorkspaceTelemetry)),
        `${forbiddenWorkspaceTelemetry} must stay outside the agent-visible workspace`
      ).toBe(false)
    }

    for (const compactWorkspaceProtocol of [
      'board.json',
      'claims.json',
      'locks.json',
      'public/dispatches.jsonl',
      'public/opinions.jsonl',
      'public/conflicts.jsonl',
      'private/dispatches.jsonl',
      'private/opinions.jsonl',
      'sealed'
    ]) {
      expect.soft(
        await exists(join(duoPath, compactWorkspaceProtocol)),
        `${compactWorkspaceProtocol} should remain available to the two-agent protocol`
      ).toBe(true)
    }
  })

  it('routes live CLI streams, supervisor events, and current prompts through the external runtime record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-runtime-routing-'))
    const workspaceRoot = join(root, 'generated-workspaces')
    const runtimeRoot = join(root, 'studio-runtime')
    const runner = new CapturingFailureRunner()
    const settings = {
      ...defaultSettings(workspaceRoot),
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'low' as const,
      claudeModel: 'fable',
      claudeEffort: 'low' as const,
      saveRawLogs: true
    }
    const options = {
      runtimeRoot,
      getSettings: () => Promise.resolve(settings),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: () => Promise.resolve([
        { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
        { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
        { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
      ])
    }
    const orchestrator = new RunOrchestrator(options)

    const started = await orchestrator.start({
      prompt: 'Build a compact hidden app and keep supervisor telemetry out of the generated repo.',
      workspaceRoot,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 30,
      runTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    const runtimePath = externalRuntimePath(runtimeRoot, started.runId)
    expect.soft(runner.calls.length).toBeGreaterThan(0)
    for (const call of runner.calls) {
      expect.soft(resolve(call.stdoutPath).startsWith(`${runtimePath}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
      expect.soft(resolve(call.stderrPath).startsWith(`${runtimePath}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
      expect.soft(call.command.cwd).toBe(started.workspacePath)
    }

    await expect.soft(readFile(join(runtimePath, 'public', 'timeline.jsonl'), 'utf8')).resolves.toMatch(/run\.started|agent\.started/)
    await expect.soft(readFile(join(runtimePath, 'private', 'transcript.jsonl'), 'utf8')).resolves.toContain('private provider output')
    const firstActiveAgent = runner.calls[0]?.id.includes('claude') ? 'claude' : 'codex'
    expect.soft(await exists(join(runtimePath, 'prompts', `current_${firstActiveAgent}_prompt.md`))).toBe(true)
    expect.soft(await exists(join(started.workspacePath, '.duo', 'public', 'timeline.jsonl'))).toBe(false)
    expect.soft(await exists(join(started.workspacePath, '.duo', 'private', 'transcript.jsonl'))).toBe(false)
    expect.soft(await exists(join(started.workspacePath, '.duo', 'prompts'))).toBe(false)
  })

  it('rebuilds recent-run history from an external runtime record plus explicit workspace paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-runtime-history-'))
    const workspaceRoot = join(root, 'generated-workspaces')
    const runtimeRoot = join(root, 'studio-runtime')
    const runId = 'duo-run-external-history'
    const workspacePath = join(workspaceRoot, runId)
    const runtimePath = join(runtimeRoot, runId)
    const duoPath = join(workspacePath, '.duo')
    await Promise.all([
      mkdir(join(runtimePath, 'public'), { recursive: true }),
      mkdir(join(duoPath, 'sealed'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(runtimePath, 'run.json'), `${JSON.stringify({
        runId,
        createdAt: '2026-07-11T09:00:00.000Z',
        updatedAt: '2026-07-11T09:30:00.000Z',
        status: 'complete',
        phase: 'complete',
        prompt: 'Build a restart-safe hidden app.',
        executionMode: 'chaos',
        visibilityMode: 'spoiler-shield',
        workspacePath,
        appPath: join(workspacePath, 'app')
      }, null, 2)}\n`, 'utf8'),
      writeFile(join(runtimePath, 'public', 'timeline.jsonl'), [
        JSON.stringify({ type: 'agent.started', agent: 'claude' }),
        JSON.stringify({ type: 'agent.dispatch', agent: 'claude' }),
        JSON.stringify({ type: 'agent.activity', agent: 'codex', category: 'file' }),
        JSON.stringify({ type: 'git.checkpoint', agent: 'director' }),
        JSON.stringify({ type: 'build.passed', agent: 'codex' })
      ].join('\n') + '\n', 'utf8'),
      writeFile(join(duoPath, 'board.json'), '{"tasks":[{"id":"ship","status":"done","claimedBy":"claude"}]}\n', 'utf8'),
      writeFile(join(duoPath, 'sealed', 'reveal_packet.json'), '{"appName":"External Record App"}\n', 'utf8')
    ])

    const runtimeAwareScan: RuntimeAwareRecentBuildScanner = scanRecentBuilds
    const recent = await runtimeAwareScan(workspaceRoot, 8, { runtimeRoot })

    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({
      runId,
      workspacePath,
      appName: 'External Record App',
      status: 'complete',
      sealed: false,
      proof: {
        tasksDone: 1,
        tasksTotal: 1,
        checkpoints: 1,
        buildPasses: 1,
        claude: { turns: 1, messages: 1, tasksDone: 1 },
        codex: { edits: 1 }
      }
    })

    const changedDefaultRoot = join(root, 'different-default-workspace-root')
    await mkdir(changedDefaultRoot, { recursive: true })
    const afterDefaultChanged = await runtimeAwareScan(changedDefaultRoot, 8, { runtimeRoot })
    expect(afterDefaultChanged[0]).toMatchObject({ runId, workspacePath })
  })
})
