import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RunOrchestrator as BaseRunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { RunSnapshot } from '../../src/shared/types'

class RunOrchestrator extends BaseRunOrchestrator {
  constructor(options: ConstructorParameters<typeof BaseRunOrchestrator>[0]) {
    super({ ...options, testOnlyMinimumTurns: 2 })
  }
}

describe('simulation orchestration', () => {
  it('runs through reveal-ready without exposing the sealed packet, then unlocks it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-'))
    const snapshots: RunSnapshot[] = []
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      simulationDelayScale: 0
    })

    const result = await orchestrator.start({
      prompt: 'Make an emotionally resonant local app.',
      missionProfile: 'serious',
      workspaceRoot: root,
      executionMode: 'simulation',
      visibilityMode: 'spoiler-shield',
      maxTurns: 8,
      maxRepairLoops: 3,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const locked = orchestrator.getSnapshot(result.runId)
    expect(locked?.status).toBe('reveal-ready')
    expect(locked?.missionProfile).toBe('serious')
    expect(locked?.round).toBe(8)
    expect(locked?.totalTurns).toBe(8)
    expect(locked?.revealPacket).toBeUndefined()
    expect(locked?.finishedAt).toBeDefined()
    expect(JSON.stringify(locked)).not.toContain('Afterglow Atlas')
    expect(locked?.events.some((event) => event.type === 'build.failed')).toBe(true)
    expect(locked?.tasks.some((task) => task.claimedBy === 'claude')).toBe(true)
    expect(locked?.tasks.some((task) => task.claimedBy === 'codex')).toBe(true)

    const revealed = await orchestrator.reveal(result.runId)
    expect(revealed.status).toBe('complete')
    expect(revealed.finishedAt).toBe(locked?.finishedAt)
    expect(revealed.revealPacket).toMatchObject({
      appName: 'Afterglow Atlas · workflow rehearsal',
      status: 'partial'
    })
    await expect(readFile(join(result.workspacePath, 'app', 'index.html'), 'utf8')).resolves.toMatch(/Afterglow Atlas|constellation/i)
    await expect(
      readFile(join(result.workspacePath, '.duo', 'sealed', 'reveal_packet.json'), 'utf8')
    ).resolves.toContain('Afterglow Atlas')
    await expect(readFile(join(result.workspacePath, '.duo', 'run.json'), 'utf8'))
      .resolves.toContain('"missionProfile": "serious"')
    expect(snapshots.length).toBeGreaterThan(10)
  })

  it('stops an active simulation and terminates the run cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-stop-'))
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      simulationDelayScale: 1
    })
    const result = await orchestrator.start({
      prompt: 'Start, then stop safely.',
      workspaceRoot: root,
      executionMode: 'simulation',
      visibilityMode: 'blind',
      maxTurns: 12,
      maxRepairLoops: 3,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    const stopped = await orchestrator.stop(result.runId)
    expect(stopped.status).toBe('cancelled')
    await orchestrator.waitForSettled(result.runId)
  })

  it('runs the complete equal-agent Real Mode schedule with deterministic fake CLIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-real-'))
    const fakeRunner = new FakeProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve({
        ...defaultSettings(root),
        codexModel: 'gpt-5.6-sol',
        codexEffort: 'max',
        claudeModel: 'fable',
        claudeEffort: 'high'
      }),
      onSnapshot: () => undefined,
      processRunner: fakeRunner,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex 1', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude 1', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
      ])
    })
    const result = await orchestrator.start({
      prompt: 'Build a real hidden app with equal contributions.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 12,
      maxRepairLoops: 3,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    const locked = orchestrator.getSnapshot(result.runId)
    expect(locked?.status).toBe('reveal-ready')
    expect(locked?.events.some((event) => event.type === 'opinion' && event.agent === 'claude')).toBe(true)
    expect(locked?.events.some((event) => event.type === 'opinion' && event.agent === 'codex')).toBe(true)
    expect(fakeRunner.turns).toBe(7)
    expect(locked?.totalTurns).toBe(7)
    expect(locked?.round).toBe(7)
    expect(locked?.agentRuntimes).toEqual({
      codex: { model: 'gpt-5.6-sol', effort: 'max', source: 'studio' },
      claude: { model: 'fable', effort: 'high', source: 'studio' }
    })
    expect(fakeRunner.commands.find((command) => command.bin === 'codex')?.args).toContain('gpt-5.6-sol')
    expect(fakeRunner.commands.find((command) => command.bin === 'claude')?.args).toContain('fable')
    const claudeCommand = fakeRunner.commands.find((command) => command.bin === 'claude')
    expect(claudeCommand?.stdin).toContain('HUMAN BRIEF\nBuild a real hidden app with equal contributions.')
    expect(claudeCommand?.stdin).toContain('Use direct teammate language')
    expect(claudeCommand?.stdin).toContain('I think')
    expect(claudeCommand?.stdin?.length).toBeLessThan(3_500)
    expect(claudeCommand?.stdin).not.toMatch(/private\/raw|transcript\.jsonl|timeline\.jsonl/)
    expect(claudeCommand?.args).not.toContain(claudeCommand?.stdin)
    const finalPrompt = fakeRunner.commands.at(-1)?.stdin ?? fakeRunner.commands.at(-1)?.args.at(-1) ?? ''
    expect(finalPrompt).toContain('The supervisor builds the reveal packet from verified evidence')
    expect(finalPrompt).not.toContain('FINAL REVEAL CONTRACT')
    const revealed = await orchestrator.reveal(result.runId)
    expect(revealed.revealPacket?.appName).toBe('Signal Garden')
  }, 60_000)

  it('publishes realistic workspace opinions, activity, tasks, and run state before a live turn finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-live-protocol-'))
    const runner = new StreamingProtocolRunner()
    const snapshots: RunSnapshot[] = []
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      processRunner: runner,
      protocolPollMs: 10,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex 1', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude 1', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
      ])
    })
    const result = await orchestrator.start({
      prompt: 'Build a hidden app while keeping the public dashboard alive.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 1,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })

    try {
      await runner.started
      await waitUntil(() => {
        const snapshot = orchestrator.getSnapshot(result.runId)
        return Boolean(
          snapshot?.events.some((event) => event.type === 'opinion') &&
          snapshot.events.some((event) => event.type === 'agent.activity') &&
          snapshot.tasks.length === 1
        )
      })

      const live = orchestrator.getSnapshot(result.runId)
      const activeAgent = live?.activeAgent
      expect(live?.status).toBe('running')
      expect(activeAgent === 'claude' || activeAgent === 'codex').toBe(true)
      expect(live?.events.some((event) => event.type === 'opinion' && event.agent === activeAgent)).toBe(true)
      expect(live?.events.some((event) => event.type === 'agent.activity' && event.agent === activeAgent)).toBe(true)
      expect(live?.tasks[0]).toMatchObject({
        publicTitle: 'Repair investigation',
        status: 'in-progress',
        claimedBy: activeAgent
      })
      expect(JSON.stringify(live)).not.toContain('secret orb')
      expect(snapshots.some((snapshot) => snapshot.tasks.length === 1)).toBe(true)

      const persisted = JSON.parse(await readFile(join(result.workspacePath, '.duo', 'run.json'), 'utf8')) as Record<string, unknown>
      expect(persisted).toMatchObject({
        status: 'running',
        round: 1,
        phase: 'round.pitch',
        activeAgent,
        totalTurns: 2
      })
    } finally {
      const stopped = await orchestrator.stop(result.runId)
      await orchestrator.waitForSettled(result.runId)
      const settled = orchestrator.getSnapshot(result.runId)
      expect(stopped.turnStage?.status).not.toBe('running')
      expect(settled?.status).toBe('cancelled')
      expect(settled?.events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1)
      expect(settled?.events.some((event) => event.type === 'run.failed')).toBe(false)
    }
  })

  it('keeps a long Real Mode turn on-air with agent dispatches and truthful broadcast beats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-broadcast-'))
    const runner = new BroadcastStreamingRunner()
    const snapshots: RunSnapshot[] = []
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      processRunner: runner,
      protocolPollMs: 5,
      broadcastBeatMs: 10,
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: true, version: 'codex 1', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: true, version: 'claude 1', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
      ])
    })
    const result = await orchestrator.start({
      prompt: 'Build a hidden app with a live spectator broadcast.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 2,
      maxRepairLoops: 1,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })

    try {
      await runner.started
      await waitUntil(() => {
        const snapshot = orchestrator.getSnapshot(result.runId)
        return Boolean(
          snapshot?.events.some((event) => event.type === 'agent.dispatch') &&
          snapshot.broadcast?.queue.some((beat) => beat.provenance === 'director') &&
          snapshot.broadcast.queue.some((beat) => beat.provenance === 'evidence')
        )
      })

      const live = orchestrator.getSnapshot(result.runId)
      expect(live?.status).toBe('running')
      const active = live?.activeAgent
      const other = active === 'claude' ? 'codex' : 'claude'
      expect(live?.broadcast?.responseDueAgent).toBe(other)
      expect(live?.broadcast?.nextAgent).toBe(other)
      expect(live?.broadcast?.activeBeat).toBeDefined()
      expect(live?.events.find((event) => event.type === 'agent.dispatch')).toMatchObject({
        agent: 'claude',
        dispatchKind: 'opening',
        publicText: 'Claude opens with a smaller [FEATURE] and wants Codex to prove the build risk.'
      })
      expect(runner.turns).toBe(1)
      expect(new Set(snapshots.map((snapshot) => snapshot.broadcast?.activeBeat?.id).filter(Boolean)).size).toBeGreaterThan(1)
      expect(JSON.stringify(live)).not.toContain('secret-orb')
    } finally {
      await orchestrator.stop(result.runId)
      await orchestrator.waitForSettled(result.runId)
    }
  })

  it('fails Real Mode gracefully when required AI CLIs are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-missing-'))
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: new FakeProcessRunner(),
      healthProvider: () => Promise.resolve([
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: false, detail: 'not found', checkedAt: new Date().toISOString() },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: false, detail: 'not found', checkedAt: new Date().toISOString() },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
      ])
    })
    const result = await orchestrator.start({
      prompt: 'Try a guarded real run.',
      workspaceRoot: root,
      executionMode: 'safe',
      visibilityMode: 'spoiler-shield',
      maxTurns: 12,
      maxRepairLoops: 3,
      turnTimeoutSeconds: 120,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('paused')
    expect(orchestrator.getSnapshot(result.runId)?.pause).toMatchObject({ reason: 'cli-incompatible', resumable: true })
    expect(orchestrator.getSnapshot(result.runId)?.events.at(-1)?.publicText).toMatch(/Simulation Mode remains available/)
  })

  it('recovers one rejected contract without repeating expensive work or advancing the logical round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-retry-'))
    const runner = new RecoveringProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents
    })
    const result = await orchestrator.start({
      prompt: 'Build with one safe protocol retry.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('reveal-ready')
    expect(runner.turns).toBe(8)
    expect(runner.rounds.slice(0, 2)).toEqual([1, 1])
    const recoveryPrompt = runner.commands[1]?.stdin ?? runner.commands[1]?.args.at(-1) ?? ''
    expect(recoveryPrompt).toMatch(/^Stage:\s*recovery/im)
    expect(recoveryPrompt).toContain('CONTRACT-ONLY RECOVERY')
    expect(snapshot?.events.some((event) => event.type === 'decision' && event.topic === 'contract-recovery')).toBe(true)
  })

  it('pauses safely after one retry when an agent still produces no accepted protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-reject-'))
    const runner = new AlwaysEmptyProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents
    })
    const result = await orchestrator.start({
      prompt: 'Do not advance past an empty turn.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const snapshot = orchestrator.getSnapshot(result.runId)
    expect(snapshot?.status).toBe('paused')
    expect(snapshot?.pause).toMatchObject({ reason: 'provider-protocol', resumable: true })
    expect(runner.turns).toBe(2)
    expect(runner.rounds).toEqual([1, 1])
    expect(snapshot?.events.filter((event) => event.type === 'agent.started').every((event) => event.round === 1)).toBe(true)
  })

  it('stops optional repairs only after both code and cross-review turns are complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-early-stop-'))
    const runner = new EarlyReadyProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Stop once the balanced build is genuinely ready.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(runner.turns).toBe(7)
    expect(orchestrator.getSnapshot(result.runId)?.status).toBe('reveal-ready')
  })

  it('recovers a ready reveal from an alternate packet schema and workspace evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-alternate-reveal-'))
    const runner = new AlternateRevealProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Build a direct-open surprise.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    const revealed = await orchestrator.reveal(result.runId)
    const packet = revealed.revealPacket
    expect(packet?.knownIssues).toEqual(['The experience requires a modern browser with Canvas support.'])
    expect(orchestrator.getSnapshot(result.runId)?.releaseStatus).toBe('ready')
    expect(packet?.appName).toBe('Seed Garden')
    expect(packet?.features.length).toBeGreaterThan(0)
    expect(packet?.features).toEqual(expect.arrayContaining([
      'Claude added the twinkling starfield.',
      'Codex added reset controls.'
    ]))
    expect(packet?.runCommand).toMatch(/app[\\/]index\.html/i)
    expect(packet?.appPath.replaceAll('\\', '/')).toMatch(/app\/index\.html$/i)
    expect(packet?.whatWorked.join(' ')).toMatch(/syntax|direct-open|completed/i)
    expect(packet?.knownIssues.join(' ')).toMatch(/modern browser/i)
  })

  it('repairs known legacy fallback placeholders from workspace evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-legacy-reveal-'))
    const runner = new LegacyFallbackRevealProcessRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: runner,
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Recover the real artifact metadata.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)
    const revealed = await orchestrator.reveal(result.runId)

    expect(revealed.revealPacket?.appName).toBe('Seed Garden')
    expect(revealed.revealPacket?.idea).not.toMatch(/turn limit|reveal packet/i)
    expect(revealed.revealPacket?.runCommand).toMatch(/app[\\/]index\.html/i)
    expect(revealed.revealPacket?.appPath.replaceAll('\\', '/')).toMatch(/app\/index\.html$/i)
    expect(revealed.revealPacket?.features).toEqual(expect.arrayContaining([
      'Claude added the twinkling starfield.',
      'Codex added reset controls.'
    ]))
  })

  it('certifies a runnable status-only packet only after independent supervisor proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-empty-ready-'))
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: new StatusOnlyRevealProcessRunner(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Do not trust an empty release claim.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(orchestrator.getSnapshot(result.runId)?.releaseStatus).toBe('ready')
    expect(orchestrator.getSnapshot(result.runId)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'build.passed', topic: 'supervisor-verification' })
    ]))
  })

  it('ignores ambiguous agent command noise when the independent supervisor validates the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-ambiguous-verification-'))
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: new MisleadingVerificationRevealProcessRunner(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Require machine-recorded verification before release.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(orchestrator.getSnapshot(result.runId)?.releaseStatus).toBe('ready')
  })

  it('independently verifies the exact later app revision instead of trusting an older agent pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-orchestrator-stale-verification-'))
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve(defaultSettings(root)),
      onSnapshot: () => undefined,
      processRunner: new StaleVerificationRevealProcessRunner(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })
    const result = await orchestrator.start({
      prompt: 'Require a fresh verification after the final app edit.', workspaceRoot: root, executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      maxTurns: 8, maxRepairLoops: 1, turnTimeoutSeconds: 120, dangerousModeConfirmed: false, unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(result.runId)

    expect(orchestrator.getSnapshot(result.runId)?.releaseStatus).toBe('ready')
  })
})

