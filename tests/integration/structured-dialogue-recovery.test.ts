import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RunOrchestrator, type ProcessRunnerPort } from '../../src/main/orchestrator/run-orchestrator'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'

function promptOf(options: ProcessRunOptions): string {
  return options.command.stdin ?? options.command.args.at(-1) ?? ''
}

function stageOf(options: ProcessRunOptions): string {
  return promptOf(options).match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase() ?? 'legacy'
}

function roundOf(options: ProcessRunOptions): number {
  return Number(promptOf(options).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
}

function agentOf(options: ProcessRunOptions): 'claude' | 'codex' {
  return options.id.includes('claude') ? 'claude' : 'codex'
}

function pitchCapsule(unsafe = false): Record<string, unknown> {
  return {
    opening: {
      publicText: unsafe
        ? 'I think Orbit Garden should win because its interaction reads immediately.'
        : 'I think the [FEATURE] should win because its interaction reads immediately.',
      privateText: 'I think Orbit Garden should win because its spatial seed ritual reads immediately.'
    },
    counter: {
      publicText: 'I agree on focus, but the [FEATURE] needs an equally tactile keyboard path.',
      privateText: 'I agree on focus, but Orbit Garden needs arrow-key seed placement.'
    },
    verdict: {
      publicText: 'I would carry the focused [FEATURE] forward with deterministic input and one replayable ending.',
      privateText: 'I would carry Orbit Garden forward with deterministic input and one replayable ending.'
    },
    opinion: {
      publicText: 'The smaller [FEATURE] is stronger because its completion state is testable.',
      privateText: 'Orbit Garden is stronger because the completion state is testable.',
      tone: 'confident'
    },
    tasks: [],
    pitches: [
      { title: 'Orbit Garden', idea: 'A spatial seed ritual.', appeal: 'Tactile and visual.', risk: 'Input parity.' },
      { title: 'Signal Room', idea: 'A disappearing radio message.', appeal: 'Immediate tension.', risk: 'Audio polish.' }
    ],
    consensus: null,
    redactions: [
      { value: 'Orbit Garden', label: 'APP_NAME' },
      { value: 'Signal Room', label: 'APP_NAME' },
      { value: 'spatial seed ritual', label: 'FEATURE' }
    ]
  }
}

class UnsafeThenRecoveredDialogueRunner implements ProcessRunnerPort {
  readonly calls: Array<{ agent: 'claude' | 'codex'; round: number; stage: string }> = []

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = agentOf(options)
    const round = roundOf(options)
    const stage = stageOf(options)
    this.calls.push({ agent, round, stage })
    const capsule = pitchCapsule(round === 1 && stage === 'dialogue')
    options.onLine('stdout', agent === 'claude'
      ? JSON.stringify({ type: 'result', structured_output: capsule })
      : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
    const now = new Date().toISOString()
    return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now })
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

const healthyAgents = () => Promise.resolve([
  { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: new Date().toISOString() },
  { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: new Date().toISOString() },
  { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: new Date().toISOString() }
])

describe('structured dialogue recovery', () => {
  it('redacts a spoiler leak deterministically without spending a second provider turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-structured-recovery-'))
    const runner = new UnsafeThenRecoveredDialogueRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start({
      prompt: 'Debate two compact hidden ideas without leaking their names.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 120,
      runTimeoutSeconds: 600,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    const snapshot = orchestrator.getSnapshot(started.runId)
    const firstActiveAgent = runner.calls[0]?.agent
    expect(firstActiveAgent).toBeDefined()
    expect(runner.calls.slice(0, 2)).toEqual([
      { agent: firstActiveAgent, round: 1, stage: 'dialogue' },
      { agent: firstActiveAgent === 'claude' ? 'codex' : 'claude', round: 2, stage: 'dialogue' }
    ])
    expect(runner.calls.some((call) => call.stage === 'recovery')).toBe(false)
    expect(snapshot?.events.some((event) => event.topic === 'dialogue-contract-rejected')).toBe(false)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
    // This fixture intentionally stops after two dialogue turns. The leaked
    // noun is redacted locally without a second provider call, but no implementation or
    // release evidence exists, so the durable quality gate must remain paused.
    expect(snapshot).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
    const publicDispatches = await readFile(join(started.workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')
    expect(publicDispatches).not.toContain('Orbit Garden')
  })
})
