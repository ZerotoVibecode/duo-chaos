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
  qualityCeiling?: string
  customizationProfile?: 'core' | 'smart' | 'full-local'
  inferenceSteps?: number
  inferenceLimit?: number
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
    agentRuntimes: {
      claude: { model: 'fable', effort: 'max', source: 'studio', qualityCeiling: 'max', customizationProfile: 'smart' },
      codex: { model: 'gpt-5.6-terra', effort: 'low', source: 'studio', qualityCeiling: 'low', customizationProfile: 'core' }
    },
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
      effort: 'high',
      qualityCeiling: 'max',
      customizationProfile: 'smart',
      inferenceSteps: 5,
      inferenceLimit: 8,
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
    expect(pulse).toHaveTextContent(/5\/8 model steps/i)
    expect(pulse).not.toHaveTextContent(/convergence/i)

    const claudeCard = screen.getByRole('article', { name: /claude/i })
    expect(claudeCard).toHaveTextContent(/requested: fable.*max/i)
    expect(claudeCard).toHaveTextContent(/scheduled high/i)
    expect(claudeCard).toHaveTextContent(/max ceiling/i)
    expect(claudeCard).toHaveTextContent(/provider runtime not recorded by duo/i)
    expect(claudeCard).toHaveTextContent(/smart · duo \+ connected tools/i)
    const codexCard = screen.getByRole('article', { name: /codex/i })
    expect(codexCard).toHaveTextContent(/requested: terra.*low/i)
    expect(codexCard).not.toHaveTextContent(/actual low/i)
    expect(codexCard).toHaveTextContent(/provider runtime not recorded by duo/i)
  })

  it('states when Duo did not record the observed runtime for a completed call', () => {
    render(<AgentCard agent="claude" run={run({
      agentUsage: {
        claude: { processedInputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 0, calls: 1, largestRawLineBytes: 32 },
        codex: { processedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0, largestRawLineBytes: 0 }
      }
    })} />)

    expect(screen.getByRole('article', { name: /claude agent/i })).toHaveTextContent(/provider runtime not recorded by duo/i)
  })

  it('shows a validated provider-observed runtime separately from the request', () => {
    render(<AgentCard agent="claude" run={run({
      providerRuntimes: {
        claude: {
          model: 'claude-opus-4-8',
          effort: 'high',
          source: 'claude-system-init',
          recordedAt: '2026-07-10T18:00:01.000Z'
        }
      }
    })} />)

    const card = screen.getByRole('article', { name: /claude agent/i })
    expect(card).toHaveTextContent(/requested: fable.*max/i)
    expect(card).toHaveTextContent(/provider observed: opus.*high/i)
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

  it('remounts and atomically announces the broadcast beat when the live voice changes', () => {
    const opening = event({
      id: 'opening-beat',
      type: 'agent.dispatch',
      agent: 'claude',
      dispatchKind: 'opening',
      publicText: 'I want one unmistakable interaction.'
    })
    const counter = event({
      id: 'counter-beat',
      type: 'agent.dispatch',
      agent: 'codex',
      dispatchKind: 'counter',
      timestamp: '2026-07-10T18:00:10.000Z',
      publicText: 'I agree, but it needs a keyboard path.'
    })
    const { rerender } = render(<BroadcastStage run={run({ events: [opening] })} />)
    const firstBeat = screen.getByTestId('broadcast-beat')

    expect(firstBeat).toHaveAttribute('aria-atomic', 'true')

    rerender(<BroadcastStage run={run({ events: [opening, counter] })} />)

    const nextBeat = screen.getByTestId('broadcast-beat')
    expect(nextBeat).not.toBe(firstBeat)
    expect(nextBeat).toHaveTextContent(/keyboard path/i)
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

  it('reserves BUILD SURVIVED for a genuinely Duo-verified release', () => {
    const ready = run({
      status: 'reveal-ready',
      phase: 'reveal.ready',
      releaseStatus: 'ready',
      tasks: [{ id: 'ship', publicTitle: 'Ship the sealed build', status: 'done', claimedBy: 'claude', risk: 'low', files: [] }],
      events: [
        event({ id: 'passed', type: 'build.passed', agent: 'codex', publicText: 'Verification passed.' }),
        event({
          id: 'duo-quality-state',
          type: 'decision',
          agent: 'director',
          topic: 'quality-evidence-state',
          publicText: 'Both contributions and both reciprocal reviews survive.',
          metadata: { acceptedContributionAgents: ['claude', 'codex'], acceptedReviewAgents: ['claude', 'codex'] }
        }),
        event({ id: 'ready', type: 'reveal.ready', agent: 'director', publicText: 'The sealed result is ready.' })
      ]
    }, { stage: 'verdict', status: 'completed' })

    render(<CompletionTakeover run={ready} busy={false} onReveal={vi.fn()} />)

    const takeover = screen.getByRole('dialog', { name: /the build survived/i })
    expect(within(takeover).getByText(/^BUILD SURVIVED$/i)).toBeVisible()
    expect(within(takeover).getByRole('heading', { name: /^the build survived$/i })).toBeVisible()
    expect(takeover).toHaveTextContent(/sealed result is ready/i)
  })

  it('labels a verified artifact without reciprocal Duo proof as collaboration incomplete', () => {
    const ready = run({
      status: 'reveal-ready',
      phase: 'reveal.ready',
      releaseStatus: 'ready',
      tasks: [{ id: 'ship', publicTitle: 'Ship the sealed build', status: 'done', claimedBy: 'claude', risk: 'low', files: [] }],
      events: [
        event({ id: 'passed', type: 'build.passed', agent: 'codex', publicText: 'Verification passed.' }),
        event({ id: 'ready', type: 'reveal.ready', agent: 'director', publicText: 'The artifact is ready.' })
      ]
    }, { stage: 'verdict', status: 'completed' })

    render(<CompletionTakeover run={ready} busy={false} onReveal={vi.fn()} />)

    const takeover = screen.getByRole('dialog', { name: /artifact verified.*duo proof incomplete/i })
    expect(within(takeover).getByText(/^ARTIFACT VERIFIED$/i)).toBeVisible()
    expect(takeover).toHaveTextContent(/0\/2 accepted contributions/i)
    expect(takeover).toHaveTextContent(/0\/2 current reviews/i)
    expect(takeover).not.toHaveTextContent(/^BUILD SURVIVED$/i)
  })

  it('keeps a partial release visually and verbally distinct from verified tiers', () => {
    const partial = run({
      status: 'reveal-ready',
      phase: 'reveal.ready',
      releaseStatus: 'partial',
      events: [event({ id: 'partial', type: 'reveal.ready', agent: 'director', status: 'partial', publicText: 'A runnable artifact was preserved with caveats.' })]
    }, { stage: 'verdict', status: 'completed' })

    render(<CompletionTakeover run={partial} busy={false} onReveal={vi.fn()} />)

    const takeover = screen.getByRole('dialog', { name: /build reached reveal with caveats/i })
    expect(takeover).toHaveClass('completion-tier-partial')
    expect(within(takeover).getByText(/^CAVEATS DOCUMENTED$/i)).toBeVisible()
    expect(takeover).not.toHaveTextContent(/artifact verified|build survived/i)
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

  it('shows recent factual activity without duplicating repeated CLI signals', () => {
    const repeatedSignal = 'Codex is inspecting the shared workspace.'
    render(<CriticismFeed events={[
      event({ id: 'activity-old', type: 'agent.activity', agent: 'codex', category: 'command', publicText: repeatedSignal }),
      event({ id: 'activity-new', type: 'agent.activity', agent: 'codex', category: 'command', timestamp: '2026-07-10T18:00:10.000Z', publicText: repeatedSignal }),
      event({ id: 'checkpoint', type: 'git.checkpoint', agent: 'director', timestamp: '2026-07-10T18:00:20.000Z', publicText: 'A durable checkpoint was recorded.' }),
      event({ id: 'opinion', type: 'agent.dispatch', agent: 'claude', dispatchKind: 'counter', timestamp: '2026-07-10T18:00:30.000Z', publicText: 'The interaction still needs clearer feedback.' })
    ]} />)

    const liveActivity = screen.getByRole('region', { name: /live activity/i })
    expect(within(liveActivity).getAllByText(repeatedSignal)).toHaveLength(1)
    expect(within(liveActivity).getByText(/durable checkpoint/i)).toBeVisible()
    expect(screen.getByRole('log', { name: /live rivalry/i })).toHaveTextContent(/clearer feedback/i)
  })

  it('describes the quiet activity and dialogue states without claiming hidden content exists', () => {
    render(<CriticismFeed events={[]} />)

    expect(screen.getByRole('region', { name: /live activity/i })).toHaveTextContent(/listening for the first factual workspace signal/i)
    expect(screen.getByRole('log', { name: /live rivalry/i })).toHaveTextContent(/public positions appear here when an agent addresses the other/i)
  })
})
