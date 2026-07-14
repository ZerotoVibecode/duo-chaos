import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../src/main/settings/settings-store'
import {
  RunOrchestrator as BaseRunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import type { SupervisorVerifierPort } from '../../src/main/orchestrator/supervisor-verifier'
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

function turnKindOf(prompt: string): string {
  return prompt.match(/^Turn:\s*(\S+)/mi)?.[1]?.toLowerCase() ?? 'legacy'
}

function latestStatementIdOf(prompt: string): string | undefined {
  return prompt.match(/^LATEST .+ STATEMENT\r?\n([^:\r\n]+):/mi)?.[1]?.trim()
}

function humanBriefFromPrompt(prompt: string): string {
  return prompt.match(/^HUMAN BRIEF\r?\n([^\r\n]+)/mi)?.[1]?.trim() ??
    'Build a useful, runnable local interaction.'
}

function escapeFixtureHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function qualityBackedFixtureHtml(humanBrief: string): string {
  const evidence = /\b(?:do not|don't|never|without)\b/iu.test(humanBrief)
    ? 'Independent supervisor proof is required before readiness.'
    : humanBrief
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signal Garden</title></head><body><main><h1>Signal Garden</h1><p>${escapeFixtureHtml(evidence)}</p><button type="button">Run interaction</button></main></body></html>`
}

function fixtureDialogueCapsule(round: number, agent: 'claude' | 'codex', prompt: string): Record<string, unknown> {
  const humanBrief = humanBriefFromPrompt(prompt)
  const consensusBrief = /\b(?:do not|don't|never|without)\b/iu.test(humanBrief)
    ? 'Respect every recorded prohibition in the human brief and require independent proof before readiness.'
    : humanBrief
  const speech = (move: string) => ({
    publicText: `I think the shared [FEATURE] needs a concrete ${move} because the result must stay useful and testable.`,
    privateText: `${agent} records a private ${move} for Signal Garden in round ${String(round)}.`
  })
  return {
    opening: speech('opening'),
    counter: speech('counter'),
    verdict: speech('verdict'),
    opinion: { ...speech('opinion'), tone: 'collaborative' },
    pitches: round <= 2
      ? [
          {
            title: 'Signal Garden',
            idea: `${humanBrief} Signal Garden answers that brief with one compact local interaction.`,
            appeal: 'A distinctive payoff inside a bounded, runnable scope.',
            risk: 'The interaction still needs direct verification.'
          },
          {
            title: agent === 'claude' ? 'Lumen Workshop' : 'Pulse Workshop',
            idea: `${humanBrief} This alternative keeps the requested outcome with a different interaction.`,
            appeal: 'A second buildable direction for a real comparison.',
            risk: 'It may be less memorable than the shared candidate.'
          }
        ]
      : [],
    consensus: round === 4
      ? {
          appName: 'Signal Garden',
          idea: `${consensusBrief} The selected product is a surprising, runnable local interaction built by both agents.`,
          summary: `Signal Garden preserves the complete binding quality contract: ${consensusBrief}`,
          spec: `${consensusBrief} Build one useful, responsive, accessible interaction. Claude and Codex each complete a distinct source-changing slice, verify it, and leave a reply-linked handoff.`,
          redactions: [{ value: 'Signal Garden', label: 'APP_NAME' }]
        }
      : null,
    tasks: round === 4
      ? [
          {
            id: 'claude-slice',
            publicTitle: 'First [FEATURE] slice',
            privateTitle: 'Claude source slice',
            publicDescription: 'Build and verify the first source-changing slice.',
            privateDescription: 'Claude owns a substantive Signal Garden implementation slice.',
            kind: 'implementation',
            impact: 'core',
            expectedOutcome: 'Claude delivers a runnable interaction slice with direct verification evidence.',
            acceptanceChecks: ['The Claude source slice exists and passes fixture verification.'],
            risk: 'medium',
            claimedBy: 'claude',
            files: ['app/claude-*.txt', 'app/index.html']
          },
          {
            id: 'codex-slice',
            publicTitle: 'Second [FEATURE] slice',
            privateTitle: 'Codex source slice',
            publicDescription: 'Build and verify the second source-changing slice.',
            privateDescription: 'Codex owns a substantive Signal Garden implementation slice.',
            kind: 'implementation',
            impact: 'core',
            expectedOutcome: 'Codex delivers a runnable interaction slice with direct verification evidence.',
            acceptanceChecks: ['The Codex source slice exists and passes fixture verification.'],
            risk: 'medium',
            claimedBy: 'codex',
            files: ['app/codex-*.txt', 'app/index.html']
          }
        ]
      : [],
    redactions: [{ value: 'Signal Garden', label: 'APP_NAME' }]
  }
}

function emitFixtureDialogue(
  options: ProcessRunOptions,
  agent: 'claude' | 'codex',
  round: number,
  prompt: string
): void {
  const capsule = fixtureDialogueCapsule(round, agent, prompt)
  options.onLine('stdout', agent === 'claude'
    ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: capsule })
    : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
}

async function markOwnedFixtureTaskDone(workspacePath: string, agent: 'claude' | 'codex'): Promise<void> {
  const boardPath = join(workspacePath, '.duo', 'board.json')
  const board = JSON.parse(await readFile(boardPath, 'utf8')) as { tasks?: Array<Record<string, unknown>> }
  board.tasks = (board.tasks ?? []).map((task) => task.claimedBy === agent
    ? { ...task, status: 'done' }
    : task)
  await writeFile(boardPath, JSON.stringify(board), 'utf8')
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
    private readonly stagedDispatchOnly = false,
    private readonly verifiedNoOpWorkRound?: number,
    private readonly timeboxedWorkRound?: number
  ) {}

  private quotaWithoutEditUsed = false

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const agent = agentOf(options)
    const round = roundOf(prompt)
    const stage = stageOf(prompt)
    const turnKind = turnKindOf(prompt)
    const resumed = options.command.args.includes('--resume') || options.command.args.includes('resume')
    this.calls.push({ agent, round, stage, resumed })
    this.commands.push(options.command)

    if (agent === 'codex' && stage === 'opening') {
      options.onLine('stdout', JSON.stringify({
        type: 'thread.started',
        thread_id: '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
      }))
    }

    if (stage === 'dialogue') emitFixtureDialogue(options, agent, round, prompt)

    if (stage === 'dialogue' || stage === 'opening' || stage === 'work' || stage === 'verdict' || stage === 'recovery') {
      const protocolRound = round + this.protocolRoundOffset
      const dispatchKind = stage === 'verdict'
        ? 'verdict'
        : stage === 'recovery'
          ? 'closing'
          : stage === 'work'
            ? 'evidence'
            : 'opening'
      const id = `${agent}-r${String(protocolRound)}-${stage}-${String(this.calls.length)}`
      await appendFile(join(options.command.cwd, '.duo', 'public', 'dispatches.jsonl'), `${JSON.stringify({
        id,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round: protocolRound,
        dispatchKind,
        claimKey: `round-${String(round)}`,
        replyTo: latestStatementIdOf(prompt) ?? `${agent === 'claude' ? 'codex' : 'claude'}-prior-statement`,
        publicText: `I ${stage === 'verdict' ? 'finished my slice and want the other agent to verify it' : 'will challenge the current [FEATURE] with concrete evidence'}.`,
        spoilerRisk: 0.02
      })}\n`, 'utf8')
      if (!this.stagedDispatchOnly || stage === 'dialogue' || stage === 'work') {
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

    if (stage === 'work' && (turnKind === 'code' || turnKind === 'repair') &&
      round !== this.noOpWorkRound && round !== this.earlyOpeningRound) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), `${agent} durable work\n`, 'utf8')
      await writeFile(
        join(options.command.cwd, 'app', 'index.html'),
        qualityBackedFixtureHtml(humanBriefFromPrompt(prompt)),
        'utf8'
      )
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${agent}-slice.txt`, kind: 'update' }] }
      }))
    }

    if (stage === 'work' && turnKind === 'code') {
      await markOwnedFixtureTaskDone(options.command.cwd, agent)
    }

    if (stage === 'work' && (round !== this.noOpWorkRound || turnKind === 'review')) {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }

    if (stage === 'work' && round === this.noOpWorkRound && round === this.verifiedNoOpWorkRound) {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'npm.cmd test -- --run; if ($LASTEXITCODE -eq 0) { npm.cmd run build }; exit $LASTEXITCODE',
          exit_code: 0
        }
      }))
    }

    if (stage === 'opening' && round === this.earlyOpeningRound) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-early-slice.txt`), `${agent} moved from position into durable implementation\n`, 'utf8')
      await writeFile(
        join(options.command.cwd, 'app', 'index.html'),
        qualityBackedFixtureHtml(humanBriefFromPrompt(prompt)),
        'utf8'
      )
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
    if (stage === 'work' && round === this.timeboxedWorkRound) {
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

class ExhaustedClaudeWorkRunner implements ProcessRunnerPort {
  readonly calls: Array<{
    agent: 'claude' | 'codex'
    round: number
    stage: string
    targetAttempt?: number
  }> = []
  leaseCancels = 0
  targetRound: number | undefined
  private targetAttempts = 0
  private readonly pending = new Map<string, (value: ProcessRunResult) => void>()

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const agent = agentOf(options)
    const round = roundOf(prompt)
    const stage = stageOf(prompt)
    const turnKind = turnKindOf(prompt)

    if (stage === 'dialogue') emitFixtureDialogue(options, agent, round, prompt)

    if (stage === 'dialogue' || stage === 'opening' || stage === 'work' || stage === 'verdict' || stage === 'recovery') {
      const dispatchKind = stage === 'verdict'
        ? 'verdict'
        : stage === 'recovery'
          ? 'closing'
          : stage === 'work'
            ? 'evidence'
            : 'opening'
      const id = `${agent}-r${String(round)}-${stage}-${String(this.calls.length + 1)}`
      await appendFile(join(options.command.cwd, '.duo', 'public', 'dispatches.jsonl'), `${JSON.stringify({
        id,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        dispatchKind,
        claimKey: `round-${String(round)}`,
        replyTo: latestStatementIdOf(prompt) ?? `${agent === 'claude' ? 'codex' : 'claude'}-prior-statement`,
        publicText: 'I will challenge the current [FEATURE] with concrete evidence.',
        spoilerRisk: 0.02
      })}\n`, 'utf8')
      await appendFile(join(options.command.cwd, '.duo', 'public', 'opinions.jsonl'), `${JSON.stringify({
        id: `${id}-opinion`,
        type: 'opinion',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        topic: stage,
        tone: 'confident',
        publicText: 'The current [FEATURE] can survive if both implementation slices stay testable.',
        spoilerRisk: 0.02
      })}\n`, 'utf8')
    }

    const isTarget = stage === 'work' && agent === 'claude' &&
      (this.targetRound === undefined || this.targetRound === round)
    if (isTarget) {
      this.targetRound ??= round
      this.targetAttempts += 1
      const attempt = this.targetAttempts
      this.calls.push({ agent, round, stage, targetAttempt: attempt })
      return await new Promise<ProcessRunResult>((resolve) => {
        this.pending.set(options.id, resolve)
        if (attempt <= 2) {
          for (let step = 1; step <= 4; step += 1) {
            options.onLine('stdout', JSON.stringify({
              type: 'assistant',
              message: { id: `claude-${String(round)}-${String(attempt)}-${String(step)}`, content: [] }
            }))
          }
          return
        }

        // An exhausted restored guard cancels on this harmless provider record
        // before the microtask can land source. A correctly refreshed guard lets
        // the same logical turn continue from the durable workspace.
        options.onLine('stdout', JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: `claude-fresh-${String(attempt)}`
        }))
        queueMicrotask(() => {
          if (!this.pending.has(options.id)) return
          void (async () => {
            await mkdir(join(options.command.cwd, 'app'), { recursive: true })
            const file = `claude-resumed-${String(round)}.txt`
            await writeFile(join(options.command.cwd, 'app', file), 'fresh explicit-resume capsule\n', 'utf8')
            await writeFile(
              join(options.command.cwd, 'app', 'index.html'),
              qualityBackedFixtureHtml(humanBriefFromPrompt(prompt)),
              'utf8'
            )
            await markOwnedFixtureTaskDone(options.command.cwd, agent)
            options.onLine('stdout', JSON.stringify({
              type: 'assistant',
              message: {
                id: `claude-${String(round)}-${String(attempt)}-write`,
                content: [{ type: 'tool_use', id: 'write-resumed', name: 'Write' }]
              }
            }))
            options.onLine('stdout', JSON.stringify({
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: 'write-resumed' }] }
            }))
            options.onLine('stdout', JSON.stringify({
              type: 'item.completed',
              item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
            }))
            this.pending.delete(options.id)
            resolve(this.success())
          })()
        })
      })
    }

    this.calls.push({ agent, round, stage })
    if (stage === 'work' && (turnKind === 'code' || turnKind === 'repair')) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      const file = `${agent}-${String(round)}-slice.txt`
      await writeFile(join(options.command.cwd, 'app', file), `${agent} durable work\n`, 'utf8')
      await writeFile(
        join(options.command.cwd, 'app', 'index.html'),
        qualityBackedFixtureHtml(humanBriefFromPrompt(prompt)),
        'utf8'
      )
      if (turnKind === 'code') await markOwnedFixtureTaskDone(options.command.cwd, agent)
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${file}`, kind: 'update' }] }
      }))
    }
    if (stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }
    return this.success()
  }

  cancel(id: string, reason: 'user' | 'lease' = 'user'): Promise<boolean> {
    const resolve = this.pending.get(id)
    if (!resolve) return Promise.resolve(false)
    this.pending.delete(id)
    if (reason === 'lease') this.leaseCancels += 1
    const now = new Date().toISOString()
    resolve({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      cancelled: true,
      cancelReason: reason,
      startedAt: now,
      finishedAt: now
    })
    return Promise.resolve(true)
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(async (id) => await this.cancel(id, 'user')))
  }

  private success(): ProcessRunResult {
    const now = new Date().toISOString()
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      startedAt: now,
      finishedAt: now
    }
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

