import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../src/main/settings/settings-store'
import {
  RunOrchestrator as BaseRunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import type {
  ProcessRunOptions,
  ProcessRunResult
} from '../../src/main/process/process-runner'

class RunOrchestrator extends BaseRunOrchestrator {
  constructor(options: ConstructorParameters<typeof BaseRunOrchestrator>[0]) {
    super({ ...options, planVersion: 'balanced-hybrid-v1', testOnlyMinimumTurns: 2 })
  }
}

function stageOf(prompt: string): string {
  return prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase() ?? 'legacy'
}

function roundOf(prompt: string): number {
  return Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
}

function agentOf(options: ProcessRunOptions): 'claude' | 'codex' {
  return options.id.includes('claude') ? 'claude' : 'codex'
}

class TimeboxedWorkRunner implements ProcessRunnerPort {
  readonly calls: Array<{ agent: 'claude' | 'codex'; round: number; stage: string; resumed: boolean }> = []
  readonly commands: ProcessRunOptions['command'][] = []

  constructor(
    private readonly earlyOpeningRound?: number,
    private readonly quotaAfterEarlyOpening = false,
    private readonly quotaOpeningRoundWithoutEdit?: number,
    private readonly noOpWorkRound?: number,
    private readonly protocolRoundOffset = 0,
    private readonly stagedDispatchOnly = false
  ) {}

  private quotaWithoutEditUsed = false

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const agent = agentOf(options)
    const round = roundOf(prompt)
    const stage = stageOf(prompt)
    const resumed = options.command.args.includes('--resume') || options.command.args.includes('resume')
    this.calls.push({ agent, round, stage, resumed })
    this.commands.push(options.command)

    if (agent === 'codex' && stage === 'opening') {
      options.onLine('stdout', JSON.stringify({
        type: 'thread.started',
        thread_id: '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
      }))
    }

    if (stage === 'dialogue' || stage === 'opening' || stage === 'verdict' || stage === 'recovery') {
      const protocolRound = round + this.protocolRoundOffset
      const dispatchKind = stage === 'verdict' ? 'verdict' : stage === 'recovery' ? 'closing' : 'opening'
      const id = `${agent}-r${String(protocolRound)}-${stage}-${String(this.calls.length)}`
      await appendFile(join(options.command.cwd, '.duo', 'public', 'dispatches.jsonl'), `${JSON.stringify({
        id,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round: protocolRound,
        dispatchKind,
        claimKey: `round-${String(round)}`,
        replyTo: null,
        publicText: `I ${stage === 'verdict' ? 'finished my slice and want the other agent to verify it' : 'will challenge the current [FEATURE] with concrete evidence'}.`,
        spoilerRisk: 0.02
      })}\n`, 'utf8')
      if (!this.stagedDispatchOnly || stage === 'dialogue') {
        await appendFile(join(options.command.cwd, '.duo', 'public', 'opinions.jsonl'), `${JSON.stringify({
          id: `${id}-opinion`,
          type: 'opinion',
          agent,
          targetAgent: agent === 'claude' ? 'codex' : 'claude',
          round: protocolRound,
          topic: stage,
          tone: 'confident',
          publicText: 'The current [FEATURE] can survive if both implementation slices stay testable.',
          spoilerRisk: 0.02
        })}\n`, 'utf8')
      }
    }

    if (stage === 'work' && round !== this.noOpWorkRound) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), `${agent} durable work\n`, 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${agent}-slice.txt`, kind: 'update' }] }
      }))
    }

    if (stage === 'opening' && round === this.earlyOpeningRound) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-early-slice.txt`), `${agent} moved from position into durable implementation\n`, 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${agent}-early-slice.txt`, kind: 'update' }] }
      }))
      if (this.quotaAfterEarlyOpening) {
        options.onLine('stdout', JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetAt: '2026-07-12T07:00:00.000Z' }
        }))
      }
    }

    if (
      stage === 'opening' &&
      round === this.quotaOpeningRoundWithoutEdit &&
      !this.quotaWithoutEditUsed
    ) {
      this.quotaWithoutEditUsed = true
      options.onLine('stdout', JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetAt: '2026-07-12T07:00:00.000Z' }
      }))
    }

    const now = new Date().toISOString()
    if (stage === 'work' && round === 5) {
      return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
        cancelled: false,
        startedAt: now,
        finishedAt: now
      }
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      startedAt: now,
      finishedAt: now
    }
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class CeilingExpiryRunner implements ProcessRunnerPort {
  constructor(private readonly expire: () => void) {}

  run(): Promise<ProcessRunResult> {
    this.expire()
    const now = new Date().toISOString()
    return Promise.resolve({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      cancelled: false,
      startedAt: now,
      finishedAt: now
    })
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class ResumeRejectingRunner implements ProcessRunnerPort {
  readonly calls: Array<{ round: number; stage: string; resumed: boolean }> = []
  private rejected = false

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = roundOf(prompt)
    const stage = stageOf(prompt)
    const agent = agentOf(options)
    const resumed = options.command.args.includes('--resume') || options.command.args.includes('resume')
    this.calls.push({ round, stage, resumed })
    const now = new Date().toISOString()
    if (agent === 'codex' && stage === 'opening') {
      options.onLine('stdout', JSON.stringify({
        type: 'thread.started',
        thread_id: '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
      }))
    }
    if (round === 5 && stage === 'work' && resumed && !this.rejected) {
      this.rejected = true
      options.onLine('stderr', 'Session not found; cannot resume the requested provider session.')
      return { exitCode: 1, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
    }

    if (stage === 'dialogue' || stage === 'opening' || stage === 'verdict' || stage === 'recovery') {
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-r${String(round)}-${stage}-${String(this.calls.length)}`,
        type: 'agent.dispatch', agent, targetAgent: agent === 'claude' ? 'codex' : 'claude', round,
        dispatchKind: stage === 'verdict' ? 'verdict' : stage === 'recovery' ? 'closing' : 'opening',
        publicText: 'I think the shared [FEATURE] should stay bounded because the evidence is testable.', spoilerRisk: 0.02
      }))
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-r${String(round)}-${stage}-opinion-${String(this.calls.length)}`,
        type: 'opinion', agent, targetAgent: agent === 'claude' ? 'codex' : 'claude', round,
        tone: 'collaborative', publicText: 'The shared [FEATURE] remains a practical direction.', spoilerRisk: 0.02
      }))
    }
    if (round === 5 && stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), 'fresh-session source work\n', 'utf8')
    }
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

const healthyAgents = () => Promise.resolve([
  { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex 1', checkedAt: new Date().toISOString() },
  { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude 1', checkedAt: new Date().toISOString() },
  { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
])

describe('broadcast turn orchestration', () => {
  it('does not loop staged verdict recovery when the agent files a real handoff without a duplicate opinion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-dispatch-only-verdict-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, undefined, 0, true)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Build and cross-review a bounded app while keeping staged handoffs concise.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(runner.calls.some((call) => call.stage === 'recovery')).toBe(false)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
  })

  it('checkpoints a timed-out work lease and advances without rerunning the expensive stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-broadcast-turn-'))
    const runner = new TimeboxedWorkRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Build a sealed app through equal evidence-producing turns.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const roundFiveAgent = runner.calls.find((call) => call.round === 5)?.agent
    expect(roundFiveAgent).toBeDefined()
    const roundSixAgent = roundFiveAgent === 'claude' ? 'codex' : 'claude'
    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'work')).toHaveLength(1)
    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: roundFiveAgent, round: 5, stage: 'opening' }),
      expect.objectContaining({ agent: roundFiveAgent, round: 5, stage: 'work' }),
      expect.objectContaining({ agent: roundFiveAgent, round: 5, stage: 'verdict' }),
      expect.objectContaining({ agent: roundSixAgent, round: 6, stage: 'opening' }),
      expect.objectContaining({ agent: roundSixAgent, round: 6, stage: 'work' })
    ]))
    const timedVerdict = runner.commands.find((command) =>
      stageOf(command.stdin ?? command.args.at(-1) ?? '') === 'verdict' && command.bin === roundFiveAgent
    )
    expect(timedVerdict?.args).not.toContain('--resume')
    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.events.some((event) => event.type === 'decision' && event.topic === 'turn-timeboxed')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  it('preserves implementation produced during an opening and verifies it in the work lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-early-opening-work-'))
    const runner = new TimeboxedWorkRunner(6)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Preserve useful early implementation without spending a duplicate work lease.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const earlyAgent = runner.calls.find((call) => call.round === 6)?.agent
    expect(earlyAgent).toBeDefined()
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'opening')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(runner.calls.find((call) => call.round === 6 && call.stage === 'work')?.resumed).toBe(true)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'verdict')).toHaveLength(1)
    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.events.some((event) => event.type === 'decision' && event.topic === 'early-work-preserved')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  it('does not suspend when an opening already produced durable source and the work lease only reviews it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-early-opening-review-only-'))
    const runner = new TimeboxedWorkRunner(6, false, undefined, 6)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Preserve verified opening source when the follow-up lease only reviews it.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
    expect(orchestrator.getSnapshot(result.runId)?.events.some((event) => event.topic === 'early-work-preserved')).toBe(true)
  })

  it('restores quota-preserved opening work into the work lease without replaying the opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-resume-early-opening-work-'))
    const workspaceRoot = join(root, 'workspaces')
    const runtimeRoot = join(root, 'runtime')
    const runner = new TimeboxedWorkRunner(6, true, undefined, 6)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(workspaceRoot)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5,
      runtimeRoot
    })

    const result = await orchestrator.start({
      prompt: 'Resume already-written opening work without repeating provider usage.',
      workspaceRoot,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({ status: 'paused', pause: { reason: 'provider-quota', stage: 'work' } })

    const restored = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(workspaceRoot)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5,
      runtimeRoot
    })
    await expect(restored.restore()).resolves.toBe(1)
    await restored.resume(result.runId)
    await restored.waitForSettled(result.runId)

    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'opening')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'verdict')).toHaveLength(1)
    expect(restored.getSnapshot(result.runId)?.status).toBe('reveal-ready')
    expect(restored.getSnapshot(result.runId)?.events.some((event) => event.topic === 'early-work-preserved')).toBe(true)
  })

  it('continues quota-preserved opening work in the same process without replaying the opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-resume-same-process-early-work-'))
    const runner = new TimeboxedWorkRunner(6, true)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Continue the preserved source at the work boundary after quota resets.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'provider-quota', stage: 'work' }
    })

    await orchestrator.resume(result.runId)
    await orchestrator.waitForSettled(result.runId)

    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'opening')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
  })

  it('stamps agent-authored protocol records onto the active scheduled turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-protocol-round-stamp-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, undefined, 50)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Keep provider-authored round labels from escaping the scheduled battle.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.round).toBeLessThanOrEqual(snapshot?.totalTurns ?? 0)
    expect(snapshot?.events.filter((event) => event.type === 'agent.dispatch').every((event) => event.round <= 6)).toBe(true)
  })

  it('allows a review lease to conclude without a redundant source edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-review-noop-work-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, 8)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Let the final reviewer preserve a correct build without inventing an edit.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(runner.calls.some((call) => call.round >= 7 && call.stage === 'work')).toBe(true)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
  })

  it('rejects unrelated app edits made outside the preserved paused battle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-resume-unrelated-dirty-app-'))
    const runner = new TimeboxedWorkRunner(undefined, false, 6)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Do not mistake an external paused-workspace edit for provider work.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 6,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'provider-quota', stage: 'opening' }
    })
    await writeFile(join(result.workspacePath, 'app', 'external-paused-edit.txt'), 'not provider provenance\n', 'utf8')

    await expect(orchestrator.resume(result.runId)).rejects.toThrow(/changed outside the preserved battle/i)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'opening')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(0)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'provider-quota', stage: 'opening' }
    })
  })

  it('prepares the best preserved reveal when the overall ceiling expires inside a stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-run-ceiling-'))
    let now = Date.parse('2026-07-10T20:00:00.000Z')
    const runner = new CeilingExpiryRunner(() => { now += 61_000 })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      now: () => now,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Preserve any durable result when the recording ceiling closes.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 60,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.releaseStatus).toBe('partial')
    expect(snapshot?.events.some((event) => event.topic === 'run-ceiling')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  it('keeps a run cancelled when Stop lands during post-loop reveal preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-reveal-stop-race-'))
    let now = Date.parse('2026-07-10T20:00:00.000Z')
    let stopPromise: Promise<unknown> | undefined
    const runner = new CeilingExpiryRunner(() => { now += 61_000 })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      onEvent: (event) => {
        if (event.topic === 'run-ceiling') stopPromise = orchestrator.stop(event.runId)
      },
      processRunner: runner,
      healthProvider: healthyAgents,
      now: () => now,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Stop safely even if the reveal packet is being prepared.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 60,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    await stopPromise

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('cancelled')
    expect(snapshot?.phase).toBe('cancelled')
    expect(snapshot?.releaseStatus).toBeUndefined()
    expect(snapshot?.events.some((event) => event.type === 'reveal.ready')).toBe(false)
    await expect(orchestrator.reveal(result.runId)).rejects.toThrow(/not ready/i)
  })

  it('falls back to one fresh bounded session when an exact resume is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-resume-fallback-'))
    const runner = new ResumeRejectingRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Keep provider continuity but recover safely if resume is unavailable.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 5,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 86_400,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const workCalls = runner.calls.filter((call) => call.round === 5 && call.stage === 'work')
    expect(workCalls).toEqual([
      { round: 5, stage: 'work', resumed: true },
      { round: 5, stage: 'work', resumed: false }
    ])
    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.events.some((event) => event.topic === 'session-fallback')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
  })
})
