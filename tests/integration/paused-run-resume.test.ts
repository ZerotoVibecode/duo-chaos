import { appendFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RunOrchestrator as BaseRunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'

class RunOrchestrator extends BaseRunOrchestrator {
  constructor(options: ConstructorParameters<typeof BaseRunOrchestrator>[0]) {
    super({ ...options, testOnlyMinimumTurns: 2 })
  }
}

function result(exitCode = 0): ProcessRunResult {
  const now = new Date().toISOString()
  return { exitCode, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
}

function agentOf(options: ProcessRunOptions): 'claude' | 'codex' {
  return options.id.includes('claude') ? 'claude' : 'codex'
}

function capsule(): Record<string, unknown> {
  return {
    opening: {
      publicText: 'I think the focused [FEATURE] should lead because its success condition is testable.',
      privateText: 'I think the hidden focused mechanic should lead because its success condition is testable.'
    },
    counter: {
      publicText: 'I agree on focus, but the [FEATURE] also needs an accessible alternate input.',
      privateText: 'I agree on focus, but the hidden mechanic also needs an accessible alternate input.'
    },
    verdict: {
      publicText: 'I would keep the bounded [FEATURE] and prove it with one runnable path.',
      privateText: 'I would keep the bounded hidden mechanic and prove it with one runnable path.'
    },
    opinion: {
      publicText: 'The smaller [FEATURE] is stronger because it can be verified directly.',
      privateText: 'The smaller hidden mechanic is stronger because it can be verified directly.',
      tone: 'confident'
    },
    tasks: [],
    pitches: [
      { title: 'Hidden One', idea: 'A private idea.', appeal: 'Focused.', risk: 'Input.' },
      { title: 'Hidden Two', idea: 'Another private idea.', appeal: 'Tactile.', risk: 'Scope.' }
    ],
    consensus: null,
    redactions: [
      { value: 'Hidden One', label: 'APP_NAME' },
      { value: 'Hidden Two', label: 'APP_NAME' }
    ]
  }
}

class RecoverableContractRunner implements ProcessRunnerPort {
  calls = 0

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls += 1
    if (this.calls > 2) {
      const agent = agentOf(options)
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify([{ type: 'system', subtype: 'init', session_id: 'claude-resume' }, { type: 'result', subtype: 'success', structured_output: capsule() }])
        : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule()) } }))
    }
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class RecoverableQuotaRunner implements ProcessRunnerPort {
  rejectQuota = true
  calls: Array<'claude' | 'codex'> = []

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = agentOf(options)
    this.calls.push(agent)
    if (this.rejectQuota) {
      options.onLine('stdout', JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          resetAt: '2026-07-11T22:00:00.000Z'
        }
      }))
      return Promise.resolve(result(1))
    }
    options.onLine('stdout', agent === 'claude'
      ? JSON.stringify([{ type: 'result', subtype: 'success', structured_output: capsule() }])
      : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule()) } }))
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class PrivateBatonQuotaRunner implements ProcessRunnerPort {
  calls = 0
  resumedPrompt = ''

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls += 1
    if (this.calls === 2) {
      options.onLine('stdout', JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetAt: '2026-07-12T07:00:00.000Z' }
      }))
      return Promise.resolve(result(1))
    }
    if (this.calls >= 3) this.resumedPrompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const agent = agentOf(options)
    options.onLine('stdout', agent === 'claude'
      ? JSON.stringify([{ type: 'result', subtype: 'success', structured_output: capsule() }])
      : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule()) } }))
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class ShutdownRunner implements ProcessRunnerPort {
  calls = 0
  private pending: Array<(value: ProcessRunResult) => void> = []

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls += 1
    await writeFile(join(options.command.cwd, 'app', 'shutdown-preserved.txt'), 'source written before shutdown\n', 'utf8')
    return await new Promise((resolve) => this.pending.push(resolve))
  }

  cancelAll(): Promise<void> {
    for (const resolve of this.pending.splice(0)) {
      resolve({ ...result(), exitCode: null, signal: 'SIGTERM', cancelled: true })
    }
    return Promise.resolve()
  }
}

