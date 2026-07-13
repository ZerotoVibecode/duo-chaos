import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunOrchestrator as BaseRunOrchestrator, type ProcessRunnerPort } from '../../src/main/orchestrator/run-orchestrator'
import { DurableRunStateStore, type DurableRunManifest } from '../../src/main/persistence/durable-run-state'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'
import { buildRealTurnPlan } from '../../src/main/orchestrator/real-turn-plan'

class RunOrchestrator extends BaseRunOrchestrator {
  constructor(options: ConstructorParameters<typeof BaseRunOrchestrator>[0]) {
    super({ ...options, planVersion: 'balanced-hybrid-v1' })
  }
}

const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function result(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    startedAt: '2026-07-11T20:00:00.000Z',
    finishedAt: '2026-07-11T20:00:01.000Z',
    ...overrides
  }
}

function promptOf(options: ProcessRunOptions): string {
  return options.command.stdin ?? options.command.args.at(-1) ?? ''
}

function roundOf(options: ProcessRunOptions): number {
  return Number(promptOf(options).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
}

function stageOf(options: ProcessRunOptions): string {
  return promptOf(options).match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase() ?? 'dialogue'
}

function agentOf(options: ProcessRunOptions): 'claude' | 'codex' {
  return options.id.includes('claude') ? 'claude' : 'codex'
}

function dialogueCapsule(round: number): Record<string, unknown> {
  const pitch = round <= 2
  const consensus = round === 4
  return {
    opening: {
      publicText: 'I think the bounded [FEATURE] should lead because its success condition is testable.',
      privateText: 'I think the bounded synthetic feature should lead because its success condition is testable.'
    },
    counter: {
      publicText: 'I agree on focus, but the [FEATURE] also needs an accessible alternate input.',
      privateText: 'I agree on focus, but the synthetic feature also needs an accessible alternate input.'
    },
    verdict: {
      publicText: 'Keep the focused [FEATURE] and prove it with one runnable path.',
      privateText: 'Keep the focused synthetic feature and prove it with one runnable path.'
    },
    opinion: {
      publicText: 'The smaller [FEATURE] is stronger because it can be verified directly.',
      privateText: 'The smaller synthetic feature is stronger because it can be verified directly.',
      tone: 'confident'
    },
    tasks: consensus
      ? [
          {
            id: 'claude-source', publicTitle: 'Build one half of the [FEATURE]',
            privateTitle: 'Build Claude synthetic source',
            publicDescription: 'Implement one bounded source slice.',
            privateDescription: 'Implement Claude synthetic source.',
            kind: 'implementation', risk: 'low', claimedBy: 'claude', files: []
          },
          {
            id: 'codex-source', publicTitle: 'Build the other half of the [FEATURE]',
            privateTitle: 'Build Codex synthetic source',
            publicDescription: 'Implement the paired source slice.',
            privateDescription: 'Implement Codex synthetic source.',
            kind: 'implementation', risk: 'low', claimedBy: 'codex', files: []
          }
        ]
      : [],
    pitches: pitch
      ? [
          { title: `Synthetic Pitch ${String(round)}A`, idea: 'Synthetic fixture A.', appeal: 'Focused.', risk: 'None.' },
          { title: `Synthetic Pitch ${String(round)}B`, idea: 'Synthetic fixture B.', appeal: 'Clear.', risk: 'None.' }
        ]
      : [],
    consensus: consensus
      ? {
          appName: 'Synthetic Fixture App',
          idea: 'A synthetic fixture used only for deterministic orchestration tests.',
          summary: 'A bounded fixture with equal source tasks.',
          spec: 'Both agents implement one small source slice and preserve the workspace.',
          redactions: [{ value: 'Synthetic Fixture App', label: 'APP_NAME' }]
        }
      : null,
    redactions: [
      { value: 'synthetic feature', label: 'FEATURE' },
      ...(pitch
        ? [
            { value: `Synthetic Pitch ${String(round)}A`, label: 'APP_NAME' },
            { value: `Synthetic Pitch ${String(round)}B`, label: 'APP_NAME' }
          ]
        : []),
      ...(consensus ? [{ value: 'Synthetic Fixture App', label: 'APP_NAME' }] : [])
    ]
  }
}

function emitDialogue(options: ProcessRunOptions): void {
  const agent = agentOf(options)
  const capsule = dialogueCapsule(roundOf(options))
  options.onLine('stdout', agent === 'claude'
    ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: capsule })
    : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
}

