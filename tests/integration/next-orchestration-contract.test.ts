import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  RunOrchestrator as BaseRunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import { ProcessRunner, type ProcessRunOptions, type ProcessRunResult } from '../../src/main/process/process-runner'
import type { AgentCommand } from '../../src/main/process/command-builder'
import { GitManager } from '../../src/main/git/git-manager'
import { defaultSettings } from '../../src/main/settings/settings-store'
import { sealSeriousMissionSpecification } from '../../src/main/workspace/serious-mission-contract'
import type { StartRunRequest, ToolHealth } from '../../src/shared/types'

class RunOrchestrator extends BaseRunOrchestrator {
  constructor(options: ConstructorParameters<typeof BaseRunOrchestrator>[0]) {
    super({ ...options, testOnlyMinimumTurns: 2 })
  }
}

const availableAgents: ToolHealth[] = [
  { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex test', checkedAt: '2026-07-10T10:00:00.000Z' },
  { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude test', checkedAt: '2026-07-10T10:00:00.000Z' },
  { id: 'git', label: 'Git', command: 'git', available: true, version: 'git test', checkedAt: '2026-07-10T10:00:00.000Z' }
]

function request(root: string, maxTurns = 12): StartRunRequest {
  return {
    prompt: 'Build one private, surprising, runnable interaction together.',
    workspaceRoot: root,
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    maxTurns,
    maxRepairLoops: 2,
    turnTimeoutSeconds: 120,
    runTimeoutSeconds: 43_200,
    dangerousModeConfirmed: false,
    unsafeWorkspaceRootConfirmed: false
  }
}

function completed(): ProcessRunResult {
  const now = new Date().toISOString()
  return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
}

function promptOf(command: AgentCommand): string {
  return (command as AgentCommand & { stdin?: string }).stdin ?? command.args.at(-1) ?? ''
}

describe('next Real Mode orchestration contracts', () => {
  it('forwards AgentCommand stdin to a shell-free child process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-stdin-process-'))
    const output: string[] = []
    const runner = new ProcessRunner()
    const prompt = 'stdin prompt with spaces and punctuation: [FEATURE].'
    const script = [
      "process.stdin.setEncoding('utf8')",
      "let body = ''",
      "process.stdin.on('data', chunk => { body += chunk })",
      "process.stdin.on('end', () => console.log(body || 'MISSING_STDIN'))"
    ].join(';')
    const command = {
      bin: process.execPath,
      args: ['-e', script],
      cwd: root,
      stdin: prompt
    } as AgentCommand & { stdin: string }

    await runner.run({
      id: 'stdin-forwarding-contract',
      command,
      timeoutMs: 5_000,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      onLine: (_stream, line) => output.push(line)
    })

    expect(output).toEqual([prompt])
  })

  it('requires a verified Git tool before any Real Mode provider call starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-real-git-preflight-'))
    const runner = new PromptlessClaudeRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents.filter((tool) => tool.id !== 'git'))
    })

    const started = await orchestrator.start(request(root, 2))
    await orchestrator.waitForSettled(started.runId)

    expect(runner.commands).toHaveLength(0)
    expect(orchestrator.getSnapshot(started.runId)).toMatchObject({
      status: 'paused',
      pause: { reason: 'cli-incompatible', resumable: true }
    })
    expect(orchestrator.getSnapshot(started.runId)?.pause?.message).toMatch(/git checkpoint/i)
  })

  it('never advances to the other agent after the opener returns a promptless no-task response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-promptless-turn-'))
    const runner = new PromptlessClaudeRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 2))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)

    const opener = runner.commands[0]?.bin
    const other = opener === 'claude' ? 'codex' : 'claude'
    expect(opener === 'claude' || opener === 'codex').toBe(true)
    expect(runner.commands.slice(1).every((command) => command.bin === opener)).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'agent.started' && event.agent === other)).toBe(false)
    expect(snapshot?.status).not.toBe('reveal-ready')
  })

  it('runs one deep integration review and one reciprocal compact review before optional repairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-adaptive-turns-'))
    const runner = new EvidenceCompleteRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 12))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)
    const counts = snapshot?.events.reduce(
      (result, event) => event.type === 'agent.started' && (event.agent === 'claude' || event.agent === 'codex')
        ? { ...result, [event.agent]: result[event.agent] + 1 }
        : result,
      { claude: 0, codex: 0 }
    ) ?? { claude: 0, codex: 0 }

    const executed = runner.commands.map((command) => {
      const prompt = promptOf(command)
      return {
        round: Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? 0),
        stage: prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase(),
        kind: prompt.match(/^Turn:\s*(\S+)/mi)?.[1]?.toLowerCase(),
        prompt
      }
    })
    expect(executed).toEqual(expect.arrayContaining([
      expect.objectContaining({ round: 6, stage: 'work', kind: 'code' }),
      expect.objectContaining({ round: 7, stage: 'work', kind: 'review' })
    ]))
    expect(executed.some((call) => call.round > 7)).toBe(false)
    expect(executed.find((call) => call.round === 7 && call.stage === 'work')?.prompt)
      .toContain('The supervisor builds the reveal packet from verified evidence')
    expect(Object.values(counts).sort()).toEqual([3, 4])
    expect(snapshot?.status).toBe('reveal-ready')
    expect(snapshot?.releaseStatus).toBe('ready')
    expect((await orchestrator.reveal(started.runId)).revealPacket?.status).toBe('ready')
  })

  it('builds a factual ready reveal from supervisor evidence when the agents omit the final packet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-supervisor-ready-reveal-'))
    const runner = new EvidenceCompleteRunner({ omitRevealPacket: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const revealed = await orchestrator.reveal(started.runId)
    const packet = revealed.revealPacket

    expect(packet).toMatchObject({
      appName: 'Ready',
      status: 'ready',
      runCommand: 'Open app/index.html directly in a browser.',
      appPath: 'app/index.html',
      knownIssues: []
    })
    expect(packet?.whatWorked).toEqual(expect.arrayContaining([
      'First build slice',
      'Second build slice'
    ]))
    expect(packet?.agentQuotes.claude).toMatch(/Claude records a concrete, spoiler-safe contribution/i)
    expect(packet?.agentQuotes.codex).toMatch(/Codex records a concrete, spoiler-safe contribution/i)
    expect(packet?.agentDramaSummary.join(' ')).toMatch(/Claude|Codex/i)
    await expect(readFile(join(started.workspacePath, '.duo', 'sealed', 'reveal_packet.json'), 'utf8'))
      .resolves.toContain('"status": "ready"')
  })

  it('preserves the partial reveal fallback when an objective release gate is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-supervisor-partial-reveal-'))
    const runner = new EvidenceCompleteRunner({ omitRevealPacket: true, missingCodexTask: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const revealed = await orchestrator.reveal(started.runId)

    expect(revealed.revealPacket?.status).toBe('partial')
    expect(revealed.revealPacket?.knownIssues).toContain('No valid reveal packet was produced before the turn limit.')
    expect(revealed.revealPacket?.agentDramaSummary).toContain(
      'The orchestrator preserved the partial workspace rather than inventing a successful result.'
    )
  })

  it('uses one fresh provider call for every source contribution without replaying session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-turn-scoped-session-'))
    const runner = new EvidenceCompleteRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const sourceCalls = runner.commands.map((command) => ({
      command,
      prompt: promptOf(command),
      round: Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0),
      stage: promptOf(command).match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    })).filter((call) => call.round >= 5)

    expect(sourceCalls.map((call) => `${String(call.round)}:${call.stage}`)).toEqual(['5:work', '6:work', '7:work'])
    for (const contribution of sourceCalls) {
      expect(contribution.command.args).not.toContain('--resume')
      expect(contribution.command.args).not.toContain('resume')
      if (contribution.command.bin === 'claude') {
        expect(contribution.command.args).toContain('--no-session-persistence')
        expect(contribution.command.args).toEqual(expect.arrayContaining([
          '--tools', 'Read,Glob,Grep,Edit,Write,Bash'
        ]))
      } else {
        expect(contribution.command.args).toContain('--ephemeral')
      }
    }
  })

  it('retries one transient source checkpoint failure without repeating provider work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-checkpoint-recovery-'))
    const runner = new EvidenceCompleteRunner()
    let injectedFailure = false
    const checkpointSpy = vi.spyOn(GitManager.prototype, 'checkpoint').mockImplementation(function (this: GitManager, workspacePath, message) {
      void this
      void workspacePath
      if (!injectedFailure && /checkpoint lean round 5 .+ code(?:$|\s)/i.test(message)) {
        injectedFailure = true
        return Promise.resolve({ ok: false, detail: 'Synthetic checkpoint failure.' })
      }
      return Promise.resolve({ ok: true, commit: 'a'.repeat(40) })
    })
    try {
      const orchestrator = new RunOrchestrator({
        getSettings: () => Promise.resolve(defaultSettings(root)),
        onSnapshot: () => undefined,
        processRunner: runner,
        protocolPollMs: 5,
        healthProvider: () => Promise.resolve(availableAgents)
      })

      const started = await orchestrator.start(request(root, 6))
      await orchestrator.waitForSettled(started.runId)
      expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
      const roundFiveWorkBefore = runner.commands.filter((command) =>
        /^Round:\s*5$/mi.test(promptOf(command)) && /^Stage:\s*work$/mi.test(promptOf(command))
      ).length
      expect(roundFiveWorkBefore).toBe(1)
      expect(runner.commands.some((command) => /^Stage:\s*verdict$/mi.test(promptOf(command)))).toBe(false)
    } finally {
      checkpointSpy.mockRestore()
    }
  })

  it.each([
    ['intact', false, 'ready'],
    ['tampered', true, 'partial']
  ] as const)('binds and enforces an %s serious brief through a complete Real Mode run', async (_label, tamper, expectedStatus) => {
    const root = await mkdtemp(join(tmpdir(), `duo-serious-real-${tamper ? 'tampered' : 'intact'}-`))
    const runtimeRoot = await mkdtemp(join(tmpdir(), `duo-serious-real-runtime-${tamper ? 'tampered' : 'intact'}-`))
    const brief = 'Build an accessible invoice dashboard with offline CSV import and a keyboard-first review queue.'
    const runner = new SeriousEvidenceRunner(brief, tamper)
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents),
      runtimeRoot
    })

    const started = await orchestrator.start({ ...request(root, 8), prompt: brief, missionProfile: 'serious' })
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)
    const specification = await readFile(join(started.workspacePath, '.duo', 'sealed', 'spec.md'), 'utf8')

    expect(specification).toContain(brief)
    expect(specification).toMatch(/Acceptance checks/iu)
    expect(snapshot?.releaseStatus).toBe(expectedStatus)
    if (tamper) {
      expect((await orchestrator.reveal(started.runId)).revealPacket?.knownIssues.join(' '))
        .toMatch(/serious mission|binding chain/i)
    }
  })

  it('suspends a balanced run instead of producing a one-agent takeover artifact after quota', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-one-agent-takeover-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-one-agent-takeover-runtime-'))
    const runner = new EvidenceCompleteRunner({ quotaCodexCode: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents),
      runtimeRoot
    })

    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)

    expect(snapshot?.status).toBe('paused')
    expect(snapshot?.pause).toMatchObject({ reason: 'provider-quota', provider: 'codex', resumable: true })
    expect(snapshot?.releaseStatus).toBeUndefined()
    await expect(orchestrator.reveal(started.runId)).rejects.toThrow(/not ready/i)

    const restored = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents),
      runtimeRoot
    })
    await expect(restored.restore()).resolves.toBe(1)
    await restored.resume(started.runId)
    await restored.waitForSettled(started.runId)
    expect(restored.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('downgrades a ready artifact when one assigned agent task never completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-incomplete-owned-task-'))
    const runner = new EvidenceCompleteRunner({ missingCodexTask: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const revealed = await orchestrator.reveal(started.runId)

    expect(revealed.revealPacket?.status).toBe('partial')
    expect(revealed.revealPacket?.knownIssues.join(' ')).toMatch(/completed owned task/i)
  })

  it('continues into reserved repair capacity when independent supervisor verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-post-review-verification-'))
    const runner = new EvidenceCompleteRunner()
    const supervisorVerifier = {
      verify: vi.fn()
        .mockResolvedValueOnce({
          outcome: 'failed' as const,
          summary: 'Synthetic supervisor build failure.',
          checks: [{ id: 'script:build', label: 'npm run build', outcome: 'failed' as const }]
        })
        .mockResolvedValue({
          outcome: 'passed' as const,
          summary: 'Synthetic supervisor repair proof passed.',
          checks: [{ id: 'script:build', label: 'npm run build', outcome: 'passed' as const }]
        })
    }
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 10))
    await orchestrator.waitForSettled(started.runId)
    const executedRounds = runner.commands.map((command) =>
      Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    )

    expect(executedRounds).toContain(8)
    expect(executedRounds).not.toContain(9)
    expect(supervisorVerifier.verify).toHaveBeenCalledTimes(2)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('invalidates a typed verification pass when a later protocol build failure lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-protocol-verification-failure-'))
    const runner = new EvidenceCompleteRunner({ protocolFinalFailure: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    // Stop at the review boundary so this assertion isolates the ordering rule:
    // a protocol failure that lands after the typed pass must invalidate that
    // pass. Separate repair-pair coverage proves a later successful verifier can
    // legitimately restore readiness.
    const started = await orchestrator.start(request(root, 8))
    await orchestrator.waitForSettled(started.runId)
    const snapshot = orchestrator.getSnapshot(started.runId)
    expect(snapshot?.events.some((event) => event.id === 'protocol-final-failure')).toBe(true)
    expect(snapshot?.releaseStatus).not.toBe('ready')
  })

  it('accepts Claude review verification only from its matching successful tool result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-claude-verification-result-'))
    const runner = new EvidenceCompleteRunner({ claudeVerificationStream: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 12))
    await orchestrator.waitForSettled(started.runId)
    const executedRounds = runner.commands.map((command) =>
      Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    )

    expect(executedRounds).toContain(7)
    expect(executedRounds.some((round) => round > 7)).toBe(false)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('lets the latest failed verifier invalidate an earlier pass at the current app revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-latest-verification-failed-'))
    const runner = new EvidenceCompleteRunner({ finalReviewVerificationOrder: 'pass-then-fail' })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 10))
    await orchestrator.waitForSettled(started.runId)
    const executedRounds = runner.commands.map((command) =>
      Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    )

    expect(executedRounds).toContain(8)
    expect(executedRounds).not.toContain(9)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('lets a later successful verifier recover after an earlier failure at the current app revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-latest-verification-passed-'))
    const runner = new EvidenceCompleteRunner({ finalReviewVerificationOrder: 'fail-then-pass' })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 10))
    await orchestrator.waitForSettled(started.runId)
    const executedRounds = runner.commands.map((command) =>
      Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    )

    expect(executedRounds.some((round) => round > 7)).toBe(false)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })

  it('uses accepted repair evidence to recover a timeboxed cross-review without counting the timebox itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-timeboxed-cross-review-'))
    const runner = new EvidenceCompleteRunner({ timeboxFirstReview: true })
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 10))
    await orchestrator.waitForSettled(started.runId)
    const executedRounds = runner.commands.map((command) =>
      Number(promptOf(command).match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    )

    expect(executedRounds).toContain(8)
    expect(executedRounds).toContain(9)
    expect(orchestrator.getSnapshot(started.runId)?.releaseStatus).toBe('ready')
    expect((await orchestrator.reveal(started.runId)).revealPacket?.status).toBe('ready')
  })

  it('injects the latest opponent statement and ID into the next agent prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-dialogue-link-'))
    const runner = new EvidenceCompleteRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 2))
    await orchestrator.waitForSettled(started.runId)
    const replyPrompt = promptOf(runner.commands[1]!)
    const openingAgent = runner.commands[0]?.bin.includes('claude') ? 'claude' : 'codex'

    expect(replyPrompt).toContain(`${openingAgent}-r1-opening`)
    expect(replyPrompt).toContain(EvidenceCompleteRunner.openingPosition)
    expect(replyPrompt).toMatch(/reply|respond|answer/i)
  })

  it('uses the newest private staged handoff instead of stale ideation context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-fresh-staged-handoff-'))
    const runner = new FreshHandoffRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      protocolPollMs: 5,
      healthProvider: () => Promise.resolve(availableAgents)
    })

    const started = await orchestrator.start(request(root, 7))
    await orchestrator.waitForSettled(started.runId)
    const reviewOpening = runner.commands
      .map(promptOf)
      .find((prompt) => /^Round:\s*7$/mi.test(prompt) && /^Stage:\s*work$/mi.test(prompt))

    expect(reviewOpening).toMatch(/(?:Claude|Codex) newest private verdict from round 6\./)
    expect(reviewOpening).not.toMatch(/(?:Claude|Codex) stale consensus context from round 4\./)
    expect(reviewOpening).not.toContain('UNBOUNDED_HANDOFF_TAIL')
    expect(reviewOpening).not.toContain('FUTURE_ROUND_HANDOFF')
    expect(reviewOpening).not.toContain('WRONG_RUN_HANDOFF')
  })
})

