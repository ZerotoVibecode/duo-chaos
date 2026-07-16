import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RunOrchestrator, type ProcessRunnerPort } from '../../src/main/orchestrator/run-orchestrator'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'

interface UsageView {
  processedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  calls: number
  largestRawLineBytes: number
  reportedCostUsd?: number
}

describe('orchestrator usage snapshots', () => {
  it('accumulates numeric provider telemetry per agent without exposing raw payload text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-usage-orchestrator-'))
    const runner = new UsageProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
      ])
    })
    const started = await orchestrator.start({
      prompt: 'Measure a small equal-agent build.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 1,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    const snapshot = orchestrator.getSnapshot(started.runId) as (ReturnType<RunOrchestrator['getSnapshot']> & {
      agentUsage?: { claude: UsageView; codex: UsageView }
    })
    expect(snapshot?.agentUsage?.claude).toEqual({
      processedInputTokens: 35,
      cachedInputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 0,
      calls: 1,
      largestRawLineBytes: runner.largestRawLineBytes.claude,
      reportedCostUsd: 0.25
    })
    expect(snapshot?.agentUsage?.codex).toEqual({
      processedInputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 7,
      calls: 1,
      largestRawLineBytes: runner.largestRawLineBytes.codex
    })
    expect(snapshot?.agentUsage?.codex).not.toHaveProperty('reportedCostUsd')
    expect(JSON.stringify(snapshot?.agentUsage)).not.toContain('SEALED_PROVIDER_TEXT')
    expect(JSON.stringify(snapshot?.agentUsage)).not.toContain('private_result')
  })

  it('checkpoints heavy completed-call usage and continues without asking the human to resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-usage-guard-orchestrator-'))
    const runner = new UsageProcessRunner(true)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
      ])
    })
    const started = await orchestrator.start({
      prompt: 'Preserve quality across a heavy provider usage boundary.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    const completed = orchestrator.getSnapshot(started.runId)
    const firstAgent = runner.calls[0]
    expect(firstAgent).toBeDefined()
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]).not.toBe(firstAgent)
    expect(completed?.pause?.reason).not.toBe('usage-pressure')
    expect(completed?.usageGuard?.status).not.toBe('pending')
    expect(completed?.events.some((event) =>
      event.topic === 'provider-usage-advisory' &&
      event.publicText.includes('continuing automatically')
    )).toBe(true)
  })

  it('does not arm a provider-warning usage guard below 82 percent utilization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-provider-warning-threshold-'))
    const runner = new UsageProcessRunner(false, 0.75)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
      ])
    })
    const started = await orchestrator.start({
      prompt: 'Continue normally below the provider warning boundary.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    expect(runner.calls).toHaveLength(2)
    expect(orchestrator.getSnapshot(started.runId)).not.toMatchObject({
      status: 'paused',
      usageGuard: { trigger: 'provider-warning' }
    })
  })

  it.each([0.82, 0.87, 1])('keeps an allowed provider warning at %s advisory and completes the planned calls', async (utilization) => {
    const root = await mkdtemp(join(tmpdir(), 'duo-provider-warning-boundary-'))
    const runner = new UsageProcessRunner(false, utilization)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
      ])
    })
    const started = await orchestrator.start({
      prompt: 'Continue through an advisory provider warning.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    const completed = orchestrator.getSnapshot(started.runId)
    expect(runner.calls).toHaveLength(2)
    expect(completed?.pause?.reason).not.toBe('usage-pressure')
    expect(completed?.usageGuard?.status).not.toBe('pending')
    expect(completed?.events.some((event) =>
      event.topic === 'quota-pressure' &&
      event.publicText.includes(`${String(Math.round(utilization * 100))}% provider utilization`)
    )).toBe(true)
  })
})

class UsageProcessRunner implements ProcessRunnerPort {
  readonly largestRawLineBytes = { claude: 0, codex: 0 }
  readonly calls: Array<'claude' | 'codex'> = []

  constructor(
    private readonly heavyFirstCall = false,
    private readonly providerWarningUtilization?: number
  ) {}

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = options.command.bin === 'claude' ? 'claude' : 'codex'
    this.calls.push(agent)
    const heavy = this.heavyFirstCall && this.calls.length === 1
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    const lines = [
      JSON.stringify({
        id: `${agent}-usage-dispatch`,
        type: 'agent.dispatch',
        agent,
        round,
        dispatchKind: 'opening',
        claimKey: 'usage-contract',
        publicText: `${agent === 'claude' ? 'Claude' : 'Codex'} states a spoiler-safe position for the measured turn.`,
        spoilerRisk: 0.02
      }),
      JSON.stringify({
        id: `${agent}-usage-opinion`,
        type: 'opinion',
        agent,
        round,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        tone: 'collaborative',
        publicText: `${agent === 'claude' ? 'Claude' : 'Codex'} records one accepted contribution.`,
        spoilerRisk: 0.02
      }),
      ...(this.providerWarningUtilization === undefined
        ? []
        : [JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed_warning',
              rateLimitType: 'five_hour',
              utilization: this.providerWarningUtilization
            }
          })]),
      agent === 'claude'
        ? JSON.stringify({
            type: 'result',
            subtype: 'success',
            num_turns: 3,
            total_cost_usd: 0.25,
            private_result: 'SEALED_PROVIDER_TEXT_CLAUDE',
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: heavy ? 400_001 : 10,
              cache_read_input_tokens: 20,
              output_tokens: 4
            }
          })
        : JSON.stringify({
            type: 'turn.completed',
            private_result: 'SEALED_PROVIDER_TEXT_CODEX',
            usage: {
              input_tokens: heavy ? 400_001 : 100,
              cached_input_tokens: 60,
              output_tokens: 20,
              reasoning_output_tokens: 7
            }
          })
    ]

    for (const line of lines) {
      this.largestRawLineBytes[agent] = Math.max(this.largestRawLineBytes[agent], Buffer.byteLength(line, 'utf8'))
      options.onLine('stdout', line)
    }
    const stderrLine = `private provider warning: ${'SEALED_PROVIDER_TEXT_STDERR_'.repeat(20)}`
    this.largestRawLineBytes[agent] = Math.max(this.largestRawLineBytes[agent], Buffer.byteLength(stderrLine, 'utf8'))
    options.onLine('stderr', stderrLine)
    const now = new Date().toISOString()
    return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now })
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}