function emitRecoveryCapsule(options: ProcessRunOptions): void {
  const agent = agentOf(options)
  const value = {
    dispatch: {
      publicText: 'I think the shared [FEATURE] is ready for the next bounded evidence step.',
      privateText: 'I think the shared synthetic feature is ready for the next bounded evidence step.'
    },
    opinion: null,
    redactions: [{ value: 'synthetic feature', label: 'FEATURE' }]
  }
  options.onLine('stdout', agent === 'claude'
    ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: value })
    : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }))
}

function emitStageContract(options: ProcessRunOptions): void {
  const agent = agentOf(options)
  const round = roundOf(options)
  const stage = stageOf(options)
  options.onLine('stdout', JSON.stringify({
    id: `${agent}-${String(round)}-${stage}-dispatch`,
    type: 'agent.dispatch',
    agent,
    targetAgent: agent === 'claude' ? 'codex' : 'claude',
    round,
    dispatchKind: stage === 'verdict' ? 'verdict' : 'opening',
    publicText: 'The shared [FEATURE] has one concrete tradeoff on record.',
    spoilerRisk: 0.02
  }))
  options.onLine('stdout', JSON.stringify({
    id: `${agent}-${String(round)}-${stage}-opinion`,
    type: 'opinion',
    agent,
    targetAgent: agent === 'claude' ? 'codex' : 'claude',
    round,
    tone: 'collaborative',
    publicText: 'The bounded [FEATURE] is ready for the next evidence step.',
    spoilerRisk: 0.02
  }))
}

const healthyAgents = () => Promise.resolve([
  { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: '2026-07-11T20:00:00.000Z' },
  { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: '2026-07-11T20:00:00.000Z' },
  { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: '2026-07-11T20:00:00.000Z' }
])

function request(root: string, maxTurns = 2): Record<string, unknown> {
  return {
    prompt: 'Exercise a synthetic provider boundary without private project data.',
    workspaceRoot: root,
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    maxTurns,
    maxRepairLoops: 0,
    turnTimeoutSeconds: 120,
    runTimeoutSeconds: 600,
    dangerousModeConfirmed: false,
    unsafeWorkspaceRootConfirmed: false
  }
}

class ImmediateFailureRunner implements ProcessRunnerPort {
  readonly calls: Array<'claude' | 'codex'> = []

