// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunDashboard } from '../../src/renderer/src/components/RunDashboard'
import { RevealPanel } from '../../src/renderer/src/components/RevealPanel'
import type { DuoElectronApi } from '../../src/shared/electron-api'
import type { DuoEvent, RunSnapshot } from '../../src/shared/types'

function event(overrides: Partial<DuoEvent> & Pick<DuoEvent, 'id' | 'type' | 'agent' | 'publicText'>): DuoEvent {
  return {
    runId: 'run-evidence-ui',
    round: 7,
    timestamp: '2026-07-10T14:00:00.000Z',
    spoilerRisk: 0.05,
    severity: 'medium',
    ...overrides
  }
}

function evidenceRun(status: RunSnapshot['status'] = 'running'): RunSnapshot {
  return {
    runId: 'run-evidence-ui',
    prompt: 'Build something sealed.',
    executionMode: 'simulation',
    visibilityMode: 'spoiler-shield',
    phase: status === 'complete' ? 'complete' : 'round.repair',
    status,
    round: 7,
    totalTurns: 12,
    startedAt: '2026-07-10T14:00:00.000Z',
    workspacePath: 'C:\\DuoChaos\\workspaces\\run-evidence-ui',
    appPath: 'C:\\DuoChaos\\workspaces\\run-evidence-ui\\app',
    tasks: [
      { id: 'claude-task', publicTitle: 'Polish the interaction', status: 'done', claimedBy: 'claude', risk: 'low', files: [] },
      { id: 'codex-task', publicTitle: 'Verify the build', status: 'done', claimedBy: 'codex', risk: 'medium', files: [] },
      { id: 'shared-task', publicTitle: 'Agree the release gate', status: 'done', claimedBy: 'both', risk: 'medium', files: [] },
      { id: 'open-task', publicTitle: 'Smoke test the result', status: 'open', risk: 'low', files: [] }
    ],
    events: [
      event({ id: 'claude-challenge', type: 'agent.dispatch', agent: 'claude', targetAgent: 'codex', dispatchKind: 'challenge', publicText: 'Claude challenged the interaction contract.' }),
      event({ id: 'codex-counter', type: 'opinion', agent: 'codex', targetAgent: 'claude', dispatchKind: 'counter', publicText: 'Codex countered with a runnable boundary.' }),
      event({ id: 'decision', type: 'decision', agent: 'director', winner: 'claude', publicText: 'Claude\'s call was accepted.' }),
      event({ id: 'claude-file', type: 'cli.log', agent: 'claude', category: 'file', publicText: 'Claude changed the focused interaction.' }),
      event({ id: 'codex-file', type: 'file.changed', agent: 'codex', publicText: 'Codex changed the verification harness.' }),
      event({ id: 'repair', type: 'repair.completed', agent: 'codex', publicText: 'Codex completed the repair.' }),
      event({ id: 'failed', type: 'build.failed', agent: 'claude', publicText: 'The first build failed.' }),
      event({ id: 'passed', type: 'build.passed', agent: 'codex', publicText: 'The verification gate passed.' }),
      event({ id: 'checkpoint', type: 'git.checkpoint', agent: 'director', publicText: 'Checkpoint recorded.' })
    ],
    ...(status === 'complete' ? {
      finishedAt: '2026-07-10T14:20:00.000Z',
      revealPacket: {
        appName: 'Signal Garden',
        idea: 'A revealed local interaction.',
        summary: 'The two agents shipped a small working result.',
        features: ['One complete interaction'],
        runCommand: 'Open app/index.html',
        appPath: 'app/index.html',
        status: 'ready' as const,
        whatWorked: ['The direct-open page passed verification.'],
        knownIssues: [],
        agentDramaSummary: ['One explicit decision survived the build.'],
        gitCheckpoints: ['checkpoint'],
        agentQuotes: { claude: 'The interaction now has a clear boundary.', codex: 'The verification gate passed.' }
      }
    } : {})
  }
}