const healthyAgents = (): Promise<ReturnType<typeof healthRows>> => Promise.resolve(healthRows())

function healthRows() {
  return [
    { id: 'codex' as const, label: 'Codex CLI', command: 'codex', available: true, version: 'codex 1', checkedAt: new Date().toISOString() },
    { id: 'claude' as const, label: 'Claude Code', command: 'claude', available: true, version: 'claude 1', checkedAt: new Date().toISOString() },
    { id: 'git' as const, label: 'Git', command: 'git', available: true, version: 'git 1', checkedAt: new Date().toISOString() }
  ]
}

class FakeProcessRunner implements ProcessRunnerPort {
  turns = 0
  commands: ProcessRunOptions['command'][] = []
  protected emitVerificationEvidence = true

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.turns += 1
    this.commands.push(options.command)
    const agent = options.id.includes('claude') ? 'claude' : 'codex'
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? this.turns)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    const latestStatementId = prompt.match(/^LATEST .+ STATEMENT\r?\n([^:\r\n]+):/mi)?.[1]?.trim()
    options.onLine(
      'stdout',
      JSON.stringify({
        id: `fake-dispatch-${agent}-${String(round)}-${String(this.turns)}`,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        dispatchKind: 'opening',
        claimKey: `round-${String(round)}`,
        ...(latestStatementId ? { replyTo: latestStatementId } : {}),
        publicText: `${agent === 'claude' ? 'Claude' : 'Codex'} says I think the current [FEATURE] needs one direct improvement.`,
        spoilerRisk: 0.02
      })
    )
    options.onLine(
      'stdout',
      JSON.stringify({
        id: `fake-opinion-${agent}-${String(round)}-${String(this.turns)}`,
        type: 'opinion',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        tone: this.turns % 2 === 0 ? 'skeptical' : 'confident',
        publicText: `${agent === 'claude' ? 'Claude' : 'Codex'} challenges the current [FEATURE] tradeoff.`,
        privateText: 'The private Signal Garden interaction needs another pass.',
        spoilerRisk: 'low',
        confidence: 0.8,
        timestamp: new Date().toISOString()
      })
    )
    if (/Turn:\s*code/i.test(prompt) && stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', `${agent}-slice.txt`), `${agent} source contribution\n`, 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: `app/${agent}-slice.txt`, kind: 'update' }] }
      }))
      if (round === 6) {
        await writeFile(join(options.command.cwd, 'app', 'index.html'), '<!doctype html><title>Signal Garden</title>', 'utf8')
        await writeFile(join(options.command.cwd, '.duo', 'board.json'), JSON.stringify({ tasks: [
          { id: 'claude-slice', publicTitle: 'Claude source slice', status: 'done', claimedBy: 'claude', risk: 'medium', files: ['app/claude-slice.txt'] },
          { id: 'codex-slice', publicTitle: 'Codex source slice', status: 'done', claimedBy: 'codex', risk: 'medium', files: ['app/codex-slice.txt'] }
        ] }), 'utf8')
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
        }))
      }
    }
    if (this.emitVerificationEvidence && /Turn:\s*(?:review|verify|repair)/i.test(prompt) && stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }
    if (round === 4) {
      await mkdir(join(options.command.cwd, '.duo', 'sealed'), { recursive: true })
      await writeFile(
        join(options.command.cwd, '.duo', 'sealed', 'redactions.json'),
        JSON.stringify({ terms: [{ value: 'Signal Garden', label: 'APP_NAME' }] }),
        'utf8'
      )
    }
    if (stage === 'work' && /FINAL REVEAL CONTRACT/i.test(prompt)) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', 'index.html'), '<!doctype html><title>Signal Garden</title>', 'utf8')
      await mkdir(join(options.command.cwd, '.duo', 'sealed'), { recursive: true })
      await writeFile(
        join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'),
        JSON.stringify({
          appName: 'Signal Garden',
          idea: 'A private local signal garden.',
          summary: 'A deterministic fake-CLI integration result.',
          features: ['Signal canvas'],
          runCommand: 'npm run dev',
          appPath: 'app',
          status: 'ready',
          whatWorked: ['Schedule completed'],
          knownIssues: [],
          agentDramaSummary: ['Both agents challenged the same tradeoff.'],
          gitCheckpoints: [],
          agentQuotes: { claude: 'Ship the feeling.', codex: 'Ship the build.' }
        }),
        'utf8'
      )
      if (this.emitVerificationEvidence) {
        options.onLine('stdout', JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
        }))
      }
    }
    const now = new Date().toISOString()
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class AlternateRevealProcessRunner extends FakeProcessRunner {
  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (round !== 7 || stage !== 'work') return result

    await mkdir(join(options.command.cwd, 'app'), { recursive: true })
    await writeFile(join(options.command.cwd, 'app', 'index.html'), '<!doctype html><title>Seed Garden</title><h1>Seed Garden</h1>', 'utf8')
    await writeFile(join(options.command.cwd, '.duo', 'sealed', 'r4-spec.json'), JSON.stringify({
      round: 4,
      selection: 'Seed Garden',
      spec: [
        'One directly openable HTML file with no dependencies.',
        'Pointer input creates luminous orbiting seeds.',
        'A subtle starfield and explicit reset interaction complete the scene.'
      ]
    }), 'utf8')
    await writeFile(join(options.command.cwd, '.duo', 'board.json'), JSON.stringify({ tasks: [
      { id: 'claude-atmosphere', owner: 'claude', status: 'done', sourceScope: 'app/index.html', summary: 'Claude added the twinkling starfield.' },
      { id: 'codex-controls', owner: 'codex', status: 'done', sourceScope: 'app/index.html', summary: 'Codex added reset controls.' }
    ] }), 'utf8')
    await writeFile(join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'), JSON.stringify({
      status: 'ready',
      summary: 'A small, self-contained interactive canvas scene is ready to open directly in a browser.',
      factualDrama: 'Both agents kept the experience compact while adding atmosphere and replay controls.',
      quotes: [
        { agent: 'claude', text: 'The combined script is clean and both slices coexist.' },
        { agent: 'codex', text: 'The build is ready because both slices remain compact and runnable.' }
      ],
      runCommand: 'Open app/index.html in a modern web browser.',
      checks: ['Inline JavaScript passed a syntax check.', 'Confirmed both agents completed substantive slices.'],
      remainingCaveats: ['The experience requires a modern browser with Canvas support.']
    }), 'utf8')
    options.onLine('stdout', JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'app/index.html', kind: 'update' }] }
    }))
    options.onLine('stdout', JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
    }))
    return result
  }
}