  constructor(private readonly text: string) {}

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls.push(agentOf(options))
    options.onLine('stderr', this.text)
    return Promise.resolve(result({ exitCode: 1 }))
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class ContractInvalidRecoveryRunner implements ProcessRunnerPort {
  readonly stages: string[] = []
  private rejected = false

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const stage = stageOf(options)
    this.stages.push(stage)
    if (stage === 'dialogue' && !this.rejected) {
      this.rejected = true
      options.onLine('stdout', JSON.stringify({ type: 'contract.invalid', code: 'structured_output_invalid' }))
      return Promise.resolve(result({ exitCode: 1 }))
    }
    emitDialogue(options)
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class PrettyPrintedAllowedQuotaRunner implements ProcessRunnerPort {
  private emittedPrettyEnvelope = false

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (!this.emittedPrettyEnvelope) {
      this.emittedPrettyEnvelope = true
      const agent = agentOf(options)
      const capsule = dialogueCapsule(roundOf(options))
      const finalRecord = agent === 'claude'
        ? { type: 'result', subtype: 'success', structured_output: capsule }
        : { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }
      for (const line of JSON.stringify([
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
        finalRecord
      ], null, 2).split(/\r?\n/u)) {
        options.onLine('stdout', line)
      }
    } else {
      emitDialogue(options)
    }
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class AmbiguousConsensusRunner implements ProcessRunnerPort {
  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = agentOf(options)
    const round = roundOf(options)
    const capsule = dialogueCapsule(round)
    if (round === 4 && Array.isArray(capsule.tasks)) {
      capsule.tasks = capsule.tasks.map((task, index) => ({
        ...(task as Record<string, unknown>),
        claimedBy: index === 0 ? 'both' : 'none'
      }))
    }
    options.onLine('stdout', agent === 'claude'
      ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: capsule })
      : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
    return Promise.resolve(result())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

describe('provider fault matrix', () => {
  it.each([
    ['Authentication error: login required.', 'provider-auth'],
    ['The selected model was not found.', 'model-unavailable'],
    ["error: unknown option '--output-format'", 'cli-incompatible'],
    ['The upstream service is temporarily unavailable.', 'provider-unavailable']
  ] as const)('pauses the balanced run on recoverable provider boundary: %s', async (text, pauseReason) => {
    const root = await temporaryRoot('duo-fault-recoverable-')
    const runner = new ImmediateFailureRunner(text)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)

    expect(snapshot).toMatchObject({ status: 'paused', phase: 'paused', pause: { reason: pauseReason, resumable: true } })
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(runner.calls).toHaveLength(1)
    expect(new Set(runner.calls).size).toBe(1)
  })

  it.each([
    ['workspace_drift detected outside the expected checkpoint', 'workspace-drift'],
    ['sandbox_violation: unsafe workspace write rejected', 'safety-violation']
  ] as const)('terminates explicit non-recoverable boundary: %s', async (text, topic) => {
    const root = await temporaryRoot('duo-fault-terminal-')
    const runner = new ImmediateFailureRunner(text)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)

    expect(snapshot?.status).toBe('failed')
    expect(snapshot?.pause).toBeUndefined()
    expect(snapshot?.events).toContainEqual(expect.objectContaining({ type: 'run.failed', topic }))
    expect(runner.calls).toHaveLength(1)
  })

  it('accepts a recorded dialogue contract as a soft timebox instead of stopping the run', async () => {
    const root = await temporaryRoot('duo-fault-timebox-')
    const calls: Array<'claude' | 'codex'> = []
    const runner: ProcessRunnerPort = {
      run: (options) => {
        calls.push(agentOf(options))
        emitDialogue(options)
        return Promise.resolve(result({ exitCode: null, signal: 'SIGTERM', timedOut: true }))
      },
      cancelAll: () => Promise.resolve()
    }
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)

    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.events.filter((event) => event.topic === 'turn-timeboxed')).toHaveLength(2)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(new Set(calls)).toEqual(new Set(['claude', 'codex']))
  })