const healthyAgents = () => Promise.resolve([
  { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
  { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
  { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
])

function request(root: string): Record<string, unknown> {
  return {
    prompt: 'Build a compact surprise without losing completed work.',
    workspaceRoot: root,
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    maxTurns: 2,
    maxRepairLoops: 0,
    turnTimeoutSeconds: 120,
    runTimeoutSeconds: 600,
    dangerousModeConfirmed: false,
    unsafeWorkspaceRootConfirmed: false
  }
}

describe('durable paused-run recovery', () => {
  it('restores a sealed reveal-ready run after restart and reveals it without exposing the workspace early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-reveal-ready-restore-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-reveal-ready-runtime-'))
    const first = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      simulationDelayScale: 0.001
    })
    const started = await first.start({ ...request(root), executionMode: 'simulation' })
    await first.waitForSettled(started.runId)
    expect(first.getSnapshot(started.runId)).toMatchObject({ status: 'reveal-ready' })

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      simulationDelayScale: 0.001
    })
    await expect(restored.restore()).resolves.toBe(1)
    expect(restored.getSnapshot(started.runId)).toMatchObject({
      status: 'reveal-ready',
      phase: 'reveal.ready',
      revealPacket: undefined
    })
    await expect(restored.reveal(started.runId)).resolves.toMatchObject({
      status: 'complete',
      revealPacket: { appName: 'Afterglow Atlas' }
    })
  })

  it('does not restore a serious reveal-ready run whose sealed specification was changed offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-serious-reveal-tamper-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-serious-reveal-tamper-runtime-'))
    const first = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      simulationDelayScale: 0.001
    })
    const started = await first.start({
      ...request(root),
      prompt: 'Build an accessible offline journal with keyboard navigation and export.',
      missionProfile: 'serious',
      executionMode: 'simulation'
    })
    await first.waitForSettled(started.runId)
    expect(first.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    await writeFile(join(started.workspacePath, '.duo', 'sealed', 'spec.md'), '# Replaced offline\n', 'utf8')

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      simulationDelayScale: 0.001
    })
    await expect(restored.restore()).resolves.toBe(0)
    expect(restored.getSnapshot(started.runId)).toBeUndefined()
  })

  it('pauses after malformed protocol recovery and resumes the same workspace instead of failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-pause-contract-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-pause-contract-runtime-'))
    const runner = new RecoverableContractRunner()
    const orchestrator = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)

    const paused = orchestrator.getSnapshot(started.runId)
    expect(paused).toMatchObject({
      status: 'paused',
      phase: 'paused',
      pause: { reason: 'provider-protocol', resumable: true }
    })
    expect(paused?.events.some((event) => event.type === 'run.failed')).toBe(false)

    await writeFile(join(runtimeRoot, started.runId, 'run.json'), '{"workspacePath":', 'utf8')
    await writeFile(join(started.workspacePath, '.duo', 'board.json'), JSON.stringify({
      tasks: [{
        id: 'restored-concrete-task',
        publicTitle: 'Build the hidden Nebula Pantry duel',
        publicDescription: 'Wire the blue pantry button to the seven-click ending.',
        status: 'in-progress',
        claimedBy: 'claude',
        risk: 'medium',
        files: ['app/nebula-pantry.ts']
      }]
    }), 'utf8')

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await restored.restore()
    const restoredSnapshot = restored.getSnapshot(started.runId)
    expect(restoredSnapshot).toMatchObject({
      status: 'paused',
      pause: { reason: 'provider-protocol', resumable: true },
      tasks: [{
        publicTitle: 'Spoiler-sealed shared task',
        publicDescription: 'Task details stay sealed until reveal.',
        files: ['[WORKSPACE_FILE]']
      }]
    })
    expect(JSON.stringify(restoredSnapshot)).not.toMatch(/Nebula|Pantry|blue|seven|click/iu)

    const journalPath = join(runtimeRoot, started.runId, 'run-journal.jsonl')
    const journalLengthBeforeResume = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/u).length
    const resumed = await restored.resume(started.runId)
    expect(resumed.workspacePath).toBe(started.workspacePath)
    await restored.waitForSettled(started.runId)
    const resumedJournal = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/u)
      .slice(journalLengthBeforeResume)
      .map((line) => JSON.parse(line) as { state?: { status?: string; cursor?: { stage?: string } } })
    const firstRunningRecord = resumedJournal.find((record) => record.state?.status === 'running')
    expect(firstRunningRecord?.state?.cursor?.stage).toBe('recovery')
    expect(restored.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('pauses the whole balanced battle on provider quota and continues after the reset without solo takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-pause-quota-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-pause-quota-runtime-'))
    const runner = new RecoverableQuotaRunner()
    let settings = defaultSettings(root)
    const orchestrator = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(settings),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: {
        reason: 'provider-quota',
        resetAt: '2026-07-11T22:00:00.000Z',
        resumable: true
      }
    })
    expect(['claude', 'codex']).toContain(orchestrator.getSnapshot(started.runId)?.pause?.provider)
    expect(new Set(runner.calls).size).toBe(1)

    runner.rejectQuota = false
    settings = {
      ...settings,
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'max',
      claudeModel: 'fable',
      claudeEffort: 'low'
    }
    const resumed = await orchestrator.resume(started.runId)
    expect(resumed.agentRuntimes).toEqual({
      codex: { model: 'gpt-5.6-sol', effort: 'max', source: 'studio' },
      claude: { model: 'fable', effort: 'low', source: 'studio' }
    })
    await orchestrator.waitForSettled(started.runId)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    expect(new Set(runner.calls)).toEqual(new Set(['claude', 'codex']))
  })

  it('restores the private pitch baton after restart without exposing it publicly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-private-baton-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-private-baton-runtime-'))
    const runner = new PrivateBatonQuotaRunner()
    const first = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await first.start(request(root))
    await first.waitForSettled(started.runId)
    expect(first.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'provider-quota', stage: 'dialogue' }
    })

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await expect(restored.restore()).resolves.toBe(1)
    await restored.resume(started.runId)
    await restored.waitForSettled(started.runId)

    expect(runner.resumedPrompt).toContain('Hidden One')
    expect(runner.resumedPrompt).toContain('Hidden Two')
    expect(restored.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    expect(restored.getSnapshot(started.runId)?.events.map((event) => event.publicText).join('\n'))
      .not.toMatch(/Hidden One|Hidden Two/u)
  })

  it('re-quarantines unmasked agent protocol speech when a paused run is restored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-restored-spoiler-quarantine-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-restored-spoiler-runtime-'))
    const runner = new RecoverableQuotaRunner()
    const first = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const started = await first.start(request(root))
    await first.waitForSettled(started.runId)
    await appendFile(join(runtimeRoot, started.runId, 'public', 'timeline.jsonl'), `${JSON.stringify({
      id: 'restored-concrete-protocol-leak',
      type: 'agent.dispatch',
      runId: started.runId,
      round: 1,
      timestamp: new Date().toISOString(),
      agent: 'claude',
      targetAgent: 'codex',
      dispatchKind: 'evidence',
      publicText: 'The blue emoji button unlocks after exactly seven clicks.',
      spoilerRisk: 0,
      severity: 'medium'
    })}\n`, 'utf8')

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await expect(restored.restore()).resolves.toBe(1)
    const restoredLeak = restored.getSnapshot(started.runId)?.events
      .find((event) => event.id === 'restored-concrete-protocol-leak')
    expect(restoredLeak?.publicText).toBe('Claude handed Codex spoiler-sealed build evidence.')
    expect(restoredLeak?.publicText).not.toMatch(/blue|emoji|button|seven|click/iu)
  })

  it('refuses to restore a paused workspace that was replaced by a directory link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-restore-link-root-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-restore-link-runtime-'))
    const attacker = await mkdtemp(join(tmpdir(), 'duo-restore-link-target-'))
    const runner = new RecoverableQuotaRunner()
    const first = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const started = await first.start(request(root))
    await first.waitForSettled(started.runId)
    expect(first.getSnapshot(started.runId)?.status).toBe('paused')
    await rename(started.workspacePath, `${started.workspacePath}-preserved`)
    await mkdir(join(attacker, '.duo'), { recursive: true })
    await symlink(attacker, started.workspacePath, process.platform === 'win32' ? 'junction' : 'dir')

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await expect(restored.restore()).resolves.toBe(0)
    expect(restored.getSnapshot(started.runId)).toBeUndefined()
  })

  it('checkpoints an active battle before app shutdown terminates child processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-pause-shutdown-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-pause-shutdown-runtime-'))
    const runner = new ShutdownRunner()
    const orchestrator = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    while (runner.calls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    await orchestrator.suspendForShutdown()

    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'host-interrupted', resumable: true }
    })
    expect(orchestrator.getSnapshot(started.runId)?.events.some((event) => event.type === 'run.failed')).toBe(false)

    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await expect(restored.restore()).resolves.toBe(1)
    expect(restored.getSnapshot(started.runId)).toMatchObject({ status: 'paused', pause: { reason: 'host-interrupted' } })
  })

  it('serializes concurrent Start admission before asynchronous settings resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-start-admission-'))
    const runner = new RecoverableQuotaRunner()
    let releaseSettings: () => void = () => undefined
    let signalEntered: () => void = () => undefined
    const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve })
    const entered = new Promise<void>((resolve) => { signalEntered = resolve })
    const orchestrator = new RunOrchestrator({
      getSettings: async () => {
        signalEntered()
        await settingsGate
        return defaultSettings(root)
      },
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const first = orchestrator.start(request(root))
    await entered
    const second = orchestrator.start(request(root))
    releaseSettings()
    const results = await Promise.allSettled([first, second])

    expect(results.filter((candidate) => candidate.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((candidate) => candidate.status === 'rejected')).toHaveLength(1)
    const started = results.find((candidate): candidate is PromiseFulfilledResult<Awaited<typeof first>> => candidate.status === 'fulfilled')
    if (started) await orchestrator.waitForSettled(started.value.runId)
  })

  it('serializes concurrent Resume admission before asynchronous settings resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-resume-admission-'))
    const runner = new RecoverableQuotaRunner()
    let blockSettings = false
    let releaseSettings: () => void = () => undefined
    let signalEntered: () => void = () => undefined
    let settingsGate = Promise.resolve()
    let entered = Promise.resolve()
    const orchestrator = new RunOrchestrator({
      getSettings: async () => {
        if (blockSettings) {
          signalEntered()
          await settingsGate
        }
        return defaultSettings(root)
      },
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('paused')

    blockSettings = true
    settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve })
    entered = new Promise<void>((resolve) => { signalEntered = resolve })
    const first = orchestrator.resume(started.runId)
    await entered
    const second = orchestrator.resume(started.runId)
    releaseSettings()
    const results = await Promise.allSettled([first, second])

    expect(results.filter((candidate) => candidate.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((candidate) => candidate.status === 'rejected')).toHaveLength(1)
    await orchestrator.waitForSettled(started.runId)
  })
})