class LegacyFallbackRevealProcessRunner extends AlternateRevealProcessRunner {
  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (round !== 7 || stage !== 'work') return result
    await writeFile(join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'), JSON.stringify({
      appName: options.command.cwd.split(/[\\/]/).at(-1),
      idea: 'The agents reached the turn limit before writing a complete reveal packet.',
      summary: 'A partial generated workspace is ready for inspection.',
      features: [],
      runCommand: 'Inspect the generated README and package.json.',
      appPath: join(options.command.cwd, 'app'),
      status: 'partial',
      whatWorked: ['Both local CLI agents completed scheduled turns.'],
      knownIssues: ['No valid reveal packet was produced before the turn limit.'],
      agentDramaSummary: ['The orchestrator preserved the partial workspace rather than inventing a successful result.'],
      gitCheckpoints: [],
      agentQuotes: {
        claude: 'The workspace needs another repair pass.',
        codex: 'The final contract was incomplete, so the result is marked partial.'
      }
    }), 'utf8')
    return result
  }
}

class StatusOnlyRevealProcessRunner extends FakeProcessRunner {
  protected override emitVerificationEvidence = false

  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (stage === 'work' && /Turn:\s*(?:review|verify|repair)/i.test(prompt)) {
      await writeFile(join(options.command.cwd, 'app', `claim-only-${String(round)}.txt`), 'source changed without recorded verification\n', 'utf8')
    }
    if (round === 7 && stage === 'work') {
      await writeFile(join(options.command.cwd, '.duo', 'board.json'), JSON.stringify({ tasks: [
        { id: 'claude-done', owner: 'claude', status: 'done', summary: 'Claude finished a source slice.' },
        { id: 'codex-done', owner: 'codex', status: 'done', summary: 'Codex finished a source slice.' }
      ] }), 'utf8')
      await writeFile(join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'), JSON.stringify({
        status: 'ready',
        checks: ['The agent claims the page works.'],
        whatWorked: ['The agent claims verification passed.']
      }), 'utf8')
    }
    return result
  }
}