  it('pauses on a quota signal inside one Claude array while preserving capsule and usage truth, then Stop cancels', async () => {
    const root = await temporaryRoot('duo-fault-array-quota-')
    const calls: Array<'claude' | 'codex'> = []
    const runner: ProcessRunnerPort = {
      run: (options) => {
        const agent = agentOf(options)
        calls.push(agent)
        if (agent === 'claude') {
          options.onLine('stdout', JSON.stringify([
            { type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' },
            {
              type: 'rate_limit_event',
              rate_limit_info: {
                status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected',
                resetAt: '2026-07-12T01:00:00.000Z'
              }
            },
            { type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic fixture' }] } },
            {
              type: 'result', subtype: 'success', structured_output: dialogueCapsule(roundOf(options)),
              total_cost_usd: 0.05,
              usage: {
                input_tokens: 10, cache_creation_input_tokens: 20,
                cache_read_input_tokens: 30, output_tokens: 40
              }
            }
          ]))
          return Promise.resolve(result({ exitCode: 1 }))
        }
        emitDialogue(options)
        return Promise.resolve(result())
      },
      cancelAll: () => Promise.resolve()
    }
    const orchestrator = new RunOrchestrator({
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
      pause: {
        reason: 'provider-quota', provider: 'claude', resumable: true,
        resetAt: '2026-07-12T01:00:00.000Z'
      },
      agentUsage: {
        claude: {
          processedInputTokens: 60, cachedInputTokens: 30, outputTokens: 40,
          calls: 1, reportedCostUsd: 0.05
        }
      }
    })
    expect(paused?.events).toContainEqual(expect.objectContaining({ type: 'agent.dispatch', agent: 'claude' }))
    expect(paused?.events).toContainEqual(expect.objectContaining({ type: 'opinion', agent: 'claude' }))
    expect(paused?.events.some((event) => event.type === 'run.failed')).toBe(false)
    const claudeIndex = calls.indexOf('claude')
    expect(claudeIndex).toBeGreaterThanOrEqual(0)
    expect(claudeIndex).toBe(calls.length - 1)

    const stopped = await orchestrator.stop(started.runId)
    expect(stopped).toMatchObject({ status: 'cancelled', phase: 'cancelled' })
    expect(stopped.pause).toBeUndefined()
    expect(stopped.events).toContainEqual(expect.objectContaining({ type: 'run.cancelled' }))
  })
})

class RestartBoundaryRunner implements ProcessRunnerPort {
  readonly calls: Array<{ round: number; stage: string; agent: 'claude' | 'codex' }> = []

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const round = roundOf(options)
    const stage = stageOf(options)
    const agent = agentOf(options)
    this.calls.push({ round, stage, agent })

