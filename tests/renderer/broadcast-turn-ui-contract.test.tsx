// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCard } from '../../src/renderer/src/components/AgentCard'
import { BroadcastStage } from '../../src/renderer/src/components/BroadcastStage'
import { CompletionTakeover } from '../../src/renderer/src/components/CompletionTakeover'
import { CriticismFeed } from '../../src/renderer/src/components/CriticismFeed'
import { RunDashboard } from '../../src/renderer/src/components/RunDashboard'
import type { DuoEvent, RunSnapshot } from '../../src/shared/types'

type TurnStage = {
  turnId: string
  agent: 'claude' | 'codex'
  kind: string
  stage: 'dialogue' | 'opening' | 'work' | 'verdict' | 'recovery'
  status: 'running' | 'completed' | 'timeboxed' | 'paused'
  startedAt: string
  deadlineAt: string
  attempt: number
  effort?: string
  nextAgent?: 'claude' | 'codex'
}

type SnapshotWithTurnStage = RunSnapshot & { turnStage: TurnStage }

function event(overrides: Partial<DuoEvent> & Pick<DuoEvent, 'id' | 'type' | 'agent' | 'publicText'>): DuoEvent {
  return {
    runId: 'run-broadcast-turn-ui',
    round: 3,
    timestamp: '2026-07-10T18:00:00.000Z',
    spoilerRisk: 0.05,
    severity: 'medium',
    ...overrides
  }
}