class MisleadingVerificationRevealProcessRunner extends StatusOnlyRevealProcessRunner {
  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (round === 7 && stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'echo build passed', exit_code: 0 }
      }))
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test' }
      }))
    }
    return result
  }
}

class StaleVerificationRevealProcessRunner extends StatusOnlyRevealProcessRunner {
  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (round === 5 && stage === 'work') {
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }
    return result
  }
}

class RecoveringProcessRunner extends FakeProcessRunner {
  rounds: number[] = []
  private rejected = false

  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    this.rounds.push(round)
    if (!this.rejected) {
      this.rejected = true
      this.turns += 1
      this.commands.push(options.command)
      options.onLine('stdout', JSON.stringify({ type: 'result', result: 'I do not see a task description. What would you like me to do?' }))
      const now = new Date().toISOString()
      return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
    }
    return await super.run(options)
  }
}

class AlwaysEmptyProcessRunner implements ProcessRunnerPort {
  turns = 0
  rounds: number[] = []

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.turns += 1
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    this.rounds.push(Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0))
    options.onLine('stdout', JSON.stringify({ type: 'result', result: 'What would you like me to help with?' }))
    const now = new Date().toISOString()
    return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now })
  }

  cancelAll(): Promise<void> {
    return Promise.resolve()
  }
}

