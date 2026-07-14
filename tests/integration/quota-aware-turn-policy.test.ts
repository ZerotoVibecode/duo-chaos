import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeCliActivity } from '../../src/main/events/normalizer'
import {
  RunOrchestrator,
  type ProcessRunnerPort
} from '../../src/main/orchestrator/run-orchestrator'
import {
  SupervisorVerifier,
  type SupervisorBrowserEvidencePort
} from '../../src/main/orchestrator/supervisor-verifier'
import type {
  ProcessRunOptions,
  ProcessRunResult
} from '../../src/main/process/process-runner'
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

function effortOf(options: ProcessRunOptions): string | undefined {
  if (agentOf(options) === 'claude') {
    const index = options.command.args.indexOf('--effort')
    return index >= 0 ? options.command.args[index + 1] : undefined
  }
  return options.command.args
    .find((argument) => argument.startsWith('model_reasoning_effort='))
    ?.match(/^model_reasoning_effort="(.+)"$/)?.[1]
}

function result(exitCode = 0): ProcessRunResult {
  const now = new Date().toISOString()
  return { exitCode, signal: null, timedOut: false, cancelled: false, startedAt: now, finishedAt: now }
}

function quotaFixtureHtml(humanBrief: string): string {
  const evidence = humanBrief.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared Signal</title></head><body><main><h1>Shared Signal</h1><p>${evidence}</p><p id="fixture-status" aria-live="polite">Interaction ready.</p><button type="button" data-fixture-interaction>Run interaction</button></main><script>document.querySelector('[data-fixture-interaction]').addEventListener('click',()=>{document.querySelector('#fixture-status').textContent='Interaction complete.'})</script></body></html>`
}

function qualityBriefFromPrompt(prompt: string): string {
  return prompt.match(/^HUMAN BRIEF\r?\n([^\r\n]+)/mi)?.[1]?.trim() ?? 'Build a useful, runnable local interaction.'
}

function quotaDialogueCapsule(round: number, agent: 'claude' | 'codex', prompt: string) {
  const humanBrief = qualityBriefFromPrompt(prompt)
  const speech = (move: string) => ({
    publicText: `I think the shared [FEATURE] needs a ${move} that stays bounded and directly testable.`,
    privateText: `${agent} records the private ${move} for Shared Signal in round ${String(round)}.`
  })
  const consensus = round === 4
    ? {
        appName: 'Shared Signal',
        idea: `${humanBrief} The selected result is a useful, responsive, accessible, runnable local interaction built together.`,
        summary: `Shared Signal preserves the complete human brief: ${humanBrief}`,
        spec: `${humanBrief} Build one bounded local interaction. Each agent owns, changes, verifies, and hands off a distinct source slice before release.`,
        redactions: [{ value: 'Shared Signal', label: 'APP_NAME' }]
      }
    : null
  return {
    opening: speech('opening'),
    counter: speech('counter'),
    verdict: speech('verdict'),
    opinion: { ...speech('opinion'), tone: 'collaborative' },
    pitches: round <= 2
      ? [
          { title: 'Shared Signal', idea: `${humanBrief} Shared Signal implements the requested outcome.`, appeal: 'Small, useful, and directly testable.', risk: 'Requires disciplined source ownership.' },
          { title: `${agent} Alternative`, idea: `${humanBrief} A second bounded implementation strategy.`, appeal: 'Provides a real tradeoff.', risk: 'May be less memorable.' }
        ]
      : [],
    tasks: round === 4
      ? [
          {
            id: 'claude-slice', publicTitle: 'First [FEATURE] slice', privateTitle: 'Claude source slice',
            publicDescription: 'Implement and verify the first source-changing slice.', privateDescription: 'Claude owns one Shared Signal source slice.',
            kind: 'implementation', impact: 'substantial',
            expectedOutcome: 'Claude lands and verifies one independently attributable Shared Signal source slice.',
            acceptanceChecks: ['The Claude source boundary exists and its direct verification passes.'],
            risk: 'medium', claimedBy: 'claude', files: ['app/claude-*.txt']
          },
          {
            id: 'codex-slice', publicTitle: 'Second [FEATURE] slice', privateTitle: 'Codex source slice',
            publicDescription: 'Implement and verify the second source-changing slice.', privateDescription: 'Codex owns one Shared Signal source slice.',
            kind: 'implementation', impact: 'substantial',
            expectedOutcome: 'Codex lands and verifies one independently attributable Shared Signal source slice.',
            acceptanceChecks: ['The Codex source boundary exists and its direct verification passes.'],
            risk: 'medium', claimedBy: 'codex', files: ['app/codex-*.txt']
          }
        ]
      : [],
    consensus,
    redactions: [{ value: 'Shared Signal', label: 'APP_NAME' }]
  }
}

async function completeOwnedQuotaTask(workspacePath: string, agent: 'claude' | 'codex'): Promise<void> {
  const boardPath = join(workspacePath, '.duo', 'board.json')
  const board = JSON.parse(await readFile(boardPath, 'utf8')) as { tasks?: Array<Record<string, unknown>> }
  board.tasks = (board.tasks ?? []).map((task) => task.claimedBy === agent || task.owner === agent
    ? { ...task, status: 'done' }
    : task)
  await writeFile(boardPath, JSON.stringify(board), 'utf8')
}

class QuotaAwarePolicyRunner implements ProcessRunnerPort {
  readonly calls: Array<{
    agent: 'claude' | 'codex'
    round: number
    stage: string
    effort?: string
    resumed: boolean
  }> = []
  private rejectedResume = false
  private frozenHumanBrief = 'Build a useful, runnable local interaction.'

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const agent = agentOf(options)
    const round = roundOf(options)
    const stage = stageOf(options)
    const prompt = promptOf(options)
    const explicitHumanBrief = prompt.match(/^HUMAN BRIEF\r?\n([^\r\n]+)/mi)?.[1]?.trim()
    if (explicitHumanBrief) this.frozenHumanBrief = explicitHumanBrief
    const resumed = options.command.args.includes('--resume') || options.command.args.includes('resume')
    this.calls.push({ agent, round, stage, effort: effortOf(options), resumed })

    if (agent === 'codex' && stage === 'opening') {
      options.onLine('stdout', JSON.stringify({
        type: 'thread.started',
        thread_id: '019f4d5a-b93c-7910-9f2d-a607a7f6788d'
      }))
    }

    if (stage === 'opening' || stage === 'verdict' || stage === 'recovery') {
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-${String(round)}-${stage}-dispatch-${String(this.calls.length)}`,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        dispatchKind: stage === 'verdict' ? 'verdict' : 'opening',
        publicText: 'I think the shared [FEATURE] should stay bounded and directly testable.',
        spoilerRisk: 0.02
      }))
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-${String(round)}-${stage}-opinion-${String(this.calls.length)}`,
        type: 'opinion',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        tone: 'collaborative',
        publicText: 'The current [FEATURE] has one concrete tradeoff worth challenging.',
        spoilerRisk: 0.02
      }))
    }

    if (stage === 'dialogue') {
      const capsule = quotaDialogueCapsule(round, agent, prompt)
      options.onLine('stdout', agent === 'claude'
        ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: capsule })
        : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } }))
    }

    if (stage === 'work') {
      const latestStatementId = prompt.match(/^LATEST .+ STATEMENT\r?\n([^:\r\n]+):/mi)?.[1]?.trim()
      options.onLine('stdout', JSON.stringify({
        id: `${agent}-${String(round)}-work-dispatch-${String(this.calls.length)}`,
        type: 'agent.dispatch',
        agent,
        targetAgent: agent === 'claude' ? 'codex' : 'claude',
        round,
        dispatchKind: 'verdict',
        claimKey: 'shared-work',
        ...(latestStatementId ? { replyTo: latestStatementId } : {}),
        publicText: 'I have a verified [FEATURE] source handoff for the shared build.',
        privateText: `${agent} hands off the verified Shared Signal source slice.`,
        spoilerRisk: 0.02
      }))
    }

    if (round === 5 && stage === 'work' && !this.rejectedResume) {
      this.rejectedResume = true
      options.onLine('stdout', JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          overageStatus: 'rejected'
        }
      }))
      return result(1)
    }

    if (stage === 'work' && round <= 6) {
      await mkdir(join(options.command.cwd, 'app'), { recursive: true })
      const file = `${agent}-${String(round)}.txt`
      await writeFile(join(options.command.cwd, 'app', file), `${agent} durable source work\n`, 'utf8')
      if (round === 5 || round === 6) await completeOwnedQuotaTask(options.command.cwd, agent)
      if (round === 6) await writeFile(join(options.command.cwd, 'app', 'index.html'), quotaFixtureHtml(this.frozenHumanBrief), 'utf8')
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

    return result()
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

function fixtureSupervisorVerifier(): SupervisorVerifier {
  const browserPort: SupervisorBrowserEvidencePort = {
    capture: async ({ entryPath }) => {
      const html = await readFile(entryPath, 'utf8')
      const interactionSucceeded = /data-fixture-interaction/iu.test(html) &&
        /addEventListener\s*\(\s*['"]click['"]/iu.test(html)
      const viewport = (id: 'compact' | 'full', width: number, height: number, image: string) => ({
        id,
        width,
        height,
        screenshotCaptured: true,
        imageDataUrl: `data:image/png;base64,${image}`,
        visibleTextCharacters: 80,
        mainLandmark: /<main(?:\s|>)/iu.test(html),
        horizontalOverflow: false,
        interactiveElementCount: 1,
        accessibleInteractiveElementCount: 1,
        interactionAttempted: true,
        interactionSucceeded,
        interactionObservedChanges: interactionSucceeded ? ['dom'] : [],
        consoleErrors: [],
        pageErrors: []
      })
      return { viewports: [viewport('compact', 900, 640, 'YQ=='), viewport('full', 1600, 900, 'Yg==')] }
    }
  }
  return new SupervisorVerifier({ run: () => Promise.resolve(result()) }, browserPort)
}

describe('quota-aware turn policy', () => {
  it('caps creative dialogue below Max while preserving extra reasoning for final consensus', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-low-dialogue-'))
    const runner = new QuotaAwarePolicyRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve({
        ...defaultSettings(root),
        codexEffort: 'max',
        claudeEffort: 'max'
      }),
      onSnapshot: () => undefined,
      testOnlyMinimumTurns: 2,
      processRunner: runner,
      supervisorVerifier: fixtureSupervisorVerifier(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start({
      prompt: 'Debate a compact direction without spending Max effort on routine dialogue.',
      workspaceRoot: root,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      maxTurns: 4,
      maxRepairLoops: 0,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 86_400,
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    })
    await orchestrator.waitForSettled(started.runId)

    expect(runner.calls).toHaveLength(4)
    expect(runner.calls.map((call) => ({
      round: call.round,
      stage: call.stage,
      effort: call.effort
    }))).toEqual([
      { round: 1, stage: 'dialogue', effort: 'medium' },
      { round: 2, stage: 'dialogue', effort: 'medium' },
      { round: 3, stage: 'dialogue', effort: 'medium' },
      { round: 4, stage: 'dialogue', effort: 'high' }
    ])
  })

  it('projects Claude allowed-warning and rejected rate-limit signals as quota pressure', () => {
    const context = { runId: 'run-quota-pressure', round: 5, source: 'claude' as const, stream: 'stdout' as const }
    const warning = normalizeCliActivity(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' }
    }), context)
    const rejected = normalizeCliActivity(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected' }
    }), context)

    expect(warning).toMatchObject({
      type: 'agent.activity',
      agent: 'claude',
      topic: 'quota-pressure',
      category: 'status'
    })
    expect(warning?.metadata?.quotaStatus).toBe('allowed_warning')
    expect(warning?.severity).not.toBe('low')
    expect(warning?.publicText).toMatch(/quota|usage|limit/i)
    expect(rejected).toMatchObject({
      type: 'agent.activity',
      agent: 'claude',
      topic: 'quota-pressure',
      category: 'error'
    })
    expect(rejected?.metadata?.quotaStatus).toBe('rejected')
    expect(['high', 'critical']).toContain(rejected?.severity)
    expect(rejected?.publicText).toMatch(/quota|usage|limit/i)
  })

  it('suspends both agents after a quota-rejected work stage without a fresh retry or solo takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-quota-handoff-'))
    const runner = new QuotaAwarePolicyRunner()
    const orchestrator = new RunOrchestrator({
      getSettings: () => Promise.resolve({
        ...defaultSettings(root),
        codexEffort: 'max',
        claudeEffort: 'max'
      }),
      onSnapshot: () => undefined,
      processRunner: runner,
      supervisorVerifier: fixtureSupervisorVerifier(),
      healthProvider: healthyAgents,
      protocolPollMs: 5
    })

    const started = await orchestrator.start({
      prompt: 'Preserve the build and hand off cleanly when one provider rejects a resumed stage.',
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
    await orchestrator.waitForSettled(started.runId)

    const snapshot = orchestrator.getSnapshot(started.runId)
    const rejectedAgent = runner.calls.find((call) => call.round === 5)?.agent
    expect(rejectedAgent).toBeDefined()
    const rejectedWorkCalls = runner.calls.filter((call) =>
      call.agent === rejectedAgent && call.round === 5 && call.stage === 'work'
    )
    expect(rejectedWorkCalls).toHaveLength(1)
    expect(rejectedWorkCalls[0]?.resumed).toBe(false)
    expect(runner.calls.some((call) => call.round > 5)).toBe(false)
    expect(snapshot?.events.some((event) => event.topic === 'session-fallback')).toBe(false)
    expect(snapshot?.events.some((event) => event.topic === 'quota-pressure' && event.category === 'error')).toBe(true)
    expect(snapshot?.events.some((event) => event.topic === 'quota-suspend')).toBe(true)
    expect(snapshot?.events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(snapshot?.status).toBe('paused')
    expect(snapshot?.pause).toMatchObject({ reason: 'provider-quota', provider: rejectedAgent, resumable: true })
    expect(snapshot?.releaseStatus).toBeUndefined()

    await orchestrator.resume(started.runId)
    await orchestrator.waitForSettled(started.runId)
    const resumedRound = runner.calls.filter((call) => call.round === 5)
    expect(resumedRound.filter((call) => call.stage === 'opening')).toHaveLength(0)
    expect(resumedRound.filter((call) => call.stage === 'work')).toHaveLength(2)
    expect(orchestrator.getSnapshot(started.runId)?.status).toBe('reveal-ready')
  })
})