class ArtifactCeilingExpiryRunner implements ProcessRunnerPort {
  constructor(private readonly expire: () => void) {}

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    await mkdir(join(options.command.cwd, 'app'), { recursive: true })
    await writeFile(
      join(options.command.cwd, 'app', 'index.html'),
      '<!doctype html><html><head><title>Grace Proof</title></head><body><main>Ready</main></body></html>',
      'utf8'
    )
    this.expire()
    const now = new Date().toISOString()
    return {
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      cancelled: false,
      startedAt: now,
      finishedAt: now
    }
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
    const turnKind = turnKindOf(prompt)
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

    if (stage === 'dialogue') emitFixtureDialogue(options, agent, round, prompt)
    if (stage === 'dialogue' || stage === 'opening' || stage === 'work' || stage === 'verdict' || stage === 'recovery') {
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-r${String(round)}-${stage}-${String(this.calls.length)}`,
        type: 'agent.dispatch', agent, targetAgent: agent === 'claude' ? 'codex' : 'claude', round,
        dispatchKind: stage === 'verdict' ? 'verdict' : stage === 'recovery' ? 'closing' : stage === 'work' ? 'evidence' : 'opening',
        replyTo: latestStatementIdOf(prompt) ?? `${agent === 'claude' ? 'codex' : 'claude'}-prior-statement`,
        publicText: 'I think the shared [FEATURE] should stay bounded because the evidence is testable.', spoilerRisk: 0.02
      }))
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-r${String(round)}-${stage}-opinion-${String(this.calls.length)}`,
        type: 'opinion', agent, targetAgent: agent === 'claude' ? 'codex' : 'claude', round,
        tone: 'collaborative', publicText: 'The shared [FEATURE] remains a practical direction.', spoilerRisk: 0.02
      }))
    }
    if (stage === 'work' && (turnKind === 'code' || turnKind === 'repair')) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), 'fresh-session source work\n', 'utf8')
      await writeFile(
        join(options.command.cwd, 'app', 'index.html'),
        qualityBackedFixtureHtml(humanBriefFromPrompt(prompt)),
        'utf8'
      )
      if (turnKind === 'code') await markOwnedFixtureTaskDone(options.command.cwd, agent)
    }
    if (stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
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

function verifiedArtifactSupervisor(): SupervisorVerifierPort {
  return {
    verify: vi.fn(() => Promise.resolve({
      outcome: 'passed' as const,
      summary: 'The exact fixture revision passed independent release verification.',
      checks: [
        { id: 'script:test', label: 'npm run test', outcome: 'passed' as const },
        { id: 'browser:compact', label: 'Compact viewport render', outcome: 'passed' as const },
        { id: 'browser:full', label: 'Full-screen viewport render', outcome: 'passed' as const },
        { id: 'browser:interaction', label: 'Rendered interaction smoke', outcome: 'passed' as const }
      ]
    }))
  }
}

describe('broadcast turn orchestration', () => {
  it('does not loop staged verdict recovery when the agent files a real handoff without a duplicate opinion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-dispatch-only-verdict-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, undefined, 0, true)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier: verifiedArtifactSupervisor(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Build and cross-review a bounded app while keeping staged handoffs concise.',
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

    expect(runner.calls.some((call) => call.stage === 'recovery')).toBe(false)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
  })

  it('checkpoints a timed-out work lease and advances without rerunning the expensive stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-broadcast-turn-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, undefined, 0, false, undefined, 5)
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
    expect(snapshot).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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
      maxTurns: 8,
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
    expect(snapshot).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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
      maxTurns: 8,
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
    expect(restored.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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
      maxTurns: 8,
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
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
  })

  it('stamps agent-authored protocol records onto the active scheduled turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-protocol-round-stamp-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, undefined, 50)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier: verifiedArtifactSupervisor(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Keep provider-authored round labels from escaping the scheduled battle.',
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

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.round).toBeLessThanOrEqual(snapshot?.totalTurns ?? 0)
    expect(snapshot?.events.filter((event) => event.type === 'agent.dispatch').every((event) =>
      event.round <= (snapshot.totalTurns ?? 0)
    )).toBe(true)
  })

  it('allows a review lease to conclude without a redundant source edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-review-noop-work-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, 8)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier: verifiedArtifactSupervisor(),
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

  it('uses one exact-revision supervisor check to recover clean no-change work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-missing-work-evidence-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, 6)
    const supervisorVerifier = {
      verify: vi.fn().mockResolvedValue({
        outcome: 'passed' as const,
        summary: 'Exact source revision passed independent verification.',
        checks: [{ id: 'script:build', label: 'npm run build', outcome: 'passed' as const }]
      })
    }
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Require concrete verification before this work turn can advance.',
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

    expect(supervisorVerifier.verify).toHaveBeenCalledTimes(1)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
    expect(orchestrator.getSnapshot(result.runId)?.releaseStatus).toBe('partial')
  })

  it('pauses truthfully after one failed exact-revision no-change verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-missing-work-verification-failed-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, 6)
    const supervisorVerifier = {
      verify: vi.fn().mockResolvedValue({
        outcome: 'failed' as const,
        summary: 'Exact source revision failed independent verification.',
        checks: [{ id: 'script:test', label: 'npm run test', outcome: 'failed' as const }]
      })
    }
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Pause honestly if the exact preserved source cannot be verified.',
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

    expect(supervisorVerifier.verify).toHaveBeenCalledTimes(1)
    expect(runner.calls.filter((call) => call.round === 6 && call.stage === 'work')).toHaveLength(1)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'verification-failed', stage: 'work', resumable: true }
    })
    expect(orchestrator.getSnapshot(result.runId)?.pause?.provider).toBeUndefined()
  })

  it('advances a no-change work turn when fresh guarded verification passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-guarded-verification-evidence-'))
    const runner = new TimeboxedWorkRunner(undefined, false, undefined, 6, 0, false, 6)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Accept fresh tests and build evidence without inventing a redundant edit.',
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

    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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

  it('preserves a repairable partial artifact when the overall ceiling expires inside a stage', async () => {
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
    expect(snapshot).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
    expect(snapshot?.releaseStatus).toBe('partial')
    expect(snapshot?.events.some((event) => event.topic === 'run-ceiling')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  it('reserves a bounded supervisor verification grace window after the agent run ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-run-ceiling-verification-grace-'))
    let now = Date.parse('2026-07-10T20:00:00.000Z')
    const supervisorVerifier = {
      verify: vi.fn().mockResolvedValue({
        outcome: 'passed' as const,
        summary: 'The final artifact passed inside the supervisor grace window.',
        checks: [{ id: 'artifact', label: 'Loadable HTML artifact', outcome: 'passed' as const }]
      })
    }
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: new ArtifactCeilingExpiryRunner(() => { now += 61_000 }),
      supervisorVerifier,
      healthProvider: healthyAgents,
      now: () => now,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Verify the preserved artifact even after the agent ceiling closes.',
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

    expect(supervisorVerifier.verify).toHaveBeenCalledTimes(1)
    const verificationRequest = vi.mocked(supervisorVerifier.verify).mock.calls[0]?.[0] as {
      timeoutMs?: number
      abortSignal?: AbortSignal
    } | undefined
    expect(verificationRequest?.timeoutMs).toBe(600_000)
    expect(verificationRequest?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(orchestrator.getSnapshot(result.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
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
      supervisorVerifier: verifiedArtifactSupervisor(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const result = await orchestrator.start({
      prompt: 'Keep provider continuity but recover safely if resume is unavailable.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
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

  it('starts a fresh bounded Claude capsule when explicitly resuming an exhausted work receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-explicit-capsule-resume-'))
    const workspaceRoot = join(root, 'workspaces')
    const runtimeRoot = join(root, 'runtime')
    const runner = new ExhaustedClaudeWorkRunner()
    const first = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(workspaceRoot)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5,
      runtimeRoot
    })

    const started = await first.start({
      prompt: 'Resume one preserved Claude repair turn without replaying the battle.',
      workspaceRoot,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      claudeWorkInferenceLimit: 3,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await first.waitForSettled(started.runId)

    expect(first.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'stage-timeout', provider: 'claude', stage: 'work', resumable: true },
      turnStage: {
        agent: 'claude',
        stage: 'work',
        inferenceSteps: 4,
        inferenceLimit: 3,
        continuationCount: 1
      }
    })
    expect(runner.calls.filter((call) => call.targetAttempt !== undefined)).toHaveLength(2)
    expect(runner.leaseCancels).toBe(2)
    expect(first.getSnapshot(started.runId)?.events.filter((event) => event.topic === 'work-capsule-continuation')).toHaveLength(1)

    const manifest = JSON.parse(await readFile(
      join(runtimeRoot, started.runId, 'run-manifest.json'),
      'utf8'
    )) as { cursor: { stageReceipt?: Record<string, unknown> } }
    expect(manifest.cursor.stageReceipt).toMatchObject({
      agent: 'claude',
      stage: 'work',
      inferenceSteps: 4,
      inferenceLimit: 3,
      continuationCount: 1
    })

    const resumedReceipts: Array<{ inferenceSteps?: number; continuationCount?: number }> = []
    const restored = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(workspaceRoot)),
      onSnapshot: (snapshot) => {
        if (snapshot.status === 'running' && snapshot.turnStage?.agent === 'claude' &&
          snapshot.turnStage.stage === 'work') {
          resumedReceipts.push({
            inferenceSteps: snapshot.turnStage.inferenceSteps,
            continuationCount: snapshot.turnStage.continuationCount
          })
        }
      },
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5,
      runtimeRoot
    })
    await expect(restored.restore()).resolves.toBe(1)
    await restored.resume(started.runId)
    await restored.waitForSettled(started.runId)

    expect(runner.calls.filter((call) => call.targetAttempt !== undefined)).toHaveLength(3)
    expect(runner.leaseCancels).toBe(2)
    expect(resumedReceipts).toContainEqual({ inferenceSteps: 0, continuationCount: 1 })
    await expect(readFile(
      join(started.workspacePath, 'app', `claude-resumed-${String(runner.targetRound)}.txt`),
      'utf8'
    )).resolves.toContain('fresh explicit-resume capsule')
    expect(restored.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'quality-repair', resumable: true }
    })
  })

  it('refreshes the exhausted Claude capsule on the same-process Resume button path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-same-process-capsule-resume-'))
    const workspaceRoot = join(root, 'workspaces')
    const runtimeRoot = join(root, 'runtime')
    const runner = new ExhaustedClaudeWorkRunner()
    let collectResumedReceipts = false
    const resumedReceipts: Array<{ inferenceSteps?: number; continuationCount?: number }> = []
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(workspaceRoot)),
      onSnapshot: (snapshot) => {
        if (collectResumedReceipts && snapshot.status === 'running' &&
          snapshot.turnStage?.agent === 'claude' && snapshot.turnStage.stage === 'work') {
          resumedReceipts.push({
            inferenceSteps: snapshot.turnStage.inferenceSteps,
            continuationCount: snapshot.turnStage.continuationCount
          })
        }
      },
      processRunner: runner,
      supervisorVerifier: verifiedArtifactSupervisor(),
      healthProvider: healthyAgents,
      protocolPollMs: 5,
      runtimeRoot
    })
    const started = await orchestrator.start({
      prompt: 'Resume this same preserved Claude turn from the live battle window.',
      workspaceRoot,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 43_200,
      claudeWorkInferenceLimit: 3,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'stage-timeout', provider: 'claude', stage: 'work' },
      turnStage: { inferenceSteps: 4, inferenceLimit: 3, continuationCount: 1 }
    })

    collectResumedReceipts = true
    await orchestrator.resume(started.runId)
    await orchestrator.waitForSettled(started.runId)

    expect(runner.calls.filter((call) => call.targetAttempt !== undefined)).toHaveLength(3)
    expect(runner.leaseCancels).toBe(2)
    expect(resumedReceipts).toContainEqual({ inferenceSteps: 0, continuationCount: 1 })
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })
})