class PromptlessClaudeRunner implements ProcessRunnerPort {
  readonly commands: AgentCommand[] = []

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.commands.push(options.command)
    options.onLine('stdout', JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I do not see a task description. What would you like me to do?',
      num_turns: 1,
      stop_reason: 'end_turn'
    }))
    return Promise.resolve(completed())
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class EvidenceCompleteRunner implements ProcessRunnerPort {
  static readonly openingPosition = 'I think the [FEATURE] should stay small because one testable interaction will survive the reveal.'
  readonly commands: AgentCommand[] = []
  private quotaTriggered = false

  constructor(private readonly options: {
    staleFinalReview?: boolean
    timeboxFirstReview?: boolean
    claudeVerificationStream?: boolean
    finalReviewVerificationOrder?: 'pass-then-fail' | 'fail-then-pass'
    quotaCodexCode?: boolean
    protocolFinalFailure?: boolean
    missingCodexTask?: boolean
    omitRevealPacket?: boolean
  } = {}) {}

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.commands.push(options.command)
    const prompt = promptOf(options.command)
    const turn = Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? this.commands.length)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    const latestStatementId = prompt.match(/^LATEST .+ STATEMENT\r?\n([^:\r\n]+):/mi)?.[1]?.trim()
    const agent = options.command.bin === 'claude' ? 'claude' : 'codex'
    const opponent = agent === 'claude' ? 'codex' : 'claude'
    const dispatchLabel = turn === 1 && stage === 'dialogue' ? 'opening' : stage ?? 'reply'
    const id = `${agent}-r${String(turn)}-${dispatchLabel}`
    const publicText = turn === 1
      ? EvidenceCompleteRunner.openingPosition
      : `I answer the last position with concrete [FEATURE] evidence and a narrower shared next move.`
    options.onLine('stdout', JSON.stringify({
      id,
      type: 'agent.dispatch',
      agent,
      targetAgent: opponent,
      round: turn,
      dispatchKind: stage === 'verdict' ? 'verdict' : turn === 1 ? 'opening' : stage === 'work' ? 'update' : 'counter',
      claimKey: 'shared-scope',
      ...(latestStatementId ? { replyTo: latestStatementId } : {}),
      publicText,
      spoilerRisk: 0.02
    }))
    options.onLine('stdout', JSON.stringify({
      id: `${agent}-r${String(turn)}-${stage ?? 'dialogue'}-opinion`,
      type: 'opinion',
      agent,
      targetAgent: opponent,
      round: turn,
      topic: 'shared-build',
      tone: 'collaborative',
      publicText: `${agent === 'claude' ? 'Claude' : 'Codex'} records a concrete, spoiler-safe contribution.`,
      spoilerRisk: 0.02
    }))
    const codeWork = /Turn:\s*code/i.test(prompt) && stage === 'work'
    const codexCodeQuota = this.options.quotaCodexCode && !this.quotaTriggered && agent === 'codex' && codeWork
    if (codeWork && !codexCodeQuota) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), `${agent} source contribution\n`, 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${agent}-slice.txt`, kind: 'update' }] }
      }))
    }

    if (codexCodeQuota) {
      this.quotaTriggered = true
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', 'codex-preserved-before-quota.txt'), 'durable source before quota\n', 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'app/codex-preserved-before-quota.txt', kind: 'update' }] }
      }))
      options.onLine('stdout', JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected' }
      }))
    }

    if (/Turn:\s*review/i.test(prompt) && stage === 'work') {
      if (turn === 7 && this.options.staleFinalReview) {
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
        }))
        await writeFile(join(options.command.cwd, 'app', 'late-review-change.txt'), 'unverified final review change\n', 'utf8')
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'file_change', changes: [{ path: 'app/late-review-change.txt', kind: 'update' }] }
        }))
      } else if (turn === 7 && this.options.finalReviewVerificationOrder) {
        await writeFile(join(options.command.cwd, 'app', 'ordered-verification-change.txt'), 'final review source change\n', 'utf8')
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'file_change', changes: [{ path: 'app/ordered-verification-change.txt', kind: 'update' }] }
        }))
        const exitCodes = this.options.finalReviewVerificationOrder === 'pass-then-fail' ? [0, 1] : [1, 0]
        for (const exitCode of exitCodes) {
          options.onLine('stdout', JSON.stringify({
            type: 'item.completed',
            item: { type: 'command_execution', command: 'npm test', exit_code: exitCode }
          }))
        }
      } else if (agent === 'claude' && this.options.claudeVerificationStream) {
        options.onLine('stdout', JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_claude_review_verifier',
              name: 'Bash',
              input: { command: 'npm test' }
            }]
          }
        }))
        options.onLine('stdout', JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_claude_review_verifier',
              content: 'All tests passed.',
              is_error: false
            }]
          }
        }))
      } else {
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
        }))
        if (turn === 7 && this.options.protocolFinalFailure) {
          await appendFile(join(options.command.cwd, '.duo', 'public', 'build.jsonl'), `${JSON.stringify({
            id: 'protocol-final-failure',
            type: 'build.failed',
            runId: 'ignored-by-normalizer',
            round: turn,
            agent: 'director',
            publicText: 'A later protocol verification failed.',
            spoilerRisk: 0.02,
            severity: 'high'
          })}\n`, 'utf8')
        }
      }
    }

    if (/Turn:\s*repair/i.test(prompt) && stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }

    const writesRevealFixture = this.options.quotaCodexCode ? codeWork && agent === 'claude' : turn === 6
    if (writesRevealFixture && stage === 'work') {
      await mkdir(join(options.command.cwd, '.duo', 'sealed'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', 'index.html'), '<!doctype html><title>Ready</title>', 'utf8')
      await writeFile(
        join(options.command.cwd, '.duo', 'board.json'),
        `${JSON.stringify({
          tasks: [
            { id: 'claude-slice', publicTitle: 'First build slice', status: 'done', claimedBy: 'claude', risk: 'low', files: ['[WORKSPACE_FILE]'] },
            {
              id: 'codex-slice', publicTitle: 'Second build slice',
              status: this.options.missingCodexTask ? 'review' : 'done',
              claimedBy: 'codex', risk: 'low', files: ['[WORKSPACE_FILE]']
            }
          ]
        }, null, 2)}\n`,
        'utf8'
      )
      if (!this.options.omitRevealPacket) {
        await writeFile(
          join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'),
          `${JSON.stringify({
            appName: 'Private Result',
            idea: 'A sealed local interaction.',
            summary: 'Both agents contributed and verification passed.',
            features: ['One verified interaction'],
            runCommand: 'Open app/index.html',
            appPath: 'app',
            status: 'ready',
            whatWorked: ['Both implementation slices', 'Verification'],
            knownIssues: [],
            agentDramaSummary: ['Claude opened a position.', 'Codex answered it.', 'Both completed a build slice.'],
            gitCheckpoints: [],
            agentQuotes: { claude: 'The shared scope is ready.', codex: 'The evidence is ready.' }
          }, null, 2)}\n`,
          'utf8'
        )
      }
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }

    await mkdir(join(options.command.cwd, '.duo', 'logs'), { recursive: true })
    await appendFile(join(options.command.cwd, '.duo', 'logs', 'orchestrator.log'), '', 'utf8')
    if (turn === 7 && stage === 'work' && this.options.timeboxFirstReview) {
      const now = new Date().toISOString()
      return { exitCode: null, signal: 'SIGTERM', timedOut: true, cancelled: false, startedAt: now, finishedAt: now }
    }
    return completed()
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

function seriousStructuredCapsule(round: number, agent: 'claude' | 'codex') {
  const pitch = round <= 2
  const consensus = round === 4
  const speech = (kind: string) => ({
    publicText: `I think the requested [FEATURE] needs a testable ${kind} because every serious requirement must survive implementation.`,
    privateText: `${agent} says the invoice dashboard needs a testable ${kind} with offline CSV and keyboard review evidence.`
  })
  return {
    opening: speech('approach'),
    counter: speech('counter-proposal'),
    verdict: speech('decision'),
    opinion: { ...speech('product judgment'), tone: 'collaborative' },
    pitches: pitch
      ? [
          { title: `${agent} Ledger Queue`, idea: 'A queue-first architecture for invoice review.', appeal: 'Fast review.', risk: 'Dense tables.' },
          { title: `${agent} Ledger Canvas`, idea: 'A document-first architecture with a review rail.', appeal: 'Clear context.', risk: 'Responsive layout.' }
        ]
      : [],
    consensus: consensus
      ? {
          appName: 'Ledger Lantern',
          idea: 'An accessible local invoice dashboard with offline CSV import and a keyboard-first review queue.',
          summary: 'The requested serious product, split into two equally substantive implementation slices.',
          spec: `Implement the requested accessible invoice dashboard with deterministic offline CSV parsing, durable local review state, and keyboard-first navigation across every invoice action. Keep data local and make validation failures recoverable.\n\nAcceptance checks\n- Import a representative CSV invoice file while fully offline.\n- Complete every review-queue action using only the keyboard.\n- Restore invoice and review state after a full app restart.`,
          redactions: [{ value: 'Ledger Lantern', label: 'APP_NAME' }]
        }
      : null,
    tasks: consensus
      ? [
          {
            id: 'claude-slice', publicTitle: 'Build the first [FEATURE] slice', privateTitle: 'Claude builds offline CSV and persistence',
            publicDescription: 'Implement one substantive requested-product slice.', privateDescription: 'Implement offline invoice CSV parsing and durable state.',
            kind: 'implementation', risk: 'medium', claimedBy: 'claude', files: []
          },
          {
            id: 'codex-slice', publicTitle: 'Build the second [FEATURE] slice', privateTitle: 'Codex builds accessible review interactions',
            publicDescription: 'Implement the paired requested-product slice.', privateDescription: 'Implement the keyboard-first invoice review queue.',
            kind: 'implementation', risk: 'medium', claimedBy: 'codex', files: []
          }
        ]
      : [],
    redactions: [
      ...(pitch
        ? [
            { value: `${agent} Ledger Queue`, label: 'APP_NAME' },
            { value: `${agent} Ledger Canvas`, label: 'APP_NAME' }
          ]
        : []),
      ...(consensus ? [{ value: 'Ledger Lantern', label: 'APP_NAME' }] : []),
      { value: 'invoice dashboard', label: 'DOMAIN' }
    ]
  }
}

class SeriousEvidenceRunner extends EvidenceCompleteRunner {
  constructor(
    private readonly seriousBrief: string,
    private readonly tamperSpecification: boolean
  ) {
    super()
  }

  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = promptOf(options.command)
    const round = Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    const agent = options.command.bin === 'claude' ? 'claude' : 'codex'
    if (stage === 'dialogue') {
      this.commands.push(options.command)
      const capsule = seriousStructuredCapsule(round, agent)
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: capsule })
        : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
      return completed()
    }
    const result = await super.run(options)
    if (this.tamperSpecification && round === 7 && stage === 'work') {
      await sealSeriousMissionSpecification(
        join(options.command.cwd, '.duo', 'sealed'),
        this.seriousBrief,
        `Rewrite both the workspace specification and its colocated contract after the supervisor sealed consensus. This forged plan still repeats valid product nouns to prove that only the external guard can detect replacement.\n\nAcceptance checks\n- Import a different CSV invoice flow while offline.\n- Review the forged invoice queue using only the keyboard.`
      )
    }
    return result
  }
}

function structuredCapsule(round: number, agent: 'claude' | 'codex') {
  const names = [`${agent}-idea-${String(round)}-a`, `${agent}-idea-${String(round)}-b`]
  const speech = (label: string) => ({
    publicText: `I think the shared [FEATURE] needs ${label} because the build must stay testable.`,
    privateText: round === 4 && agent === 'codex' && label === 'verdict'
      ? 'Codex stale consensus context from round 4.'
      : `${agent} private ${label} from round ${String(round)}.`
  })
  const pitches = round <= 2
    ? names.map((title) => ({ title, idea: `${title} private idea.`, appeal: 'Compact payoff.', risk: 'Implementation risk.' }))
    : []
  const consensus = round === 4
    ? {
        appName: 'Sealed Product',
        idea: 'A sealed local interaction.',
        summary: 'Two agents will implement separate slices.',
        spec: 'Build one runnable local interaction with two source-changing slices and verification.',
        redactions: [{ value: 'Sealed Product', label: 'APP_NAME' }]
      }
    : null
  const tasks = round === 4
    ? [
        {
          id: 'claude-slice', publicTitle: 'First [FEATURE] slice', privateTitle: 'Claude source slice',
          publicDescription: 'Build the first source-changing slice.', privateDescription: 'Build the first private slice.',
          kind: 'implementation', risk: 'medium', claimedBy: 'claude', files: []
        },
        {
          id: 'codex-slice', publicTitle: 'Second [FEATURE] slice', privateTitle: 'Codex source slice',
          publicDescription: 'Build the second source-changing slice.', privateDescription: 'Build the second private slice.',
          kind: 'implementation', risk: 'medium', claimedBy: 'codex', files: []
        }
      ]
    : []
  return {
    opening: speech('opening'), counter: speech('counter'), verdict: speech('verdict'),
    opinion: { ...speech('opinion'), tone: 'collaborative' },
    tasks,
    pitches,
    consensus,
    redactions: [
      ...names.map((value) => ({ value, label: 'APP_NAME' })),
      ...(consensus ? [{ value: consensus.appName, label: 'APP_NAME' }] : [])
    ]
  }
}

class FreshHandoffRunner implements ProcessRunnerPort {
  readonly commands: AgentCommand[] = []

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.commands.push(options.command)
    const prompt = promptOf(options.command)
    const round = Number(prompt.match(/^Round:\s*(\d+)/mi)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    const agent = options.command.bin === 'claude' ? 'claude' : 'codex'
    const opponent = agent === 'claude' ? 'codex' : 'claude'

    if (stage === 'dialogue') {
      const capsule = structuredCapsule(round, agent)
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify({ type: 'result', structured_output: capsule })
        : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
      return completed()
    }

    if (stage === 'work') {
      const id = `${agent}-r${String(round)}-${stage}`
      const privateText = round === 6
        ? `${agent === 'claude' ? 'Claude' : 'Codex'} newest private verdict from round 6. ${'detail '.repeat(300)}UNBOUNDED_HANDOFF_TAIL`
        : `${agent} private ${stage} from round ${String(round)}.`
      const latestStatementId = prompt.match(/^LATEST .+ STATEMENT\r?\n([^:\r\n]+):/mi)?.[1]?.trim()
      const event = {
        id, type: 'agent.dispatch', agent, targetAgent: opponent, round,
        dispatchKind: 'verdict', claimKey: 'shared-work',
        ...(latestStatementId ? { replyTo: latestStatementId } : {}),
        publicText: `I think the [FEATURE] has a concrete ${stage} handoff.`, privateText, spoilerRisk: 0.02
      }
      await Promise.all([
        appendFile(join(options.command.cwd, '.duo', 'public', 'dispatches.jsonl'), `${JSON.stringify({ ...event, privateText: undefined })}\n`, 'utf8'),
        appendFile(join(options.command.cwd, '.duo', 'private', 'dispatches.jsonl'), `${JSON.stringify(event)}\n`, 'utf8'),
        appendFile(join(options.command.cwd, '.duo', 'public', 'opinions.jsonl'), `${JSON.stringify({
          id: `${id}-opinion`, type: 'opinion', agent, targetAgent: opponent, round, tone: 'collaborative',
          publicText: 'The shared [FEATURE] has one concrete next move.', spoilerRisk: 0.02
        })}\n`, 'utf8')
      ])
      if (round === 6) {
        await appendFile(join(options.command.cwd, '.duo', 'private', 'dispatches.jsonl'), [
          JSON.stringify({
            ...event,
            id: `${id}-future`,
            round: 999,
            privateText: 'FUTURE_ROUND_HANDOFF'
          }),
          JSON.stringify({
            ...event,
            id: `${id}-wrong-run`,
            runId: 'duo-run-different',
            round: 7,
            privateText: 'WRONG_RUN_HANDOFF'
          })
        ].join('\n') + '\n', 'utf8')
      }
    }

    if (stage === 'work' && /Turn:\s*code/i.test(prompt)) {
      await writeFile(join(options.command.cwd, 'app', `${agent}-handoff-slice.txt`), `${agent} source contribution\n`, 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'file_change', changes: [{ path: `app/${agent}-handoff-slice.txt`, kind: 'update' }] }
      }))
    } else if (stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }
    return completed()
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}
