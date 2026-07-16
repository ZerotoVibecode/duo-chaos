// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { DuoElectronApi } from '../../src/shared/electron-api'
import type { AppSettings, RunSnapshot } from '../../src/shared/types'
import { useStudioStore } from '../../src/renderer/src/store/studio-store'

function createApi(
  runs: RunSnapshot[] = [],
  recentBuilds: unknown[] = [],
  settingsOverrides: Partial<AppSettings> = {}
): DuoElectronApi {
  const settings = { ...defaultSettings('C:\\DuoChaos\\workspaces'), ...settingsOverrides }
  return {
    getBootstrap: vi.fn().mockResolvedValue({
      settings,
      health: [
        { id: 'codex', label: 'Codex CLI', command: 'codex', available: false, detail: 'Not installed', checkedAt: '2026-07-09T12:00:00.000Z', runtime: { model: 'gpt-5.6-sol', effort: 'max', source: 'studio' } },
        { id: 'claude', label: 'Claude Code', command: 'claude', available: false, detail: 'Not installed', checkedAt: '2026-07-09T12:00:00.000Z', runtime: { model: 'fable', effort: 'high', source: 'studio' } },
        { id: 'git', label: 'Git', command: 'git', available: true, version: 'git version 2.54', checkedAt: '2026-07-09T12:00:00.000Z' },
        { id: 'node', label: 'Node.js', command: 'node', available: true, version: 'v22.22.3', checkedAt: '2026-07-09T12:00:00.000Z' },
        { id: 'npm', label: 'npm', command: 'npm', available: true, version: '11.6.0', checkedAt: '2026-07-09T12:00:00.000Z' }
      ],
      runs,
      recentBuilds,
      platform: 'win32'
    }),
    refreshHealth: vi.fn().mockResolvedValue([]),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn().mockResolvedValue(settings),
    startRun: vi.fn().mockResolvedValue({ runId: 'run-1', workspacePath: 'C:\\DuoChaos\\workspaces\\run-1' }),
    stopRun: vi.fn(),
    resumeRun: vi.fn(),
    revealRun: vi.fn(),
    openArchivedRun: vi.fn(),
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

const longBroadcastOpinion = 'Codex says Claude has protected atmosphere without proving the interaction: the next move must answer the unanswered challenge with runnable evidence, preserve keyboard access, and keep the sealed idea private instead of replacing the decision with another abstract promise.'

function createBroadcastRun(): RunSnapshot {
  const startedAt = '2026-07-10T10:00:00.000Z'
  return {
    runId: 'run-broadcast-contract',
    prompt: 'Build something hidden and surprising.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: 'round.critique',
    status: 'running',
    round: 3,
    totalTurns: 12,
    startedAt,
    workspacePath: 'C:\\DuoChaos\\workspaces\\run-broadcast-contract',
    appPath: 'C:\\DuoChaos\\workspaces\\run-broadcast-contract\\app',
    activeAgent: 'codex',
    tasks: [],
    events: [
      {
        id: 'broadcast-phase',
        type: 'phase.changed',
        runId: 'run-broadcast-contract',
        round: 3,
        timestamp: '2026-07-10T10:01:00.000Z',
        agent: 'director',
        publicText: 'The critique round opened with one counter-position still due.',
        spoilerRisk: 0.05,
        severity: 'low'
      },
      {
        id: 'broadcast-claude-position',
        type: 'opinion',
        runId: 'run-broadcast-contract',
        round: 2,
        timestamp: '2026-07-10T10:01:20.000Z',
        agent: 'claude',
        targetAgent: 'codex',
        publicText: 'Claude says the runnable core still needs one signature moment before it deserves the reveal.',
        topic: 'experience',
        tone: 'confident',
        heat: 0.62,
        confidence: 0.79,
        spoilerRisk: 0.05,
        severity: 'medium'
      },
      {
        id: 'broadcast-codex-evidence',
        type: 'agent.activity',
        runId: 'run-broadcast-contract',
        round: 3,
        timestamp: '2026-07-10T10:02:00.000Z',
        agent: 'codex',
        publicText: 'Codex completed two verification commands and found one unresolved input risk.',
        category: 'command',
        spoilerRisk: 0.05,
        severity: 'medium'
      },
      {
        id: 'broadcast-long-opinion',
        type: 'opinion',
        runId: 'run-broadcast-contract',
        round: 3,
        timestamp: '2026-07-10T10:02:20.000Z',
        agent: 'codex',
        targetAgent: 'claude',
        publicText: longBroadcastOpinion,
        topic: 'verification',
        tone: 'skeptical',
        heat: 0.76,
        confidence: 0.88,
        spoilerRisk: 0.05,
        severity: 'high'
      }
    ]
  }
}

describe('Duo Chaos launch cockpit', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    window.duo = createApi()
  })

  it('keeps Simulation Mode available when both AI CLIs are missing', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: /start the blind build/i })).toBeVisible()
    expect(screen.getByRole('button', { name: /^simulation$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/simulation stays ready/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /start simulation/i })).toBeEnabled()
    expect(screen.getByText('Requested: Sol · Max')).toBeVisible()
    expect(screen.getByText('Requested: Fable · High')).toBeVisible()
  })

  it('keeps Real Mode unavailable until Git joins both local agents', async () => {
    const user = userEvent.setup()
    const api = createApi()
    const bootstrap = await api.getBootstrap()
    vi.mocked(api.getBootstrap).mockResolvedValue({
      ...bootstrap,
      health: bootstrap.health.map((tool) => tool.id === 'git'
        ? { ...tool, available: false, version: undefined, detail: 'Git not found' }
        : tool)
    })
    window.duo = api
    render(<App />)

    await screen.findByRole('heading', { name: /start the blind build/i })
    await user.click(screen.getByRole('button', { name: /^chaos$/i }))

    expect(screen.getByRole('button', { name: /start blind build/i })).toBeDisabled()
    expect(screen.getByText(/codex, claude code, and git/i)).toBeVisible()
    expect(screen.getByText(/simulation stays ready/i)).toBeVisible()
  })

  it('clears the untouched surprise seed when Serious build becomes a binding mission', async () => {
    const user = userEvent.setup()
    render(<App />)

    const prompt = await screen.findByLabelText(/opening prompt/i)
    expect((prompt as HTMLTextAreaElement).value).toMatch(/surprising local app/i)
    await user.click(screen.getByRole('button', { name: /serious build/i }))

    expect(prompt).toHaveValue('')
    expect(screen.getByRole('button', { name: /start simulation/i })).toBeDisabled()
    expect(prompt).toHaveAttribute('placeholder', expect.stringMatching(/requirements.*constraints/i))
  })

  it('briefs the next agent battle with the applied loadout and real time budgets', async () => {
    render(<App />)

    const briefing = await screen.findByRole('region', { name: /battle briefing/i })
    expect(within(briefing).getByText('Claude')).toBeVisible()
    expect(within(briefing).getByText('Fable · High')).toBeVisible()
    expect(within(briefing).getByText('VS')).toBeVisible()
    expect(within(briefing).getByText('Codex')).toBeVisible()
    expect(within(briefing).getByText('Sol · Max')).toBeVisible()
    expect(within(briefing).getAllByText('Requested')).toHaveLength(2)
    expect(briefing).toHaveTextContent(/4-call debate.*2 deep builds.*1 reciprocal review.*2 receipts/i)
    expect(briefing).toHaveTextContent(/2 deep builds 2h/i)
    expect(briefing).toHaveTextContent(/run ceiling 24h/i)
    expect(screen.getByText(/one prompt\. two rivals\. one surviving build\./i)).toBeVisible()
  })

  it('frames the launch as a resilient two-agent battle without promising fake progress', async () => {
    render(<App />)

    const resilience = await screen.findByRole('region', { name: /battle resilience/i })
    expect(within(resilience).getByText(/reciprocal authority/i)).toBeVisible()
    expect(within(resilience).getByText(/crash-safe resume/i)).toBeVisible()
    expect(within(resilience).getByText(/soft work guards/i)).toBeVisible()
    expect(within(resilience).getByText(/max ceiling/i)).toBeVisible()
    expect(resilience).toHaveTextContent(/efficient source work.*premium review bounded/i)
    expect(resilience).not.toHaveTextContent(/guaranteed|unstoppable|always completes/i)

    const launchAction = screen.getByRole('button', { name: /start simulation/i })
    expect(launchAction.closest('.launch-primary-action')).toHaveTextContent(/fresh sealed workspace/i)
  })

  it('keeps the camera-facing workspace destination private', async () => {
    const privateWorkspace = 'C:\\Users\\private-owner\\Documents\\ZeroToVibecode\\DuoChaos\\workspaces'
    window.duo = createApi([], [], { defaultWorkspaceRoot: privateWorkspace })

    render(<App />)

    const destination = await screen.findByTestId('workspace-destination')
    expect(destination).toHaveTextContent(/dedicated local folder selected/i)
    expect(destination).toHaveAccessibleName(/workspace.*selected.*path hidden/i)
    expect(destination).toHaveAttribute('title', expect.stringMatching(/hidden.*camera privacy/i))
    expect(document.body).not.toHaveTextContent(privateWorkspace)
    expect(document.body).not.toHaveTextContent(/private-owner|Users\\private-owner/i)
    expect(document.body.innerHTML).not.toContain(privateWorkspace)
  })

  it('sends the prompt and separate execution/visibility choices to Electron', async () => {
    const user = userEvent.setup()
    render(<App />)
    const prompt = await screen.findByLabelText(/opening prompt/i)
    await user.clear(prompt)
    await user.type(prompt, 'Build something strange, local, and beautiful.')
    await user.click(screen.getByRole('button', { name: /start simulation/i }))

    await waitFor(() =>
      expect(window.duo.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Build something strange, local, and beautiful.',
          executionMode: 'simulation',
          visibilityMode: 'spoiler-shield',
          turnTimeoutSeconds: 7_200,
          runTimeoutSeconds: 86_400
        })
      )
    )
  })

  it('explains that unattended Safe Mode requires Core toolbelts', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /^safe\b/i }))

    expect(screen.getByText(/Safe Mode supports Core tools only/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /start blind build/i })).toBeDisabled()
  })

  it('selects a serious mission independently and sends a binding profile to Electron', async () => {
    const user = userEvent.setup()
    render(<App />)

    const serious = await screen.findByRole('button', { name: /^serious build$/i })
    const surprise = screen.getByRole('button', { name: /^surprise build$/i })
    expect(surprise).toHaveAttribute('aria-pressed', 'true')
    expect(serious).toHaveAttribute('aria-pressed', 'false')

    await user.click(serious)
    expect(serious).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText(/requirements stay binding/i)).not.toHaveLength(0)
    await user.click(screen.getByRole('button', { name: /start simulation/i }))

    await waitFor(() => expect(window.duo.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ missionProfile: 'serious', executionMode: 'simulation', visibilityMode: 'spoiler-shield' })
    ))
  })

  it('returns a cancelled run to the prompt with the previous request preserved', async () => {
    const user = userEvent.setup()
    const running: RunSnapshot = {
      runId: 'run-cancel-me',
      prompt: 'Build a tiny emoji hello website.',
      executionMode: 'simulation',
      visibilityMode: 'spoiler-shield',
      phase: 'round.pitch',
      status: 'running',
      round: 1,
      startedAt: '2026-07-09T12:00:00.000Z',
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-cancel-me',
      appPath: 'C:\\DuoChaos\\workspaces\\run-cancel-me\\app',
      tasks: [],
      events: []
    }
    const api = createApi([running])
    vi.mocked(api.stopRun).mockResolvedValue({
      ...running,
      phase: 'cancelled',
      status: 'cancelled',
      finishedAt: '2026-07-09T12:00:01.000Z'
    })
    window.duo = api

    render(<App />)
    await user.click(await screen.findByRole('button', { name: /^stop$/i }))

    const confirmation = screen.getByRole('alertdialog', { name: /cancel this battle permanently/i })
    expect(confirmation).toHaveTextContent(/cannot be resumed/i)
    expect(api.stopRun).not.toHaveBeenCalled()
    await user.click(within(confirmation).getByRole('button', { name: /cancel battle permanently/i }))

    const back = await screen.findByRole('button', { name: /back to prompt/i })
    expect(back).toBeEnabled()
    await user.click(back)

    expect(await screen.findByRole('heading', { name: /start the blind build/i })).toBeVisible()
    expect(screen.getByLabelText(/opening prompt/i)).toHaveValue('Build a tiny emoji hello website.')
  })

  it('traps keyboard focus in the stop confirmation and restores the Stop trigger on Escape', async () => {
    const user = userEvent.setup()
    const running: RunSnapshot = {
      runId: 'run-stop-focus',
      prompt: 'Build a tiny keyboard-safe website.',
      executionMode: 'simulation',
      visibilityMode: 'spoiler-shield',
      phase: 'round.pitch',
      status: 'running',
      round: 1,
      startedAt: '2026-07-09T12:00:00.000Z',
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-stop-focus',
      appPath: 'C:\\DuoChaos\\workspaces\\run-stop-focus\\app',
      tasks: [],
      events: []
    }
    window.duo = createApi([running])
    render(<App />)

    const stop = await screen.findByRole('button', { name: /^stop$/i })
    await user.click(stop)
    const confirmation = screen.getByRole('alertdialog', { name: /cancel this battle permanently/i })
    const keep = within(confirmation).getByRole('button', { name: /keep battle running/i })
    const cancel = within(confirmation).getByRole('button', { name: /cancel battle permanently/i })
    expect(keep).toHaveFocus()
    expect(document.querySelector('.app-frame')?.parentElement).toHaveAttribute('inert')

    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(keep).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('alertdialog', { name: /cancel this battle permanently/i })).not.toBeInTheDocument()
    expect(stop).toHaveFocus()
    expect(document.querySelector('.app-frame')?.parentElement).not.toHaveAttribute('inert')
  })

  it('keeps preflight distinct from a confirmed live run', async () => {
    const preflight: RunSnapshot = {
      runId: 'run-preflight',
      prompt: 'Build something sealed.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'preflight',
      status: 'running',
      round: 0,
      totalTurns: 12,
      startedAt: '2026-07-09T12:00:00.000Z',
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-preflight',
      appPath: 'C:\\DuoChaos\\workspaces\\run-preflight\\app',
      tasks: [],
      events: []
    }
    window.duo = createApi([preflight])

    render(<App />)

    expect(await screen.findByText(/^Preflight$/i, { selector: '.status-chip' })).toBeVisible()
    expect(screen.queryByText(/^Live run$/i, { selector: '.status-chip' })).not.toBeInTheDocument()
  })

  it('contains keyboard focus in Studio settings and restores the settings trigger on close', async () => {
    const user = userEvent.setup()
    render(<App />)

    const settingsTrigger = await screen.findByRole('button', { name: /open settings/i })
    settingsTrigger.focus()
    await user.click(settingsTrigger)

    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    const closeButton = within(settingsDialog).getByRole('button', { name: /close settings/i })
    const saveButton = within(settingsDialog).getByRole('button', { name: /save settings/i })
    expect(closeButton).toHaveFocus()

    await user.tab({ shift: true })
    expect(saveButton).toHaveFocus()
    await user.tab()
    expect(closeButton).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /studio settings/i })).not.toBeInTheDocument()
    expect(settingsTrigger).toHaveFocus()
  })

  it('lets the user pin both models and open an interactive local CLI', async () => {
    const user = userEvent.setup()
    const api = createApi()
    window.duo = api
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /open settings/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    const codexModel = within(settingsDialog).getByLabelText(/^codex model$/i)
    expect(within(codexModel).getByRole('option', { name: 'Sol' })).toBeVisible()
    expect(within(codexModel).getByRole('option', { name: 'Terra' })).toBeVisible()
    await user.selectOptions(codexModel, 'gpt-5.6-sol')
    await user.selectOptions(within(settingsDialog).getByLabelText(/codex effort/i), 'ultra')
    const claudeModel = within(settingsDialog).getByLabelText(/^claude model$/i)
    expect(within(claudeModel).getByRole('option', { name: 'Fable' })).toBeVisible()
    expect(within(claudeModel).getByRole('option', { name: 'Opus' })).toBeVisible()
    expect(within(claudeModel).getByRole('option', { name: 'Sonnet' })).toBeVisible()
    await user.selectOptions(claudeModel, 'fable')
    await user.selectOptions(within(settingsDialog).getByLabelText(/claude effort/i), 'max')
    expect(within(settingsDialog).getByLabelText(/codex toolbelt/i)).toHaveValue('smart')
    expect(within(settingsDialog).getByLabelText(/claude toolbelt/i)).toHaveValue('smart')
    expect(within(settingsDialog).getByLabelText(/quality routing/i)).toHaveValue('balanced')
    const inferenceLease = within(settingsDialog).getByLabelText(/agent work inference lease/i)
    await user.clear(inferenceLease)
    await user.type(inferenceLease, '6')
    await user.click(within(settingsDialog).getByLabelText(/trust my local cli capabilities/i))
    const workLease = within(settingsDialog).getByLabelText(/long work lease.*minutes/i)
    const runCeiling = within(settingsDialog).getByLabelText(/overall run ceiling.*hours/i)
    expect(workLease).toHaveValue(120)
    expect(runCeiling).toHaveValue(24)
    await user.clear(workLease)
    await user.type(workLease, '180')
    await user.clear(runCeiling)
    await user.type(runCeiling, '18')
    await user.click(within(settingsDialog).getByRole('button', { name: /open codex cli/i }))
    await user.click(within(settingsDialog).getByRole('button', { name: /save settings/i }))

    expect(api.openAgentCli).toHaveBeenCalledWith('codex')
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'ultra',
      claudeModel: 'fable',
      claudeEffort: 'max',
      codexCustomizationProfile: 'smart',
      claudeCustomizationProfile: 'smart',
      trustedLocalCapabilitiesConfirmed: true,
      qualityRoutingProfile: 'balanced',
      workInferenceLimit: 6,
      turnTimeoutSeconds: 10_800,
      runTimeoutSeconds: 64_800
    }))
  })

  it('warns when selected work leases cannot fit inside the overall run ceiling', async () => {
    const user = userEvent.setup()
    window.duo = createApi()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /open settings/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    const maxTurns = within(settingsDialog).getByLabelText(/^max agent calls$/i)
    const workLease = within(settingsDialog).getByLabelText(/long work lease.*minutes/i)
    await user.clear(maxTurns)
    await user.type(maxTurns, '12')
    await user.clear(workLease)
    await user.type(workLease, '480')

    expect(within(settingsDialog).getByRole('status')).toHaveTextContent(/work leases.*run ceiling|timebox/i)
  })

  it('explains how many configured repair pairs fit inside the turn ceiling', async () => {
    const user = userEvent.setup()
    window.duo = createApi()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /open settings/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    const maxTurns = within(settingsDialog).getByLabelText(/^max agent calls$/i)
    const repairLoops = within(settingsDialog).getByLabelText(/^repair loops$/i)
    await user.clear(maxTurns)
    await user.type(maxTurns, '10')
    await user.clear(repairLoops)
    await user.type(repairLoops, '2')

    expect(within(settingsDialog).getByText(/1 of 2 configured repair pairs fit inside 10 agent calls/i)).toBeVisible()
    expect(within(settingsDialog).getByText(/use 11 max agent calls to schedule both repair pairs/i)).toBeVisible()
  })

  it('projects the seven-call path without verdict or recovery ceremony', async () => {
    const user = userEvent.setup()
    window.duo = createApi()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /open settings/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    const maxTurns = within(settingsDialog).getByLabelText(/^max agent calls$/i)
    const workLease = within(settingsDialog).getByLabelText(/long work lease.*minutes/i)
    await user.clear(maxTurns)
    await user.type(maxTurns, '7')
    await user.clear(workLease)
    await user.type(workLease, '480')

    const warning = within(settingsDialog).getByRole('status')
    expect(warning).toHaveTextContent(/24h of source work/i)
    expect(warning).toHaveTextContent(/40m for debate/i)
    expect(warning).not.toHaveTextContent(/openings|verdicts|recovery/i)
    expect(warning).toHaveTextContent(/exceeds the 24h run ceiling/i)
  })

  it('keeps a discoverable custom model path in Studio settings', async () => {
    const user = userEvent.setup()
    const api = createApi()
    window.duo = api
    render(<App />)

    await user.click(await screen.findByRole('button', { name: /open settings/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /studio settings/i })
    await user.selectOptions(within(settingsDialog).getByLabelText(/^codex model$/i), '__custom__')
    await user.type(within(settingsDialog).getByLabelText(/codex custom model id/i), 'future-codex-model')
    await user.click(within(settingsDialog).getByRole('button', { name: /save settings/i }))

    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ codexModel: 'future-codex-model' }))
  })

  it('changes the next-run loadout directly from the launch panel', async () => {
    const user = userEvent.setup()
    const api = createApi()
    window.duo = api
    render(<App />)

    const loadoutHeading = await screen.findByRole('heading', { name: /agent loadout/i })
    expect(loadoutHeading).toBeVisible()
    expect(screen.queryByRole('heading', { name: /preflight/i })).not.toBeInTheDocument()
    const loadout = loadoutHeading.closest('aside')
    expect(loadout).not.toBeNull()
    const loadoutUi = within(loadout as HTMLElement)

    const systemChecks = loadoutUi.getByRole('group', { name: /system checks/i })
    expect(within(systemChecks).getByText('Git')).toBeVisible()
    expect(within(systemChecks).getByText('Node 22')).toBeVisible()
    expect(within(systemChecks).getByText('npm 11')).toBeVisible()

    const codexModel = loadoutUi.getByLabelText(/codex model/i)
    expect(within(codexModel).getByRole('option', { name: 'CLI default' })).toBeVisible()
    expect(within(codexModel).getByRole('option', { name: 'Sol' })).toBeVisible()
    expect(within(codexModel).getByRole('option', { name: 'Terra' })).toBeVisible()
    await user.selectOptions(codexModel, 'gpt-5.6-sol')
    await user.selectOptions(loadoutUi.getByLabelText(/codex effort/i), 'ultra')
    const claudeModel = loadoutUi.getByLabelText(/claude model/i)
    expect(within(claudeModel).getByRole('option', { name: 'Fable' })).toBeVisible()
    expect(within(claudeModel).getByRole('option', { name: 'Opus' })).toBeVisible()
    expect(within(claudeModel).getByRole('option', { name: 'Sonnet' })).toBeVisible()
    await user.selectOptions(claudeModel, 'fable')
    await user.selectOptions(loadoutUi.getByLabelText(/claude effort/i), 'max')
    await user.click(loadoutUi.getByRole('button', { name: /apply loadout/i }))

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'ultra',
      claudeModel: 'fable',
      claudeEffort: 'max'
    })))

  })

  it('keeps the selected serious mission when applying a launch-only agent loadout', async () => {
    const user = userEvent.setup()
    const api = createApi()
    vi.mocked(api.saveSettings).mockImplementation((settings) => Promise.resolve(settings))
    window.duo = api
    render(<App />)

    await waitFor(() => expect(api.getBootstrap).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: /refresh cli health/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /serious build/i }))
    await user.type(screen.getByLabelText(/opening prompt/i), 'Build a dependable local workspace for a serious daily workflow.')
    const loadout = screen.getByRole('heading', { name: /agent loadout/i }).closest('aside')
    expect(loadout).not.toBeNull()
    const loadoutUi = within(loadout as HTMLElement)
    await user.selectOptions(loadoutUi.getByLabelText(/^codex model$/i), 'gpt-5.6-terra')
    await user.selectOptions(loadoutUi.getByLabelText(/codex effort/i), 'low')
    await user.click(loadoutUi.getByRole('button', { name: /apply loadout/i }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    await waitFor(() => expect({
      busy: useStudioStore.getState().busy,
      error: useStudioStore.getState().error
    }).toEqual({ busy: false, error: undefined }))

    expect(screen.getByRole('button', { name: /serious build/i })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /start simulation/i }))
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ missionProfile: 'serious' })))
  })

  it('uses the local CLI catalog and resets an effort unsupported by the selected model', async () => {
    const user = userEvent.setup()
    const api = createApi()
    const bootstrap = await api.getBootstrap()
    vi.mocked(api.getBootstrap).mockResolvedValue({
      ...bootstrap,
      health: bootstrap.health.map((item) => item.id === 'codex'
        ? {
            ...item,
            catalog: {
              agent: 'codex' as const,
              source: 'cli-live' as const,
              discoveredAt: '2026-07-10T17:00:00.000Z',
              models: [
                { id: 'gpt-5.6-sol', label: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
                { id: 'gpt-5.6-luna', label: 'Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
              ]
            }
          }
        : item)
    })
    window.duo = api
    render(<App />)

    const loadout = (await screen.findByRole('heading', { name: /agent loadout/i })).closest('aside')
    expect(loadout).not.toBeNull()
    const ui = within(loadout as HTMLElement)
    const model = ui.getByLabelText(/^codex model$/i)
    const effort = ui.getByLabelText(/codex effort/i)
    expect(within(model).getByRole('option', { name: 'Luna' })).toBeVisible()
    await user.selectOptions(model, 'gpt-5.6-sol')
    await user.selectOptions(effort, 'ultra')
    await user.selectOptions(model, 'gpt-5.6-luna')
    expect(effort).toHaveValue('default')
    expect(within(effort).queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open settings/i }))
    const settings = screen.getByRole('dialog', { name: /studio settings/i })
    const settingsModel = within(settings).getByLabelText(/^codex model$/i)
    const settingsEffort = within(settings).getByLabelText(/codex effort/i)
    expect(within(settingsModel).getByRole('option', { name: 'Luna' })).toBeVisible()
    await user.selectOptions(settingsModel, 'gpt-5.6-sol')
    await user.selectOptions(settingsEffort, 'ultra')
    await user.selectOptions(settingsModel, 'gpt-5.6-luna')
    expect(settingsEffort).toHaveValue('default')
    expect(within(settingsEffort).queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()
  })

  it('keeps the launch loadout synchronized after settings saves a different model', async () => {
    const user = userEvent.setup()
    const api = createApi()
    vi.mocked(api.saveSettings).mockImplementation((settings) => Promise.resolve(settings))
    window.duo = api
    render(<App />)

    await screen.findByRole('heading', { name: /agent loadout/i })
    await user.click(screen.getByRole('button', { name: /open settings/i }))
    const settings = screen.getByRole('dialog', { name: /studio settings/i })
    await user.selectOptions(within(settings).getByLabelText(/^codex model$/i), 'gpt-5.6-terra')
    await user.selectOptions(within(settings).getByLabelText(/codex effort/i), 'low')
    await user.click(within(settings).getByRole('button', { name: /save settings/i }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /studio settings/i })).not.toBeInTheDocument())
    const loadout = screen.getByRole('heading', { name: /agent loadout/i }).closest('aside')
    expect(loadout).not.toBeNull()
    expect(within(loadout as HTMLElement).getByLabelText(/^codex model$/i)).toHaveValue('gpt-5.6-terra')
    expect(within(loadout as HTMLElement).getByLabelText(/codex effort/i)).toHaveValue('low')
    expect(within(loadout as HTMLElement).getByRole('button', { name: /loadout applied/i })).toBeDisabled()
  })

  it('replaces stale Recent Builds when Studio settings changes the workspace root', async () => {
    const user = userEvent.setup()
    const oldBuild = {
      runId: 'duo-run-old-root',
      startedAt: '2026-07-10T10:00:00.000Z',
      status: 'complete',
      phase: 'complete',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      missionProfile: 'surprise',
      prompt: 'Old root prompt.',
      workspacePath: 'C:\\OldRoot\\duo-run-old-root',
      workspaceRoot: 'C:\\OldRoot',
      appName: 'Old Root App',
      sealed: false,
      recoverable: false,
      proof: {
        tasksDone: 1,
        tasksTotal: 1,
        checkpoints: 1,
        buildPasses: 1,
        claude: { turns: 1, edits: 1, messages: 1, tasksDone: 1 },
        codex: { turns: 1, edits: 1, messages: 1, tasksDone: 0 }
      }
    }
    const api = createApi([], [oldBuild], { defaultWorkspaceRoot: 'C:\\OldRoot' })
    const initialBootstrap = await api.getBootstrap()
    vi.mocked(api.getBootstrap).mockReset()
    vi.mocked(api.getBootstrap)
      .mockResolvedValueOnce(initialBootstrap)
      .mockResolvedValue({
        ...initialBootstrap,
        settings: { ...initialBootstrap.settings, defaultWorkspaceRoot: 'C:\\NewRoot' },
        recentBuilds: []
      })
    vi.mocked(api.saveSettings).mockImplementation((settings) => Promise.resolve(settings))
    window.duo = api
    render(<App />)

    expect(await screen.findByText('Old Root App')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /open settings/i }))
    const settings = screen.getByRole('dialog', { name: /studio settings/i })
    const root = within(settings).getByLabelText(/default workspace root/i)
    await user.clear(root)
    await user.type(root, 'C:\\NewRoot')
    await user.click(within(settings).getByRole('button', { name: /save settings/i }))

    await waitFor(() => expect(screen.queryByText('Old Root App')).not.toBeInTheDocument())
    expect(api.getBootstrap).toHaveBeenCalledTimes(2)
  })

  it('turns truthful Real Mode activity, opinions, and tasks into a live spectator dashboard', async () => {
    const now = '2026-07-09T23:30:00.000Z'
    const live: RunSnapshot = {
      runId: 'run-spectator',
      prompt: 'Build something hidden.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'round.tasking',
      status: 'running',
      round: 6,
      totalTurns: 12,
      startedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-spectator',
      appPath: 'C:\\DuoChaos\\workspaces\\run-spectator\\app',
      activeAgent: 'claude',
      tasks: [{
        id: 'verify-1',
        publicTitle: 'Verification pass',
        status: 'in-progress',
        claimedBy: 'codex',
        risk: 'medium',
        files: ['[WORKSPACE_FILE]']
      }],
      events: [
        { id: 'a1', type: 'agent.activity', runId: 'run-spectator', round: 6, timestamp: now, agent: 'claude', publicText: 'Claude is editing a workspace file.', spoilerRisk: 0.05, severity: 'low', category: 'file' },
        { id: 'a2', type: 'agent.activity', runId: 'run-spectator', round: 6, timestamp: now, agent: 'codex', publicText: 'Codex is testing the current build.', spoilerRisk: 0.05, severity: 'low', category: 'command' },
        { id: 'o1', type: 'opinion', runId: 'run-spectator', round: 3, timestamp: now, agent: 'codex', targetAgent: 'claude', topic: 'critique', tone: 'skeptical', confidence: 0.81, heat: 0.72, publicText: 'Codex says the current [FEATURE] is under-specified.', spoilerRisk: 0.05, severity: 'medium' },
        { id: 'o2', type: 'opinion', runId: 'run-spectator', round: 6, timestamp: now, agent: 'claude', targetAgent: 'codex', topic: 'product-opinion', tone: 'confident', confidence: 0.76, heat: 0.58, publicText: 'Claude wants a stronger verification pass.', spoilerRisk: 0.05, severity: 'medium' },
        { id: 'o3', type: 'opinion', runId: 'run-spectator', round: 6, timestamp: now, agent: 'codex', targetAgent: 'claude', topic: 'legacy-review', tone: 'cautious', publicText: 'Codex filed an honest unscored review.', spoilerRisk: 0.05, severity: 'medium' }
      ]
    }
    window.duo = createApi([live])

    render(<App />)

    expect(await screen.findByText('Turn 6 of 12')).toBeVisible()
    expect(screen.getAllByText('Codex is testing the current build.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Claude wants a stronger verification pass.').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Two positions are live' })).toBeVisible()
    expect(screen.getAllByText('Verification pass').length).toBeGreaterThan(0)
    expect(screen.getAllByText('0/1').some((element) => element.offsetParent !== null || element.isConnected)).toBe(true)
    expect(screen.getByText('Heat unscored')).toBeVisible()
    expect(screen.getByText('Confidence unscored')).toBeVisible()
  })

  it('turns recorded agent words and evidence into a semantic broadcast stage with explicit provenance', async () => {
    window.duo = createApi([createBroadcastRun()])

    render(<App />)

    const stage = await screen.findByTestId('broadcast-stage')
    expect(stage).toHaveAttribute('role', 'region')
    expect(stage).toHaveAccessibleName(/live broadcast stage/i)
    expect(within(stage).getByText(/^agent quote$/i)).toBeVisible()
    const exchange = within(stage).getByRole('list', { name: /exchange progress/i })
    expect(within(exchange).getByText(/^opening$/i)).toBeVisible()
    expect(within(exchange).getByText(/^counter$/i)).toBeVisible()
    expect(within(exchange).getByText(/^verdict$/i)).toBeVisible()
    expect(within(stage).getByText(longBroadcastOpinion)).toBeVisible()
  })

  it('keeps the inactive agent on deck, fills mission drafting, and preserves the complete featured opinion', async () => {
    window.duo = createApi([createBroadcastRun()])

    render(<App />)

    const claudeHeading = await screen.findByRole('heading', { name: 'Claude' })
    const claudeCard = claudeHeading.closest('article')
    expect(claudeCard).not.toBeNull()
    expect(within(claudeCard as HTMLElement).getByText(/^on deck$/i)).toBeVisible()
    expect(within(claudeCard as HTMLElement).queryByText(/^waiting$/i)).not.toBeInTheDocument()

    const missionDrafting = screen.getByTestId('mission-drafting')
    expect(missionDrafting).toHaveTextContent(/mission drafting/i)
    expect(missionDrafting).toHaveTextContent(/positions? recorded/i)
    expect(missionDrafting).toHaveTextContent(/challenge/i)

    const opinionCard = screen.getByTestId('opinion-card-broadcast-long-opinion')
    const opinionBody = within(opinionCard).getByTestId('opinion-body')
    expect(opinionBody).toHaveTextContent(longBroadcastOpinion)
    expect(opinionBody.textContent).toBe(longBroadcastOpinion)
  })

  it('never renders an empty drama recap or generic completion quotes after reveal', async () => {
    const now = '2026-07-09T23:40:00.000Z'
    const complete: RunSnapshot = {
      runId: 'run-revealed-drama',
      prompt: 'Build something hidden.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'complete',
      status: 'complete',
      round: 12,
      totalTurns: 12,
      startedAt: now,
      finishedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-revealed-drama',
      appPath: 'C:\\DuoChaos\\workspaces\\run-revealed-drama\\app',
      tasks: [{ id: 'repair-1', publicTitle: 'Repair investigation', status: 'done', claimedBy: 'claude', risk: 'high', files: [] }],
      events: [
        { id: 'o1', type: 'opinion', runId: 'run-revealed-drama', round: 9, timestamp: now, agent: 'claude', publicText: 'Claude rejected the suspected defect and found the real contrast failure.', spoilerRisk: 0.05, severity: 'medium', topic: 'review' },
        { id: 'o2', type: 'opinion', runId: 'run-revealed-drama', round: 11, timestamp: now, agent: 'codex', publicText: 'Codex found the keyboard shortcut was blocking a focused control.', spoilerRisk: 0.05, severity: 'medium', topic: 'verification-opinion' },
        { id: 'o3', type: 'opinion', runId: 'run-revealed-drama', round: 12, timestamp: now, agent: 'claude', publicText: '[APP_NAME] should keep one [FEATURE].', spoilerRisk: 0.05, severity: 'medium', topic: 'wrap-opinion' }
      ],
      revealPacket: {
        appName: 'Revealed App',
        idea: 'A revealed idea.',
        summary: 'A finished result.',
        features: ['One interaction'],
        runCommand: 'npm run dev',
        appPath: 'app',
        status: 'ready',
        whatWorked: [],
        knownIssues: [],
        agentDramaSummary: ['Claude says [APP_NAME] should keep one [FEATURE].'],
        gitCheckpoints: [],
        agentQuotes: { claude: '[APP_NAME] kept the [FEATURE] focused.', codex: 'Codex completed the final turn.' }
      }
    }
    window.duo = createApi([complete])

    render(<App />)

    expect((await screen.findAllByText(/Codex found the keyboard shortcut/i)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/completed the final turn/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/Revealed App should keep one signature interaction/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Revealed App should keep one signature interaction/i).length).toBeGreaterThan(1)
    expect(screen.queryByText(/\[(?:APP_NAME|FEATURE)\]/i)).not.toBeInTheDocument()
  })

  it('fills What shipped from verified work when the feature array is empty', async () => {
    const now = '2026-07-10T13:20:00.000Z'
    const complete: RunSnapshot = {
      runId: 'run-revealed-fallback-features',
      prompt: 'Build something hidden.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      phase: 'complete',
      status: 'complete',
      round: 8,
      totalTurns: 8,
      startedAt: now,
      finishedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-revealed-fallback-features',
      appPath: 'C:\\DuoChaos\\workspaces\\run-revealed-fallback-features\\app',
      tasks: [{ id: 'feature-1', publicTitle: 'Build the direct-open canvas', status: 'done', claimedBy: 'claude', risk: 'low', files: ['app/index.html'] }],
      events: [],
      revealPacket: {
        appName: 'Seed Garden',
        idea: 'A tiny browser garden.',
        summary: 'A finished result.',
        features: [],
        runCommand: 'Open app/index.html',
        appPath: 'app/index.html',
        status: 'ready',
        whatWorked: ['Direct-open canvas with no dependencies'],
        knownIssues: [],
        agentDramaSummary: ['Both agents completed their slices.'],
        gitCheckpoints: [],
        agentQuotes: { claude: 'The canvas is ready.', codex: 'The build is clean.' }
      }
    }
    window.duo = createApi([complete])

    render(<App />)

    expect(await screen.findByText('Direct-open canvas with no dependencies')).toBeVisible()
  })

  it('shows an explicit truthful state when no shipped items were recorded', async () => {
    const now = '2026-07-10T13:25:00.000Z'
    const partial: RunSnapshot = {
      runId: 'run-revealed-without-shipped-items',
      prompt: 'Preserve incomplete work honestly.',
      executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      phase: 'complete', status: 'complete', round: 8, totalTurns: 8,
      startedAt: now, finishedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-revealed-without-shipped-items',
      appPath: 'C:\\DuoChaos\\workspaces\\run-revealed-without-shipped-items\\app',
      tasks: [], events: [],
      revealPacket: {
        appName: 'Preserved Draft', idea: 'An incomplete local experiment.',
        summary: 'The workspace was preserved without inventing completed work.',
        features: [], runCommand: 'Open the generated workspace for inspection.', appPath: 'app', status: 'partial',
        whatWorked: [], knownIssues: ['No runnable release was verified.'],
        agentDramaSummary: ['The agents stopped before a shippable slice was recorded.'], gitCheckpoints: [],
        agentQuotes: { claude: 'The work is incomplete.', codex: 'The workspace remains inspectable.' }
      }
    }
    window.duo = createApi([partial])

    render(<App />)

    expect(await screen.findByText('No verified product slice was recorded for this run.')).toBeVisible()
    expect(screen.getByRole('heading', { name: /usable work they preserved/i })).toBeVisible()
  })

  it('keeps verbose legacy reveal packets readable without rewriting stored evidence', async () => {
    const now = '2026-07-10T13:27:00.000Z'
    const verboseTail = `UNBOUNDED ${'implementation detail '.repeat(40)}`
    const complete: RunSnapshot = {
      runId: 'run-revealed-verbose-legacy', prompt: 'Build a polished local experience.',
      executionMode: 'chaos', visibilityMode: 'spoiler-shield', phase: 'complete', status: 'complete',
      round: 8, totalTurns: 8, startedAt: now, finishedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-revealed-verbose-legacy',
      appPath: 'C:\\DuoChaos\\workspaces\\run-revealed-verbose-legacy\\app',
      tasks: [{
        id: 'story-engine', publicTitle: 'Deterministic story engine',
        publicDescription: `Implementation notes ${verboseTail}`, status: 'done', claimedBy: 'claude', risk: 'medium', files: ['app/index.html']
      }],
      events: [],
      revealPacket: {
        appName: 'Orbit Garden — complete technical implementation and release notes',
        idea: `A calm spatial garden for collecting small thoughts. ${verboseTail}`,
        summary: `The agents shipped a direct-open interactive artifact. ${verboseTail}`,
        features: [`Keyboard-accessible constellation controls. ${verboseTail}`],
        runCommand: 'Open app/index.html', appPath: 'app/index.html', status: 'ready',
        whatWorked: [], knownIssues: ['No valid reveal packet was produced before the turn limit.'], agentDramaSummary: [], gitCheckpoints: [],
        agentQuotes: { claude: '', codex: '' }
      }
    }
    window.duo = createApi([complete])

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Orbit Garden' })).toBeVisible()
    expect(document.querySelector('.reveal-idea')?.textContent?.length ?? 0).toBeLessThanOrEqual(321)
    expect(document.querySelector('.reveal-summary')?.textContent?.length ?? 0).toBeLessThanOrEqual(421)
    expect(document.querySelector('.survivor-list li')?.textContent?.length ?? 0).toBeLessThanOrEqual(181)
    expect(screen.getByText('Deterministic story engine')).toBeVisible()
    expect(screen.getByText('Final release metadata was incomplete; the preserved artifact remains available.')).toBeVisible()
    expect(screen.queryByText(/no valid reveal packet was produced/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/complete technical implementation and release notes/i)).not.toBeInTheDocument()
  })

  it('presents a partial package result as preserved work instead of a shipped app', async () => {
    const user = userEvent.setup()
    const now = '2026-07-10T13:30:00.000Z'
    const complete: RunSnapshot = {
      runId: 'run-package-without-build', prompt: 'Build a package app.', executionMode: 'chaos', visibilityMode: 'spoiler-shield',
      phase: 'complete', status: 'complete', round: 8, totalTurns: 8, startedAt: now, finishedAt: now,
      workspacePath: 'C:\\DuoChaos\\workspaces\\run-package-without-build', appPath: 'C:\\DuoChaos\\workspaces\\run-package-without-build\\app',
      tasks: [], events: [],
      revealPacket: {
        appName: 'Runner App', idea: 'A package-powered app.', summary: 'Source is ready.', features: ['Package source'],
        runCommand: 'npm install && npm run dev', appPath: 'app', status: 'partial', whatWorked: ['Source generated'], knownIssues: [
          'Build output missing',
          'Both agents need accepted source contribution and cross-review evidence before the build can be marked ready.'
        ],
        agentDramaSummary: ['The source exists, but no browser artifact was built.'], gitCheckpoints: [], agentQuotes: { claude: 'Build it first.', codex: 'The source needs its runner.' }
      }
    }
    window.duo = createApi([complete])
    render(<App />)

    expect(await screen.findByText(/partial build was preserved/i)).toBeVisible()
    expect(screen.getByRole('heading', { name: /usable work they preserved/i })).toBeVisible()
    expect(screen.getByRole('note', { name: /release caveats/i })).toHaveTextContent(/both agents need accepted source contribution and cross-review evidence/i)
    expect(screen.queryByText(/product they actually shipped/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /launch runner app/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /inspect preserved workspace/i }))

    expect(window.duo.openRunFolder).toHaveBeenCalledWith('run-package-without-build')
    expect(window.duo.openGeneratedApp).not.toHaveBeenCalled()
  })

  it('shows privacy-safe recent builds and recovers an interrupted prompt', async () => {
    const user = userEvent.setup()
    window.duo = createApi([], [
      {
        runId: 'duo-run-interrupted',
        startedAt: '2026-07-10T11:00:00.000Z',
        status: 'interrupted',
        phase: 'round.code',
        executionMode: 'chaos',
        visibilityMode: 'spoiler-shield',
        prompt: 'Recover this original request.',
        workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-interrupted',
        workspaceRoot: 'C:\\DuoChaos\\workspaces',
        sealed: true,
        recoverable: true,
        proof: { tasksDone: 1, tasksTotal: 2, checkpoints: 1, buildPasses: 0, claude: { turns: 2, edits: 1, messages: 2, tasksDone: 1 }, codex: { turns: 2, edits: 2, messages: 2, tasksDone: 0 } }
      },
      {
        runId: 'duo-run-complete',
        startedAt: '2026-07-10T10:00:00.000Z',
        finishedAt: '2026-07-10T10:20:00.000Z',
        status: 'complete',
        phase: 'complete',
        executionMode: 'chaos',
        visibilityMode: 'spoiler-shield',
        prompt: 'Finished request.',
        workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-complete',
        workspaceRoot: 'C:\\DuoChaos\\workspaces',
        appName: 'Public Launch',
        sealed: false,
        recoverable: false,
        proof: { tasksDone: 2, tasksTotal: 2, checkpoints: 2, buildPasses: 1, claude: { turns: 6, edits: 4, messages: 8, tasksDone: 1 }, codex: { turns: 6, edits: 5, messages: 9, tasksDone: 1 } }
      }
    ])

    render(<App />)

    expect(await screen.findByRole('heading', { name: /recent builds/i })).toBeVisible()
    expect(screen.getByText('Public Launch')).toBeVisible()
    expect(screen.getByText(/sealed build/i)).toBeVisible()
    expect(screen.queryByText(/secret app/i)).not.toBeInTheDocument()
    const interrupted = screen.getByTestId('recent-build-duo-run-interrupted')
    expect(interrupted).toHaveTextContent(/workspace preserved/i)
    await user.click(within(interrupted).getByRole('button', { name: /use prompt again/i }))
    expect(screen.getByLabelText(/opening prompt/i)).toHaveValue('Recover this original request.')
  })

  it('takes over the finished run with truthful readiness proof before reveal', async () => {
    const user = userEvent.setup()
    const ready: RunSnapshot = {
      ...createBroadcastRun(),
      phase: 'reveal.ready',
      status: 'reveal-ready',
      releaseStatus: 'ready',
      round: 12,
      tasks: [
        { id: 'ship', publicTitle: 'Ship the sealed build', status: 'done', claimedBy: 'claude', risk: 'medium', files: [] },
        { id: 'verify', publicTitle: 'Verify the result', status: 'done', claimedBy: 'codex', risk: 'low', files: [] }
      ],
      events: [
        ...createBroadcastRun().events,
        { id: 'passed', type: 'build.passed', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:00.000Z', agent: 'codex', publicText: 'The public verification gate passed.', spoilerRisk: 0.05, severity: 'low' },
        { id: 'checkpoint', type: 'git.checkpoint', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:01.000Z', agent: 'director', publicText: 'Final checkpoint recorded.', spoilerRisk: 0.05, severity: 'low' },
        { id: 'quality-state', type: 'decision', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:01.200Z', agent: 'director', topic: 'quality-evidence-state', publicText: 'Both reciprocal reviews survive on the current revision.', spoilerRisk: 0.05, severity: 'low', proof: { kind: 'quality-state', acceptedContributionAgents: ['claude', 'codex'], acceptedReviewAgents: ['claude', 'codex'] } },
        { id: 'supervisor', type: 'build.passed', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:01.400Z', agent: 'director', topic: 'supervisor-verification', publicText: 'Independent proof passed.', spoilerRisk: 0.05, severity: 'low', metadata: { checks: [{ id: 'brief:consensus-provenance', outcome: 'passed' }, { id: 'brief:requested-outcome', outcome: 'passed' }] } },
        { id: 'browser', type: 'decision', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:01.600Z', agent: 'director', topic: 'browser-qa-receipt', publicText: 'Browser QA passed.', spoilerRisk: 0.05, severity: 'low', metadata: { smokePassed: true, compactScreenshot: true, fullscreenScreenshot: true, consoleHealthy: true, interactionPassed: true } },
        { id: 'ready', type: 'reveal.ready', runId: 'run-broadcast-contract', round: 12, timestamp: '2026-07-10T10:10:02.000Z', agent: 'director', publicText: 'Reveal ready. The sealed result is prepared.', spoilerRisk: 1, severity: 'high' }
      ]
    }
    const api = createApi([ready])
    vi.mocked(api.revealRun).mockResolvedValue({ ...ready, status: 'complete', phase: 'complete' })
    window.duo = api

    render(<App />)

    const takeover = await screen.findByRole('dialog', { name: /the build survived/i })
    expect(within(takeover).getByRole('heading', { name: /^the build survived$/i })).toBeVisible()
    expect(within(takeover).getByRole('button', { name: /reveal app/i })).toHaveFocus()
    expect(document.querySelector('.app-frame')?.parentElement).toHaveAttribute('inert')
    expect(takeover).toHaveTextContent(/reveal ready/i)
    expect(takeover).toHaveTextContent('2/2 tasks complete')
    expect(takeover).toHaveTextContent('Verification passed')
    expect(takeover).toHaveTextContent('Final checkpoint recorded')
    expect(takeover).toHaveTextContent('2/2 accepted contributions')
    expect(takeover).toHaveTextContent('2/2 current reviews')
    expect(takeover).toHaveTextContent('Brief constraints proved')
    expect(takeover).toHaveTextContent('Browser QA passed')
    await user.click(within(takeover).getByRole('button', { name: /reveal app/i }))
    expect(api.revealRun).toHaveBeenCalledWith(ready.runId)
  })

  it('keeps real-event sound controls without the redundant clean-capture mode', async () => {
    const user = userEvent.setup()
    render(<App />)

    const sound = await screen.findByRole('button', { name: /sound cues/i })
    expect(screen.queryByRole('button', { name: /clean capture/i })).not.toBeInTheDocument()
    expect(sound).toHaveAttribute('aria-pressed', 'false')
    await user.click(sound)
    expect(sound).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.app-frame')).not.toHaveClass('recording-mode')
  })

  it('presents exact agent dispatches as a readable direct conversation', async () => {
    const run = createBroadcastRun()
    run.events = [
      {
        id: 'claude-direct', type: 'agent.dispatch', runId: run.runId, round: 2, timestamp: run.startedAt,
        agent: 'claude', targetAgent: 'codex', dispatchKind: 'position', claimKey: 'direction',
        publicText: 'I think we should keep one interaction and make its feedback impossible to miss.', spoilerRisk: 0, severity: 'medium'
      },
      {
        id: 'codex-direct', type: 'agent.dispatch', runId: run.runId, round: 3, timestamp: run.startedAt,
        agent: 'codex', targetAgent: 'claude', dispatchKind: 'counter', claimKey: 'direction', replyTo: 'claude-direct',
        publicText: 'I agree on one interaction, but I want a second input path before we call it ready.', spoilerRisk: 0, severity: 'medium'
      }
    ]
    window.duo = createApi([run])

    render(<App />)

    const feed = await screen.findByRole('log', { name: /live rivalry/i })
    expect(within(feed).getByText(/Claude to Codex/i)).toBeVisible()
    expect(within(feed).getByText(/Codex to Claude/i)).toBeVisible()
    expect(within(feed).getByText('I think we should keep one interaction and make its feedback impossible to miss.')).toBeVisible()
    expect(within(feed).getByText('I agree on one interaction, but I want a second input path before we call it ready.')).toBeVisible()
  })
})