    if (stage === 'dialogue') emitDialogue(options)
    else if (stage === 'opening' || stage === 'verdict') emitStageContract(options)
    else if (stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-${String(round)}.js`), 'export const synthetic = true\n', 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'file_change', changes: [{ path: `app/${agent}-${String(round)}.js` }] }
      }))
    }
    return result()
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class StagedFailureRunner implements ProcessRunnerPort {
  readonly calls: Array<{ round: number; stage: string; agent: 'claude' | 'codex'; resumed: boolean }> = []

  constructor(private readonly failure: 'quota-array' | 'safety') {}

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const round = roundOf(options)
    const stage = stageOf(options)
    const agent = agentOf(options)
    const resumed = options.command.args.includes('--resume') || options.command.args.includes('resume')
    this.calls.push({ round, stage, agent, resumed })

    if (stage === 'dialogue') {
      emitDialogue(options)
      return result()
    }
    if (stage === 'opening') {
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' })
        : JSON.stringify({ type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222' }))
      emitStageContract(options)
      return result()
    }
    if (stage === 'work' && round === 5) {
      if (this.failure === 'safety') {
        options.onLine('stderr', 'sandbox_violation: unsafe workspace write rejected')
      } else {
        const envelope = JSON.stringify([
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected',
              resetsAt: 1783818000
            }
          }
        ], null, 2)
        for (const line of envelope.split('\n')) options.onLine('stdout', line)
      }
      return result({ exitCode: 1 })
    }
    if (stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-${String(round)}.js`), 'export const fixture = true\n', 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'file_change', changes: [{ path: `app/${agent}-${String(round)}.js` }] }
      }))
      emitStageContract(options)
      return result()
    }
    emitStageContract(options)
    return result()
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class RecoveryResumeRunner implements ProcessRunnerPort {
  readonly calls: Array<{ round: number; stage: string; agent: 'claude' | 'codex'; toolFree: boolean }> = []
  private recoveryCalls = 0

  constructor(
    private readonly recoveryContractOnFirst = false,
    private readonly recoverySourceOnFirst = true
  ) {}

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const round = roundOf(options)
    const stage = stageOf(options)
    const agent = agentOf(options)
    const toolFree = agent === 'claude'
      ? options.command.args.includes('--tools') && options.command.args[options.command.args.indexOf('--tools') + 1] === ''
      : options.command.args.includes('read-only') && options.command.args.includes('shell_tool')
    this.calls.push({ round, stage, agent, toolFree })
    if (stage === 'dialogue') emitDialogue(options)
    else if (stage === 'opening' || stage === 'verdict') {
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify({ type: 'system', subtype: 'init', session_id: '33333333-3333-4333-8333-333333333333' })
        : JSON.stringify({ type: 'thread.started', thread_id: '44444444-4444-4444-8444-444444444444' }))
      emitStageContract(options)
    } else if (stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-${String(round)}.js`), 'export const recovered = true\n', 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'file_change', changes: [{ path: `app/${agent}-${String(round)}.js` }] }
      }))
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-${String(round)}-work-no-task`,
        type: 'opinion',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        tone: 'uncertain',
        publicText: 'The [FEATURE] needs a clearer task boundary before the next handoff.',
        privateText: "I don't see a task to complete.",
        spoilerRisk: 0.02
      }))
    } else if (stage === 'recovery') {
      this.recoveryCalls += 1
      if (this.recoveryCalls === 1 && this.recoverySourceOnFirst) {
        await writeFile(
          join(options.command.cwd, 'app', 'unaccepted-recovery-change.js'),
          'throw new Error("contract recovery must not edit source")\n',
          'utf8'
        )
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'app/unaccepted-recovery-change.js' }] }
        }))
      }
      if (this.recoveryCalls > 1 || this.recoveryContractOnFirst) emitRecoveryCapsule(options)
    }
    return result()
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class BlockingCodexSessionRunner implements ProcessRunnerPort {
  readonly sessionId = '55555555-5555-4555-8555-555555555555'
  private resolveDiscovered: () => void = () => undefined
  readonly discovered = new Promise<void>((resolve) => { this.resolveDiscovered = resolve })
  private pending: Array<(value: ProcessRunResult) => void> = []

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const round = roundOf(options)
    const stage = stageOf(options)
    const agent = agentOf(options)
    if (stage === 'dialogue') emitDialogue(options)
    else if (stage === 'opening') {
      if (agent === 'codex' && round >= 5) {
        options.onLine('stdout', JSON.stringify({ type: 'thread.started', thread_id: this.sessionId }))
        emitStageContract(options)
        this.resolveDiscovered()
        return await new Promise<ProcessRunResult>((resolve) => this.pending.push(resolve))
      }
      options.onLine('stdout', JSON.stringify({ type: 'system', subtype: 'init', session_id: '66666666-6666-4666-8666-666666666666' }))
      emitStageContract(options)
    } else if (stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-${String(round)}.js`), 'export const staged = true\n', 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'file_change', changes: [{ path: `app/${agent}-${String(round)}.js` }] }
      }))
      emitStageContract(options)
    } else emitStageContract(options)
    return result()
  }

  cancelAll(): Promise<void> {
    for (const resolve of this.pending.splice(0)) {
      resolve(result({ exitCode: null, signal: 'SIGTERM', cancelled: true }))
    }
    return Promise.resolve()
  }
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out while ${label}.`)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('release recovery hardening', () => {
  it('balances ambiguous consensus ownership in the live orchestrator without pausing', async () => {
    const root = await temporaryRoot('duo-fault-ambiguous-consensus-')
    const runner = new AmbiguousConsensusRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 4))
    await within(orchestrator.waitForSettled(started.runId), 'balancing consensus ownership')

    const snapshot = orchestrator.getSnapshot(started.runId)
    expect(snapshot?.tasks.map((task) => task.claimedBy)).toEqual(['claude', 'codex'])
    expect(snapshot?.events.some((event) => event.topic === 'task-ownership-balanced')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.paused')).toBe(false)
  })

  it('accepts a pretty-printed multiline allowed quota envelope without a false pause', async () => {
    const root = await temporaryRoot('duo-fault-multiline-allowed-')
    const runner = new PrettyPrintedAllowedQuotaRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 2))
    await within(orchestrator.waitForSettled(started.runId), 'accepting multiline allowed quota')

    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    expect(orchestrator.getSnapshot(started.runId)?.events.some((event) =>
      event.type === 'run.paused' && event.topic === 'provider-quota'
    )).toBe(false)
  })

  it('routes a provider schema rejection through one local contract recovery instead of pausing', async () => {
    const root = await temporaryRoot('duo-fault-contract-invalid-')
    const runner = new ContractInvalidRecoveryRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 2))
    await within(orchestrator.waitForSettled(started.runId), 'recovering an invalid provider contract')

    expect(runner.stages.filter((stage) => stage === 'recovery')).toHaveLength(1)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    expect(orchestrator.getSnapshot(started.runId)?.events.some((event) => event.type === 'run.paused')).toBe(false)
  })

  it.each([
    ['quota-array', 'paused', 'provider-quota'],
    ['safety', 'failed', undefined]
  ] as const)('does not fresh-retry a resumed %s provider failure', async (failure, status, pauseReason) => {
    const root = await temporaryRoot(`duo-fault-resume-${failure}-`)
    const runner = new StagedFailureRunner(failure)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 5))
    await within(orchestrator.waitForSettled(started.runId), `settling ${failure} run`)

    const workCalls = runner.calls.filter((call) => call.round === 5 && call.stage === 'work')
    expect(workCalls).toHaveLength(1)
    expect(workCalls[0]?.resumed).toBe(true)
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status,
      ...(pauseReason ? { pause: { reason: pauseReason } } : {})
    })
  })

  it('resumes failed contract-only recovery without repeating accepted work', async () => {
    const root = await temporaryRoot('duo-fault-recovery-stage-')
    const runtimeRoot = await temporaryRoot('duo-fault-recovery-runtime-')
    const runner = new RecoveryResumeRunner(false, false)
    const orchestrator = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 5))
    await within(orchestrator.waitForSettled(started.runId), 'pausing failed recovery')
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused', pause: { reason: 'provider-protocol', stage: 'recovery' }
    })
    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'work')).toHaveLength(1)
    const workAgent = runner.calls.find((call) => call.round === 5 && call.stage === 'work')?.agent
    expect(workAgent).toMatch(/claude|codex/u)
    await expect(readFile(join(started.workspacePath, 'app', `${workAgent}-5.js`), 'utf8')).resolves.toContain('recovered')

    const beforeResume = runner.calls.length
    await orchestrator.resume(started.runId)
    await within(orchestrator.waitForSettled(started.runId), 'settling resumed recovery')

    expect(runner.calls[beforeResume]).toMatchObject({ round: 5, stage: 'recovery' })
    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'work')).toHaveLength(1)
    await expect(readFile(join(started.workspacePath, 'app', `${workAgent}-5.js`), 'utf8')).resolves.toContain('recovered')
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('leaves an unexpected recovery source edit visible and blocks automatic resume', async () => {
    const root = await temporaryRoot('duo-fault-recovery-drift-')
    const runner = new RecoveryResumeRunner(true)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 5))
    await within(orchestrator.waitForSettled(started.runId), 'preserving forbidden recovery source for inspection')

    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'work')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'recovery')).toHaveLength(1)
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused', pause: { reason: 'provider-protocol', stage: 'recovery' }
    })
    await expect(readFile(join(started.workspacePath, 'app', 'unaccepted-recovery-change.js'), 'utf8'))
      .resolves.toContain('contract recovery must not edit source')
    expect(orchestrator.getSnapshot(started.runId)?.events.some((event) =>
      event.topic === 'recovery-source-quarantined'
    )).toBe(false)
    await expect(orchestrator.resume(started.runId)).rejects.toThrow('changed outside the preserved battle')
    await expect(readFile(join(started.workspacePath, 'app', 'unaccepted-recovery-change.js'), 'utf8'))
      .resolves.toContain('contract recovery must not edit source')
  })

  it('repairs a staged handoff through an ephemeral structured no-tool response', async () => {
    const root = await temporaryRoot('duo-fault-tool-free-recovery-')
    const runner = new RecoveryResumeRunner(true, false)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 5))
    await within(orchestrator.waitForSettled(started.runId), 'repairing a staged handoff without tools')

    const recovery = runner.calls.find((call) => call.round === 5 && call.stage === 'recovery')
    expect(recovery).toMatchObject({ toolFree: true })
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
    expect(runner.calls.filter((call) => call.round === 5 && call.stage === 'work')).toHaveLength(1)
  })

  it('checkpoints a discovered Codex session before a long stage completes', async () => {
    const root = await temporaryRoot('duo-fault-session-workspace-')
    const runtimeRoot = await temporaryRoot('duo-fault-session-runtime-')
    const runner = new BlockingCodexSessionRunner()
    const orchestrator = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start(request(root, 6))
    await within(runner.discovered, 'waiting for Codex session discovery')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const durable = new DurableRunStateStore(join(runtimeRoot, started.runId), {
      runId: started.runId,
      workspaceId: started.runId
    })
    expect((await durable.readManifest()).providerSessions.codex).toBe(runner.sessionId)

    await orchestrator.stop(started.runId)
    await within(orchestrator.waitForSettled(started.runId), 'stopping blocked session test')
  })
})