class EarlyReadyProcessRunner extends FakeProcessRunner {
  override async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const result = await super.run(options)
    const prompt = options.command.stdin ?? options.command.args.at(-1) ?? ''
    const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 0)
    const stage = prompt.match(/^Stage:\s*(\S+)/mi)?.[1]?.toLowerCase()
    if (round === 6 && stage === 'work') {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      await writeFile(join(options.command.cwd, 'app', 'index.html'), '<!doctype html><title>Signal Garden</title>', 'utf8')
      await writeFile(join(options.command.cwd, '.duo', 'board.json'), JSON.stringify({ tasks: [
        { id: 'claude-code', publicTitle: 'Claude build contribution', status: 'done', claimedBy: 'claude', risk: 'medium', files: ['app/claude.txt'] },
        { id: 'codex-code', publicTitle: 'Codex build contribution', status: 'done', claimedBy: 'codex', risk: 'medium', files: ['app/codex.txt'] }
      ] }), 'utf8')
      await mkdir(join(options.command.cwd, '.duo', 'sealed'), { recursive: true })
      await writeFile(join(options.command.cwd, '.duo', 'sealed', 'reveal_packet.json'), JSON.stringify({
        appName: 'Signal Garden', idea: 'Private idea', summary: 'Ready early.', features: ['Feature'],
        runCommand: 'open app', appPath: 'app', status: 'ready', whatWorked: ['Both coded'], knownIssues: [],
        agentDramaSummary: ['Both agents contributed code.'], gitCheckpoints: [],
        agentQuotes: { claude: 'I built my half.', codex: 'I built mine.' }
      }), 'utf8')
      options.onLine('stdout', JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test', exit_code: 0 }
      }))
    }
    return result
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for live protocol state.')
}