describe('Evidence Momentum', () => {
  beforeEach(() => {
    window.duo = {
      getArtifactPreview: vi.fn().mockResolvedValue({
        status: 'unavailable',
        reason: 'no-built-artifact',
        message: 'No built browser artifact is available for preview.'
      }),
      openGeneratedApp: vi.fn().mockResolvedValue(undefined),
      openRunFolder: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn().mockResolvedValue(undefined)
    } as unknown as DuoElectronApi
  })
  afterEach(() => cleanup())

  it('keeps a factual live evidence board above Task Storm', () => {
    render(<RunDashboard run={evidenceRun()} />)

    const momentum = screen.getByRole('region', { name: /evidence momentum/i })
    const taskStorm = screen.getByRole('region', { name: /mission board/i })
    expect(momentum.compareDocumentPosition(taskStorm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const claude = within(momentum).getByTestId('momentum-claude')
    const codex = within(momentum).getByTestId('momentum-codex')
    expect(claude).toHaveTextContent('1 challenge')
    expect(claude).toHaveTextContent('1 accepted call')
    expect(claude).toHaveTextContent('1 edit')
    expect(claude).toHaveTextContent('2 tasks')
    expect(codex).toHaveTextContent('1 repair save')
    expect(codex).toHaveTextContent('The verification gate passed.')
    expect(momentum).toHaveTextContent('3/4 tasks')
    expect(momentum).toHaveTextContent('1 passed')
    expect(momentum).toHaveTextContent('1 failed')
    expect(momentum).toHaveTextContent('1 checkpoint')
    expect(momentum).not.toHaveTextContent(/winner|leader|score/i)
  })

  it('leads with an Artifact Premiere and keeps the detailed Battle Receipt optional', async () => {
    vi.mocked(window.duo.getArtifactPreview).mockResolvedValue({
      status: 'ready',
      imageDataUrl: 'data:image/png;base64,cGl4ZWxz',
      width: 1280,
      height: 720,
      capturedAt: '2026-07-10T14:20:01.000Z'
    })
    const completed = evidenceRun('complete')
    completed.activeTimeMs = 321_000
    render(<RevealPanel run={completed} />)

    const premiere = screen.getByRole('region', { name: /artifact premiere/i })
    expect(premiere).toHaveTextContent('Signal Garden')
    expect(premiere).toHaveTextContent(/verified artifact/i)
    expect(await within(premiere).findByRole('button', { name: /launch signal garden/i })).toBeVisible()
    expect(premiere).toHaveTextContent(/3\/4 tasks/i)
    expect(within(premiere).getByText(/verification passed/i)).toBeVisible()
    expect(premiere).toHaveTextContent('5m 21s')
    expect(premiere).not.toHaveTextContent('20m 0s')
    expect(screen.queryByRole('region', { name: /battle receipt/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /open technical proof/i }))
    const receipt = screen.getByRole('region', { name: /battle receipt/i })
    expect(receipt).toHaveTextContent('Recorded proof only')
    expect(receipt).toHaveTextContent('3/4 tasks')
    expect(within(receipt).getByTestId('momentum-claude')).toHaveTextContent('1 accepted call')
    expect(within(receipt).getByTestId('momentum-codex')).toHaveTextContent('1 repair save')
    expect(receipt).not.toHaveTextContent(/winner|leader|score/i)
  })

  it('shows trusted CLI verification evidence even when no legacy build.passed event exists', () => {
    const run = evidenceRun('complete')
    run.events = [
      ...run.events.filter((item) => item.type !== 'build.passed'),
      event({
        id: 'typed-verification',
        type: 'agent.activity',
        agent: 'codex',
        category: 'command',
        publicText: 'Codex finished a verification command.',
        metadata: { verificationPassed: true }
      })
    ]

    render(<RevealPanel run={run} />)

    expect(within(screen.getByRole('region', { name: /artifact premiere/i })).getByText(/verification passed/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /open technical proof/i }))
    expect(screen.getByRole('region', { name: /battle receipt/i })).toHaveTextContent('1 passed')
  })

  it('shows the authoritative ready release as verified when its public timeline has no pass event', () => {
    const run = evidenceRun('complete')
    run.releaseStatus = 'ready'
    run.events = run.events.filter((item) => item.type !== 'build.passed')

    render(<RevealPanel run={run} />)

    expect(within(screen.getByRole('region', { name: /artifact premiere/i })).getByText(/verification passed/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /open technical proof/i }))
    const receipt = screen.getByRole('region', { name: /battle receipt/i })
    expect(receipt).toHaveTextContent('1 passed')
    expect(receipt).not.toHaveTextContent('2 passed')
  })

  it('does not preserve a stale verification pass after a later typed failure', () => {
    const run = evidenceRun('complete')
    run.releaseStatus = 'partial'
    if (run.revealPacket) run.revealPacket.status = 'partial'
    run.events = [
      ...run.events.filter((item) => item.type !== 'build.passed' && item.type !== 'build.failed'),
      event({
        id: 'typed-verification-pass',
        type: 'agent.activity',
        agent: 'claude',
        category: 'command',
        publicText: 'Claude finished a verification command.',
        metadata: { verificationPassed: true }
      }),
      event({
        id: 'typed-verification-failure',
        type: 'agent.activity',
        agent: 'codex',
        category: 'error',
        publicText: 'Codex found a later verification failure.',
        metadata: { verificationFailed: true }
      })
    ]

    render(<RevealPanel run={run} />)

    expect(within(screen.getByRole('region', { name: /artifact premiere/i })).getByText(/verification not recorded/i)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /open technical proof/i }))
    const receipt = screen.getByRole('region', { name: /battle receipt/i })
    expect(receipt).toHaveTextContent('0 passed')
    expect(receipt).toHaveTextContent('1 failed')
  })

  it('keeps utility commands hidden until Run details is opened', () => {
    render(<RevealPanel run={evidenceRun('complete')} />)

    expect(screen.queryByText('Open app/index.html')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /open run details/i }))
    expect(screen.getByText('Open app/index.html')).toBeVisible()
  })

  it('renders only captured pixels from the isolated artifact preview', async () => {
    vi.mocked(window.duo.getArtifactPreview).mockResolvedValue({
      status: 'ready',
      imageDataUrl: 'data:image/png;base64,cGl4ZWxz',
      width: 1280,
      height: 720,
      capturedAt: '2026-07-10T14:20:01.000Z'
    })

    render(<RevealPanel run={evidenceRun('complete')} />)

    const preview = await screen.findByRole('img', { name: /signal garden artifact preview/i })
    expect(preview).toHaveAttribute('src', 'data:image/png;base64,cGl4ZWxz')
    expect(screen.getByText(/artifact rendered in an isolated preview/i)).toBeVisible()
    expect(document.body.innerHTML).not.toContain('<script>')
  })

  it('does not offer a broken launch when a ready package has no built artifact', async () => {
    render(<RevealPanel run={evidenceRun('complete')} />)

    expect(await screen.findByText(/preview unavailable/i)).toBeVisible()
    const inspect = screen.getByRole('button', { name: /inspect app workspace/i })
    expect(inspect).toBeVisible()
    expect(screen.queryByRole('button', { name: /launch signal garden/i })).not.toBeInTheDocument()
    fireEvent.click(inspect)
    expect(window.duo.openRunFolder).toHaveBeenCalledWith('run-evidence-ui')
    expect(window.duo.openGeneratedApp).not.toHaveBeenCalled()
  })

  it('lets a transient preview capture failure retry without leaving the reveal', async () => {
    vi.mocked(window.duo.getArtifactPreview)
      .mockResolvedValueOnce({ status: 'failed', reason: 'capture-failed', message: 'Transient capture failure.' })
      .mockResolvedValueOnce({
        status: 'ready',
        imageDataUrl: 'data:image/png;base64,cmV0cmllZA==',
        width: 1280,
        height: 720,
        capturedAt: '2026-07-10T14:20:02.000Z'
      })

    render(<RevealPanel run={evidenceRun('complete')} />)

    fireEvent.click(await screen.findByRole('button', { name: /retry artifact preview/i }))
    expect(await screen.findByRole('img', { name: /signal garden artifact preview/i })).toHaveAttribute(
      'src',
      'data:image/png;base64,cmV0cmllZA=='
    )
    expect(window.duo.getArtifactPreview).toHaveBeenCalledTimes(2)
  })
})
