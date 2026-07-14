// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { DuoElectronApi } from '../../src/shared/electron-api'
import type { RunSnapshot } from '../../src/shared/types'

function apiWithRuns(runs: RunSnapshot[]): DuoElectronApi {
  const settings = defaultSettings('C:\\DuoChaos\\workspaces')
  return {
    getBootstrap: vi.fn().mockResolvedValue({ settings, health: [], runs, platform: 'win32' }),
    refreshHealth: vi.fn().mockResolvedValue([]),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn().mockResolvedValue(settings),
    startRun: vi.fn().mockResolvedValue({ runId: 'new-run', workspacePath: 'C:\\DuoChaos\\workspaces\\new-run' }),
    stopRun: vi.fn(),
    resumeRun: vi.fn(),
    revealRun: vi.fn(),
    openArchivedRun: vi.fn().mockImplementation((runId: string) => {
      const run = runs.find((candidate) => candidate.runId === runId)
      return run ? Promise.resolve(run) : Promise.reject(new Error('Archive missing.'))
    }),
    openRunFolder: vi.fn().mockResolvedValue(undefined),
    openGeneratedApp: vi.fn().mockResolvedValue(undefined),
    getArtifactPreview: vi.fn().mockResolvedValue({
      status: 'unavailable',
      reason: 'no-built-artifact',
      message: 'No built browser artifact is available for preview.'
    }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    openAgentCli: vi.fn().mockResolvedValue(undefined),
    onRunSnapshot: vi.fn().mockReturnValue(() => undefined),
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    toggleMaximizeWindow: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined)
  }
}

function recentRuns(): RunSnapshot[] {
  return [
    {
      runId: 'duo-run-complete-safe',
      prompt: 'Build something private.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'complete',
      status: 'complete',
      round: 8,
      totalTurns: 8,
      startedAt: '2026-07-10T10:00:00.000Z',
      finishedAt: '2026-07-10T10:20:00.000Z',
      workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-complete-safe',
      appPath: 'C:\\DuoChaos\\workspaces\\duo-run-complete-safe\\app',
      tasks: [],
      events: [],
      revealPacket: {
        appName: 'Finished Local Build',
        idea: 'A revealed result.',
        summary: 'Both agents completed the run.',
        features: [],
        runCommand: 'Open app/index.html',
        appPath: 'app',
        status: 'ready',
        whatWorked: ['Verification'],
        knownIssues: [],
        agentDramaSummary: ['Both agents contributed.'],
        gitCheckpoints: [],
        agentQuotes: { claude: 'Ready.', codex: 'Verified.' }
      }
    },
    {
      runId: 'duo-run-cancelled-private',
      prompt: 'PRIVATE_CANCELLED_PROMPT_MUST_NOT_RENDER',
      executionMode: 'simulation',
      visibilityMode: 'spoiler-shield',
      phase: 'cancelled',
      status: 'cancelled',
      round: 3,
      totalTurns: 8,
      startedAt: '2026-07-10T09:00:00.000Z',
      finishedAt: '2026-07-10T09:05:00.000Z',
      workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-cancelled-private',
      appPath: 'C:\\DuoChaos\\workspaces\\duo-run-cancelled-private\\app',
      tasks: [],
      events: []
    }
  ]
}

describe('recent builds and terminal run presentation', () => {
  afterEach(() => cleanup())

  it('keeps the launch cockpit visible and presents privacy-safe recent builds after restart', async () => {
    const api = apiWithRuns(recentRuns())
    window.duo = api
    render(<App />)

    expect(await screen.findByRole('heading', { name: /start the blind build/i })).toBeVisible()
    const recent = screen.getByRole('region', { name: /recent builds/i })
    expect(within(recent).getByText('Finished Local Build')).toBeVisible()
    expect(within(recent).getByText(/complete/i)).toBeVisible()
    expect(within(recent).getByText(/cancelled/i)).toBeVisible()
    expect(within(screen.getByTestId('recent-build-duo-run-complete-safe')).getByText('No CLI calls')).toBeVisible()
    expect(within(screen.getByTestId('recent-build-duo-run-cancelled-private')).getByText('Simulation')).toBeVisible()
    const completeCard = within(screen.getByTestId('recent-build-duo-run-complete-safe'))
    fireEvent.click(completeCard.getByRole('button', { name: /open workspace/i }))
    expect(api.openRunFolder).toHaveBeenCalledWith('duo-run-complete-safe')
    fireEvent.click(completeCard.getByRole('button', { name: /open app/i }))
    expect(api.openGeneratedApp).toHaveBeenCalledWith('duo-run-complete-safe')
    fireEvent.click(completeCard.getByRole('button', { name: /view reveal/i }))
    expect(api.openArchivedRun).toHaveBeenCalledWith('duo-run-complete-safe')
    expect(await screen.findByRole('heading', { name: 'Finished Local Build' })).toBeVisible()
    expect(screen.queryByText('PRIVATE_CANCELLED_PROMPT_MUST_NOT_RENDER')).not.toBeInTheDocument()
  })

  it('replaces rotating evidence with an unmistakable fully-ready terminal message', async () => {
    const now = '2026-07-10T11:00:00.000Z'
    const run: RunSnapshot = {
      runId: 'duo-run-terminal-ready',
      prompt: 'Build something private.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'reveal.ready',
      status: 'reveal-ready',
      round: 8,
      totalTurns: 8,
      startedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-terminal-ready',
      appPath: 'C:\\DuoChaos\\workspaces\\duo-run-terminal-ready\\app',
      tasks: [],
      events: [{
        id: 'ready-event',
        type: 'reveal.ready',
        runId: 'duo-run-terminal-ready',
        round: 8,
        timestamp: now,
        agent: 'director',
        publicText: 'Reveal ready.',
        spoilerRisk: 0.05,
        severity: 'high'
      }],
      broadcast: {
        activeBeat: {
          id: 'stale-evidence',
          kind: 'evidence',
          provenance: 'evidence',
          speaker: 'codex',
          headline: 'Codex is producing live evidence',
          detail: 'A stale command result remained in the rotation.',
          sourceEventIds: ['old-command']
        },
        beats: [],
        queue: [],
        missions: [],
        evidence: { inspections: 1, edits: 1, verifications: 1, failures: 0 }
      }
    }
    window.duo = apiWithRuns([run])
    render(<App />)

    const beat = await screen.findByTestId('broadcast-beat')
    expect(beat).toHaveAttribute('data-beat-kind', 'resolution')
    expect(within(beat).getByText(/fully complete and ready/i)).toBeVisible()
    expect(within(beat).queryByText(/producing live evidence/i)).not.toBeInTheDocument()
  })
})
