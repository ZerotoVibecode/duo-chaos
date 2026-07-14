import { describe, expect, it } from 'vitest'
import * as contributions from '../../src/renderer/src/lib/contributions'
import type { DuoEvent, RunSnapshot } from '../../src/shared/types'

type Momentum = {
  agents: {
    claude: { challenges: number; acceptedCalls: number; edits: number; tasksDone: number; repairSaves: number; latestMove?: string }
    codex: { challenges: number; acceptedCalls: number; edits: number; tasksDone: number; repairSaves: number; latestMove?: string }
  }
  shared: {
    tasksDone: number
    tasksTotal: number
    buildPasses: number
    buildFailures: number
    checkpoints: number
    acceptedContributions: number
    acceptedContributionGoal: number
    acceptedReviews: number
    acceptedReviewGoal: number
    browser: {
      available: boolean
      smokePassed: boolean
      compactScreenshot: boolean
      fullscreenScreenshot: boolean
      consoleHealthy: boolean
      interactionPassed: boolean
      passed: boolean
    }
  }
}

const deriveEvidenceMomentum = (contributions as unknown as {
  deriveEvidenceMomentum?: (run: RunSnapshot) => Momentum
}).deriveEvidenceMomentum

function event(overrides: Partial<DuoEvent> & Pick<DuoEvent, 'id' | 'type' | 'agent' | 'publicText'>): DuoEvent {
  return {
    runId: 'run-momentum',
    round: 4,
    timestamp: '2026-07-10T14:00:00.000Z',
    spoilerRisk: 0.05,
    severity: 'medium',
    ...overrides
  }
}

function run(events: DuoEvent[]): RunSnapshot {
  return {
    runId: 'run-momentum',
    prompt: 'Build something sealed.',
    executionMode: 'simulation',
    visibilityMode: 'spoiler-shield',
    phase: 'round.repair',
    status: 'running',
    round: 4,
    startedAt: '2026-07-10T14:00:00.000Z',
    workspacePath: 'C:\\DuoChaos\\workspaces\\run-momentum',
    appPath: 'C:\\DuoChaos\\workspaces\\run-momentum\\app',
    tasks: [
      { id: 'claude-task', publicTitle: 'Polish the public interaction', status: 'done', claimedBy: 'claude', risk: 'low', files: [] },
      { id: 'codex-task', publicTitle: 'Verify the build', status: 'done', claimedBy: 'codex', risk: 'medium', files: [] },
      { id: 'shared-task', publicTitle: 'Agree the release gate', status: 'done', claimedBy: 'both', risk: 'medium', files: [] },
      { id: 'open-task', publicTitle: 'Smoke test the result', status: 'open', risk: 'low', files: [] }
    ],
    events
  }
}

describe('evidence momentum derivation', () => {
  it('exposes the deterministic evidence derivation API', () => {
    expect(deriveEvidenceMomentum).toBeTypeOf('function')
  })

  it('credits only recorded agent evidence, including simulation file signals', () => {
    if (!deriveEvidenceMomentum) return
    const snapshot = run([
      event({ id: 'claude-challenge', type: 'agent.dispatch', agent: 'claude', targetAgent: 'codex', dispatchKind: 'challenge', publicText: 'Claude challenges the ambiguous input contract.', privateText: 'SECRET_APP_NAME' }),
      event({ id: 'codex-counter', type: 'opinion', agent: 'codex', targetAgent: 'claude', dispatchKind: 'counter', publicText: 'Codex counters with a smaller runnable boundary.' }),
      event({ id: 'decision-claude', type: 'decision', agent: 'director', winner: 'claude', publicText: 'Claude\'s input boundary was accepted.' }),
      event({ id: 'decision-split', type: 'decision', agent: 'director', winner: 'split', publicText: 'The agents split this call.' }),
      event({ id: 'claude-file', type: 'cli.log', agent: 'claude', category: 'file', publicText: 'Claude changed two workspace files.' }),
      event({ id: 'codex-file', type: 'file.changed', agent: 'codex', publicText: 'Codex changed one workspace file.' }),
      event({ id: 'repair-save', type: 'repair.completed', agent: 'codex', publicText: 'Codex completed the repair.' }),
      event({ id: 'pass', type: 'build.passed', agent: 'codex', publicText: 'Verification passed.' }),
      event({ id: 'fail', type: 'build.failed', agent: 'claude', publicText: 'The first build failed.' }),
      event({ id: 'checkpoint', type: 'git.checkpoint', agent: 'director', publicText: 'Checkpoint recorded.' })
    ])

    const result = deriveEvidenceMomentum(snapshot)

    expect(result.agents.claude).toMatchObject({ challenges: 1, acceptedCalls: 1, edits: 1, tasksDone: 2, repairSaves: 0 })
    expect(result.agents.codex).toMatchObject({ challenges: 1, acceptedCalls: 0, edits: 1, tasksDone: 2, repairSaves: 1 })
    expect(result.shared).toEqual({
      tasksDone: 3,
      tasksTotal: 4,
      buildPasses: 0,
      buildFailures: 1,
      checkpoints: 1,
      acceptedContributions: 0,
      acceptedContributionGoal: 2,
      acceptedReviews: 0,
      acceptedReviewGoal: 2,
      brief: {
        available: false,
        passed: false,
        passedChecks: 0,
        totalChecks: 0
      },
      browser: {
        available: false,
        smokePassed: false,
        compactScreenshot: false,
        fullscreenScreenshot: false,
        consoleHealthy: false,
        interactionPassed: false,
        passed: false
      }
    })
  })

  it('uses only public recorded moves and never infers a winner from activity volume', () => {
    if (!deriveEvidenceMomentum) return
    const snapshot = run([
      event({ id: 'private-only', type: 'agent.activity', agent: 'claude', category: 'reasoning', publicText: '', privateText: 'Claude secretly won everything.' }),
      event({ id: 'supportive-opinion', type: 'opinion', agent: 'claude', targetAgent: 'codex', publicText: 'Claude agrees with Codex and endorses the same direction.' }),
      event({ id: 'codex-one', type: 'agent.activity', agent: 'codex', category: 'command', publicText: 'Codex inspected the current build.' }),
      event({ id: 'codex-two', type: 'agent.activity', agent: 'codex', category: 'command', publicText: 'Codex ran one verification command.' })
    ])

    const result = deriveEvidenceMomentum(snapshot)
    const serialized = JSON.stringify(result)

    expect(result.agents.claude.latestMove).toBe('Claude agrees with Codex and endorses the same direction.')
    expect(result.agents.claude.challenges).toBe(0)
    expect(result.agents.claude.acceptedCalls).toBe(0)
    expect(result.agents.codex.acceptedCalls).toBe(0)
    expect(result.agents.codex.latestMove).toBe('Codex ran one verification command.')
    expect(serialized).not.toContain('secretly won')
    expect(serialized).not.toMatch(/score|leader|winner/i)
  })

  it('projects one verified pass from an authoritative ready release without a public pass event', () => {
    if (!deriveEvidenceMomentum) return
    const snapshot = run([])
    snapshot.releaseStatus = 'ready'

    expect(deriveEvidenceMomentum(snapshot).shared.buildPasses).toBe(1)

    snapshot.releaseStatus = 'partial'
    expect(deriveEvidenceMomentum(snapshot).shared.buildPasses).toBe(0)
  })
})