function run(overrides: Partial<RunSnapshot> = {}, turnStage?: Partial<TurnStage>): RunSnapshot {
  const snapshot: SnapshotWithTurnStage = {
    runId: 'run-broadcast-turn-ui',
    prompt: 'Build something sealed.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: 'round.code',
    status: 'running',
    round: 3,
    totalTurns: 8,
    startedAt: '2026-07-10T18:00:00.000Z',
    workspacePath: 'C:\\DuoChaos\\workspaces\\run-broadcast-turn-ui',
    appPath: 'C:\\DuoChaos\\workspaces\\run-broadcast-turn-ui\\app',
    activeAgent: 'claude',
    tasks: [],
    events: [],
    turnStage: {
      turnId: 'turn-03-claude-code',
      agent: 'claude',
      kind: 'code',
      stage: 'work',
      status: 'running',
      startedAt: '2026-07-10T18:00:00.000Z',
      deadlineAt: '2026-07-10T20:00:00.000Z',
      attempt: 1,
      effort: 'max',
      nextAgent: 'codex',
      ...turnStage
    },
    ...overrides
  }
  return snapshot
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('broadcast turn UI contract', () => {
  it('renders the sourced Opening -> Counter -> Verdict exchange without substituting activity copy', () => {
    const events = [
      event({ id: 'opening', type: 'agent.dispatch', agent: 'claude', dispatchKind: 'opening', claimKey: 'focus', targetAgent: 'codex', publicText: 'I want one unmistakable interaction.' }),
      event({ id: 'counter', type: 'agent.dispatch', agent: 'codex', dispatchKind: 'counter', claimKey: 'focus', replyTo: 'opening', targetAgent: 'claude', timestamp: '2026-07-10T18:00:10.000Z', publicText: 'I agree, but it needs a keyboard path.' }),
      event({ id: 'verdict', type: 'decision', agent: 'director', claimKey: 'focus', replyTo: 'counter', timestamp: '2026-07-10T18:00:20.000Z', publicText: 'Both the focused interaction and keyboard path survive.' }),
      event({ id: 'activity', type: 'agent.activity', agent: 'claude', category: 'reasoning', timestamp: '2026-07-10T18:00:30.000Z', publicText: 'Claude is evaluating the next move.' })
    ]

    render(<BroadcastStage run={run({ events })} />)

    const rail = screen.getByRole('list', { name: /exchange progress/i })
    const opening = within(rail).getByTestId('exchange-opening')
    const counter = within(rail).getByTestId('exchange-counter')
    const verdict = within(rail).getByTestId('exchange-verdict')
    expect(opening).toHaveAttribute('data-source-event-id', 'opening')
    expect(counter).toHaveAttribute('data-source-event-id', 'counter')
    expect(verdict).toHaveAttribute('data-source-event-id', 'verdict')
    expect(opening).toHaveTextContent(/opening.*claude/i)
    expect(counter).toHaveTextContent(/counter.*codex/i)
    expect(verdict).toHaveTextContent(/verdict.*director/i)
    expect(rail).not.toHaveTextContent(/evaluating the next move/i)
  })

  it('keeps the active stage and long work lease visible in the pulse bar', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-10T18:05:00.000Z')

    render(<RunDashboard run={run()} />)

    const pulse = screen.getByRole('region', { name: /run pulse/i })
    expect(pulse).toHaveTextContent(/turn 3 of 8/i)
    expect(pulse).toHaveTextContent(/work lease/i)
    expect(pulse).toHaveTextContent(/01:55:00 left/i)
    expect(pulse).not.toHaveTextContent(/convergence/i)
  })

  it('surfaces typed verification failures as decisive live evidence', () => {
    render(<BroadcastStage run={run({
      events: [event({
        id: 'typed-verification-failure',
        type: 'agent.activity',
        agent: 'claude',
        category: 'error',
        publicText: 'Claude finished a verification command that failed.',
        metadata: { verificationFailed: true }
      })]
    })} />)

    const beat = screen.getByTestId('broadcast-beat')
    expect(beat).toHaveAttribute('data-beat-kind', 'failure')
    expect(beat).toHaveTextContent(/verification command that failed/i)
  })

  it('freezes elapsed time at finishedAt after a run ends', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-10T21:00:00.000Z')

    render(<RunDashboard run={run({
      status: 'failed',
      phase: 'failed',
      finishedAt: '2026-07-10T18:12:00.000Z'
    }, { status: 'timeboxed' })} />)

    const elapsedLabel = screen.getByText('Elapsed')
    const metric = elapsedLabel.closest('span')
    expect(metric).not.toBeNull()
    expect(within(metric as HTMLElement).getByText('12:00')).toBeVisible()
  })

  it('does not call a failed run agent Working even if the stale snapshot names it active', () => {
    const { container } = render(<AgentCard agent="claude" run={run({ status: 'failed', phase: 'failed', finishedAt: '2026-07-10T18:12:00.000Z' }, { status: 'timeboxed' })} />)

    const state = container.querySelector('.agent-state')
    expect(state).not.toBeNull()
    expect(state).not.toHaveTextContent(/^working$/i)
    expect(state).toHaveTextContent(/standing by|timeboxed/i)
  })

  it('announces a genuinely ready release as BUILD SURVIVED', () => {
    const ready = run({
      status: 'reveal-ready',
      phase: 'reveal.ready',
      releaseStatus: 'ready',
      tasks: [{ id: 'ship', publicTitle: 'Ship the sealed build', status: 'done', claimedBy: 'claude', risk: 'low', files: [] }],
      events: [
        event({ id: 'passed', type: 'build.passed', agent: 'codex', publicText: 'Verification passed.' }),
        event({ id: 'ready', type: 'reveal.ready', agent: 'director', publicText: 'The sealed result is ready.' })
      ]
    }, { stage: 'verdict', status: 'completed' })

    render(<CompletionTakeover run={ready} busy={false} onReveal={vi.fn()} />)

    const takeover = screen.getByRole('region', { name: /the build survived/i })
    expect(within(takeover).getByText(/^BUILD SURVIVED$/i)).toBeVisible()
    expect(within(takeover).getByRole('heading', { name: /^the build survived$/i })).toBeVisible()
    expect(takeover).toHaveTextContent(/sealed result is ready/i)
  })

  it('exposes the selected criticism filter through aria-pressed', () => {
    render(<CriticismFeed events={[
      event({ id: 'opinion', type: 'agent.dispatch', agent: 'claude', dispatchKind: 'counter', publicText: 'I want the verification evidence on record.' })
    ]} />)

    const all = screen.getByRole('button', { name: /^all$/i })
    const claude = screen.getByRole('button', { name: /^claude$/i })
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(claude).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(claude)

    expect(all).toHaveAttribute('aria-pressed', 'false')
    expect(claude).toHaveAttribute('aria-pressed', 'true')
  })
})