class StreamingProtocolRunner implements ProcessRunnerPort {
  private releaseTurn: (() => void) | undefined
  private markStarted: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = options.id.includes('claude') ? 'claude' : 'codex'
    const label = agent === 'claude' ? 'Claude' : 'Codex'
    await writeFile(
      join(options.command.cwd, '.duo', 'public', 'opinions.jsonl'),
      `${JSON.stringify({
        agent,
        round: 1,
        type: 'product-opinion',
        publicText: `${label} wants the hidden [FEATURE] to stay small and testable.`,
        spoilerRisk: 0.03
      })}\n`,
      'utf8'
    )
    await writeFile(
      join(options.command.cwd, '.duo', 'board.json'),
      `${JSON.stringify({
        tasks: [{
          id: 'repair-live',
          type: 'repair',
          title: 'Fix the secret orb interaction',
          description: 'Repair app/secret-orb.html.',
           file: 'app/secret-orb.html',
           status: 'in_progress',
           claimedBy: agent
        }]
      }, null, 2)}\n`,
      'utf8'
    )
    options.onLine('stdout', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app/secret-orb.html' } }] }
    }))
    this.markStarted?.()
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve
    })
    const now = new Date().toISOString()
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
  }

  cancelAll(): Promise<void> {
    this.releaseTurn?.()
    return Promise.resolve()
  }
}

class BroadcastStreamingRunner implements ProcessRunnerPort {
  turns = 0
  private releaseTurn: (() => void) | undefined
  private markStarted: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.turns += 1
    await writeFile(
      join(options.command.cwd, '.duo', 'public', 'dispatches.jsonl'),
      `${JSON.stringify({
        id: 'claude-r1-opening',
        type: 'agent.dispatch',
        agent: 'claude',
        round: 1,
        dispatchKind: 'opening',
        claimKey: 'scope',
        publicText: 'Claude opens with a smaller [FEATURE] and wants Codex to prove the build risk.',
        privateText: 'The secret-orb interaction should stay tiny.',
        spoilerRisk: 0.03
      })}\n`,
      'utf8'
    )
    options.onLine('stdout', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app/secret-orb.html' } }] }
    }))
    options.onLine('stdout', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'app/secret-orb.html' } }] }
    }))
    this.markStarted?.()
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve
    })
    const now = new Date().toISOString()
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
  }

  cancelAll(): Promise<void> {
    this.releaseTurn?.()
    return Promise.resolve()
  }
}
