// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { RecentBuilds } from '../../src/renderer/src/components/RecentBuilds'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { DuoElectronApi } from '../../src/shared/electron-api'
import type { RecentBuildSummary, RunSnapshot } from '../../src/shared/types'

function pausedRun(): RunSnapshot {
  return {
    runId: 'duo-run-paused-quota',
    prompt: 'Build something sealed and surprising.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: 'paused',
    status: 'paused',
    round: 3,
    totalTurns: 12,
    startedAt: '2026-07-11T09:00:00.000Z',
    activeTimeMs: 123_000,
    workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-paused-quota',
    appPath: 'C:\\DuoChaos\\workspaces\\duo-run-paused-quota\\app',
    tasks: [],
    events: [],
    pause: {
      reason: 'provider-quota',
      provider: 'claude',
      message: "Claude's five-hour allowance is exhausted.",
      pausedAt: '2026-07-11T09:02:03.000Z',
      resetAt: '2026-07-11T09:12:03.000Z',
      resumable: true,
      round: 3,
      stage: 'dialogue',
      action: 'Wait for the allowance to reset, then resume this battle.'
    }
  }
}

function api(run = pausedRun()): DuoElectronApi {
  const settings = defaultSettings('C:\\DuoChaos\\workspaces')
  return {
    getBootstrap: vi.fn().mockResolvedValue({ settings, health: [], runs: [run], recentBuilds: [], platform: 'win32' }),
    refreshHealth: vi.fn().mockResolvedValue([]),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn().mockResolvedValue(settings),
    startRun: vi.fn().mockResolvedValue({ runId: run.runId, workspacePath: run.workspacePath }),
    stopRun: vi.fn().mockResolvedValue({ ...run, phase: 'cancelled', status: 'cancelled' }),
    resumeRun: vi.fn().mockResolvedValue({ ...run, phase: 'round.critique', status: 'running', pause: undefined }),
    revealRun: vi.fn(),
    revealPartialRun: vi.fn().mockResolvedValue({ ...run, phase: 'complete', status: 'complete', pause: undefined }),
    openArchivedRun: vi.fn().mockResolvedValue(run),
    openRunFolder: vi.fn().mockResolvedValue(undefined),
    openGeneratedApp: vi.fn().mockResolvedValue(undefined),
    getArtifactPreview: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'no-built-artifact', message: 'No artifact.' }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    openAgentCli: vi.fn().mockResolvedValue(undefined),
    onRunSnapshot: vi.fn().mockReturnValue(() => undefined),
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    toggleMaximizeWindow: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined)
  }
}

function pausedRecentBuild(): RecentBuildSummary {
  return {
    runId: 'duo-run-paused-archive',
    startedAt: '2026-07-11T09:00:00.000Z',
    status: 'paused',
    phase: 'paused',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    prompt: 'PRIVATE PAUSED PROMPT',
    workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-paused-archive',
    workspaceRoot: 'C:\\DuoChaos\\workspaces',
    sealed: true,
    recoverable: true,
    resumable: true,
    proof: {
      tasksDone: 1,
      tasksTotal: 2,
      checkpoints: 1,
      buildPasses: 0,
      claude: { turns: 1, edits: 1, messages: 2, tasksDone: 1 },
      codex: { turns: 1, edits: 0, messages: 2, tasksDone: 0 }
    }
  }
}