describe('restart and exact-stage continuation', () => {
  it('recovers a truncated journal as host-interrupted and resumes round-six work without replaying accepted round five', async () => {
    const root = await temporaryRoot('duo-fault-restart-workspace-')
    const runtimeRoot = await temporaryRoot('duo-fault-restart-runtime-')
    const bootstrapRunner = new ImmediateFailureRunner('Authentication error: login required.')
    const original = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: bootstrapRunner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await original.start(request(root, 6))
    await original.waitForSettled(started.runId)
    expect(original.getSnapshot(started.runId)?.status).toBe('paused')
    const runtimePath = join(runtimeRoot, started.runId)
    const durable = new DurableRunStateStore(runtimePath, { runId: started.runId, workspaceId: started.runId })
    const pausedManifest = await durable.readManifest()
    const plan = buildRealTurnPlan(started.runId, { maxTurns: 6, maxRepairLoops: 0 })
    const acceptedAgent = plan[4]?.agent
    expect(acceptedAgent).toMatch(/claude|codex/)
    const runningManifest: DurableRunManifest = {
      ...pausedManifest,
      revision: pausedManifest.revision + 1,
      status: 'running',
      updatedAt: '2026-07-11T20:30:00.000Z',
      cursor: {
        turnIndex: 5,
        stage: 'work',
        attempt: 1,
        idempotencyKey: `${started.runId}:5:work`
      },
      evidence: {
        ...pausedManifest.evidence,
        acceptedCodeAgents: acceptedAgent ? [acceptedAgent] : [],
        completedTaskAgents: acceptedAgent ? [acceptedAgent] : [],
        appRevision: 1,
        verifiedAppRevision: 0
      }
    }
    delete runningManifest.pause
    await durable.persist(runningManifest)
    await appendFile(durable.journalPath, '{"journalVersion":1,"state":', 'utf8')

    const resumedRunner = new RestartBoundaryRunner()
    const restored = new RunOrchestrator({
      runtimeRoot,
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: resumedRunner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    await expect(within(restored.restore(), 'restoring interrupted run')).resolves.toBe(1)
    expect(restored.getSnapshot(started.runId)).toMatchObject({
      status: 'paused', phase: 'paused',
      pause: { reason: 'host-interrupted', resumable: true, stage: 'work' }
    })
    expect(restored.getSnapshot(started.runId)?.events.some((event) => event.type === 'run.failed')).toBe(false)

    await within(restored.resume(started.runId), 'resuming restored runner')
    await within(restored.waitForSettled(started.runId), 'settling restored runner')

    expect(resumedRunner.calls[0]).toMatchObject({ round: 6, stage: 'work' })
    expect(resumedRunner.calls.some((call) => call.round < 6)).toBe(false)
    expect(bootstrapRunner.calls).toHaveLength(1)
    expect(restored.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })
})