describe('paused battle presentation and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime('2026-07-11T09:02:03.000Z')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('restores a paused run as the active battle and presents only recorded recovery facts', async () => {
    window.duo = api()
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    expect(document.querySelector('.run-shell')).toHaveClass('run-shell-paused')
    expect(document.querySelector('.status-chip')).toHaveTextContent(/^Paused$/i)
    expect(within(panel).getByRole('heading', { name: /battle suspended/i })).toBeVisible()
    expect(panel).toHaveTextContent(/Claude quota reached/i)
    expect(panel).toHaveTextContent(/support code/i)
    expect(panel).toHaveTextContent('provider-quota')
    expect(panel).toHaveTextContent("Claude's five-hour allowance is exhausted.")
    expect(panel).toHaveTextContent('Wait for the allowance to reset, then resume this battle.')
    expect(panel).toHaveTextContent(/retry window opens in 10m/i)
    expect(within(panel).getByRole('button', { name: /resume battle/i })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: /open workspace/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeEnabled()
  })

  it('freezes active elapsed time while the battle is paused', async () => {
    window.duo = api()
    render(<App />)

    await screen.findByRole('region', { name: /battle suspended/i })
    const elapsedMetric = screen.getByText('Elapsed').closest('span')
    expect(elapsedMetric).not.toBeNull()
    expect(within(elapsedMetric as HTMLElement).getByText('02:03')).toBeVisible()

    vi.advanceTimersByTime(30 * 60_000)
    expect(within(elapsedMetric as HTMLElement).getByText('02:03')).toBeVisible()
  })

  it('describes an internal model-step boundary without implying the full work lease expired', async () => {
    const run = pausedRun()
    run.pause = {
      ...run.pause!,
      reason: 'stage-timeout',
      resetAt: undefined,
      message: 'Claude reached the bounded reasoning capsule before trusted work evidence landed.',
      action: 'Resume starts a fresh bounded capsule for the same preserved turn.'
    }
    run.turnStage = {
      turnId: 'turn-08-claude-repair',
      agent: 'claude',
      kind: 'repair',
      stage: 'work',
      status: 'paused',
      startedAt: '2026-07-11T09:00:00.000Z',
      deadlineAt: '2026-07-11T11:00:00.000Z',
      attempt: 1,
      inferenceSteps: 9,
      inferenceLimit: 8,
      continuationCount: 1
    }
    window.duo = api(run)
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    expect(panel).toHaveTextContent(/work paused at a safe model-step boundary/i)
    expect(panel).not.toHaveTextContent(/work lease expired/i)
  })

  it('keeps generic stage-timeout copy for non-Claude-capsule pauses', async () => {
    const run = pausedRun()
    run.pause = {
      ...run.pause!,
      reason: 'stage-timeout',
      provider: 'codex',
      resetAt: undefined,
      message: 'Codex reached the current stage time boundary.',
      action: 'Resume retries the same preserved stage.'
    }
    run.turnStage = {
      turnId: 'turn-09-codex-verify',
      agent: 'codex',
      kind: 'verify',
      stage: 'work',
      status: 'paused',
      startedAt: '2026-07-11T09:00:00.000Z',
      deadlineAt: '2026-07-11T11:00:00.000Z',
      attempt: 1
    }
    window.duo = api(run)
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    expect(panel).toHaveTextContent(/agent stage reached its time boundary/i)
    expect(panel).not.toHaveTextContent(/model-step boundary/i)
  })

  it('resumes the same run and opens its preserved workspace', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const bridge = api()
    window.duo = bridge
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    await user.click(within(panel).getByRole('button', { name: /open workspace/i }))
    await user.click(within(panel).getByRole('button', { name: /resume battle/i }))

    await waitFor(() => expect(bridge.openRunFolder).toHaveBeenCalledWith('duo-run-paused-quota'))
    await waitFor(() => expect(bridge.resumeRun).toHaveBeenCalledWith('duo-run-paused-quota'))
    await waitFor(() => expect(screen.queryByRole('region', { name: /battle suspended/i })).not.toBeInTheDocument())
  })

  it('keeps the paused battle on screen when resume fails', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const bridge = api()
    vi.mocked(bridge.resumeRun).mockRejectedValue(new Error('Provider allowance has not reset yet.'))
    window.duo = bridge
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    await user.click(within(panel).getByRole('button', { name: /resume battle/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider allowance has not reset yet.')
    expect(screen.getByRole('region', { name: /battle suspended/i })).toBeVisible()
  })

  it('keeps a repairable partial sealed and requires explicit confirmation before revealing it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const run = pausedRun()
    run.releaseStatus = 'partial'
    run.pause = {
      reason: 'quality-repair',
      message: 'The artifact is preserved, but release proof is incomplete.',
      pausedAt: '2026-07-11T09:02:03.000Z',
      resumable: true,
      round: 7,
      stage: 'work',
      action: 'Resume reserved quality repair, or explicitly reveal the partial artifact.',
      missingEvidence: [
        'Independent verification',
        'Claude reply-linked cross-review'
      ]
    }
    const bridge = api(run)
    window.duo = bridge
    render(<App />)

    const panel = await screen.findByRole('region', { name: /battle suspended/i })
    expect(panel).toHaveTextContent(/quality repair is ready/i)
    expect(panel).toHaveTextContent('Independent verification')
    expect(panel).toHaveTextContent('Claude reply-linked cross-review')
    const partialTrigger = within(panel).getByRole('button', { name: /reveal partial anyway/i })
    await user.click(partialTrigger)

    let confirmation = screen.getByRole('alertdialog', { name: /reveal this partial build/i })
    expect(bridge.revealPartialRun).not.toHaveBeenCalled()
    expect(within(confirmation).getByRole('button', { name: /keep it sealed/i })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog', { name: /reveal this partial build/i })).not.toBeInTheDocument()
    expect(partialTrigger).toHaveFocus()

    await user.click(partialTrigger)
    confirmation = screen.getByRole('alertdialog', { name: /reveal this partial build/i })
    await user.click(within(confirmation).getByRole('button', { name: /reveal preserved partial/i }))
    await waitFor(() => expect(bridge.revealPartialRun).toHaveBeenCalledWith(run.runId))
  })

  it('labels resumable paused archives as Resume battle without rewriting failed runs', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onRecover = vi.fn()
    const onResume = vi.fn()
    render(<RecentBuilds builds={[pausedRecentBuild()]} onRecover={onRecover} onResume={onResume} />)

    const recent = screen.getByRole('region', { name: /recent builds/i })
    expect(within(recent).getByText(/^Paused$/i)).toBeVisible()
    expect(within(recent).queryByRole('button', { name: /use prompt again/i })).not.toBeInTheDocument()
    await user.click(within(recent).getByRole('button', { name: /resume battle/i }))
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ runId: 'duo-run-paused-archive' }))
    expect(onRecover).not.toHaveBeenCalled()
  })

  it('offers prompt recovery instead of a broken Resume action for a legacy paused archive', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onRecover = vi.fn()
    const onResume = vi.fn()
    const legacy = { ...pausedRecentBuild(), resumable: false }
    render(<RecentBuilds builds={[legacy]} onRecover={onRecover} onResume={onResume} />)

    const recent = screen.getByRole('region', { name: /recent builds/i })
    expect(within(recent).queryByRole('button', { name: /resume battle/i })).not.toBeInTheDocument()
    await user.click(within(recent).getByRole('button', { name: /use prompt again/i }))
    expect(onRecover).toHaveBeenCalledWith(expect.objectContaining({ runId: legacy.runId }))
    expect(onResume).not.toHaveBeenCalled()
  })

  it('labels an authoritative ready archive as verified even when its timeline proof was not public', () => {
    const ready: RecentBuildSummary = {
      ...pausedRecentBuild(),
      status: 'complete',
      phase: 'complete',
      releaseStatus: 'ready',
      appName: 'Ready Artifact',
      sealed: false,
      recoverable: false,
      resumable: false,
      proof: { ...pausedRecentBuild().proof, buildPasses: 0 }
    }

    render(<RecentBuilds builds={[ready]} onRecover={vi.fn()} />)

    expect(screen.getByRole('region', { name: /recent builds/i })).toHaveTextContent('verified')
  })
})
