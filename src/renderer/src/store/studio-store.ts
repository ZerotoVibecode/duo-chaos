import { create } from 'zustand'
import type { BootstrapData } from '@shared/electron-api'
import type {
  AppSettings,
  ExecutionMode,
  MissionProfile,
  RecentBuildSummary,
  RunSnapshot,
  ToolHealth,
  VisibilityMode
} from '@shared/types'
import { releaseVerificationPassCount } from '@shared/verification-evidence'

interface LaunchForm {
  prompt: string
  workspaceRoot: string
  executionMode: ExecutionMode
  visibilityMode: VisibilityMode
  missionProfile: MissionProfile
  dangerousModeConfirmed: boolean
  unsafeWorkspaceRootConfirmed: boolean
}

interface StudioState {
  ready: boolean
  busy: boolean
  error?: string
  platform?: NodeJS.Platform
  settings?: AppSettings
  health: ToolHealth[]
  run?: RunSnapshot
  recentBuilds: RecentBuildSummary[]
  form: LaunchForm
  settingsOpen: boolean
  logsOpen: boolean
  soundEnabled: boolean
  bootstrap: () => Promise<void>
  applySnapshot: (snapshot: RunSnapshot) => void
  updateForm: (patch: Partial<LaunchForm>) => void
  chooseWorkspace: () => Promise<void>
  startRun: () => Promise<void>
  stopRun: () => Promise<void>
  resumeRun: (runId?: string) => Promise<void>
  revealRun: () => Promise<void>
  refreshHealth: () => Promise<void>
  saveSettings: (settings: AppSettings, options?: { syncLaunchDefaults?: boolean }) => Promise<void>
  openAgentCli: (agent: 'codex' | 'claude') => Promise<void>
  openRunFolder: (runId?: string) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setLogsOpen: (open: boolean) => void
  setSoundEnabled: (enabled: boolean) => void
  recoverRecentBuild: (build: RecentBuildSummary) => void
  clearError: () => void
  returnToLaunch: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected local error occurred.'
}

export const DEFAULT_SURPRISE_PROMPT = 'Create a surprising local app with one unforgettable interaction. Decide everything yourselves, challenge weak choices, and reveal it only when it is runnable.'

const initialForm: LaunchForm = {
  prompt: DEFAULT_SURPRISE_PROMPT,
  workspaceRoot: '',
  executionMode: 'simulation',
  visibilityMode: 'spoiler-shield',
  missionProfile: 'surprise',
  dangerousModeConfirmed: false,
  unsafeWorkspaceRootConfirmed: false
}

function emptyContribution(): RecentBuildSummary['proof']['claude'] {
  return { turns: 0, edits: 0, messages: 0, tasksDone: 0 }
}

function summaryFromSnapshot(run: RunSnapshot): RecentBuildSummary {
  const claude = emptyContribution()
  const codex = emptyContribution()
  for (const agent of ['claude', 'codex'] as const) {
    const contribution = agent === 'claude' ? claude : codex
    contribution.turns = run.events.filter((event) => event.agent === agent && event.type === 'agent.started').length
    contribution.edits = run.events.filter((event) => event.agent === agent && (
      event.type === 'file.changed' || (event.type === 'agent.activity' && event.category === 'file')
    )).length
    contribution.messages = run.events.filter((event) => event.agent === agent && (
      event.type === 'agent.dispatch' || event.type === 'opinion'
    )).length
    contribution.tasksDone = run.tasks.filter((task) => task.claimedBy === agent && task.status === 'done').length
  }
  const status = run.status === 'running' || run.status === 'idle' ? 'interrupted' : run.status
  const workspaceRoot = run.workspacePath.replace(/[\\/][^\\/]+$/u, '')
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    status,
    phase: run.phase,
    executionMode: run.executionMode,
    visibilityMode: run.visibilityMode,
    missionProfile: run.missionProfile ?? 'surprise',
    prompt: run.prompt,
    workspacePath: run.workspacePath,
    workspaceRoot,
    ...(run.status === 'complete' && run.revealPacket?.appName ? { appName: run.revealPacket.appName } : {}),
    ...(run.releaseStatus ? { releaseStatus: run.releaseStatus } : {}),
    sealed: run.status !== 'complete',
    recoverable: run.status === 'cancelled' || run.status === 'failed' || run.status === 'running' || run.status === 'paused',
    resumable: run.status === 'paused',
    proof: {
      tasksDone: run.tasks.filter((task) => task.status === 'done').length,
      tasksTotal: run.tasks.length,
      checkpoints: run.events.filter((event) => event.type === 'git.checkpoint').length,
      buildPasses: releaseVerificationPassCount(run.events, run.releaseStatus),
      claude,
      codex
    }
  }
}

function upsertRecent(builds: RecentBuildSummary[], next: RecentBuildSummary): RecentBuildSummary[] {
  return [next, ...builds.filter((build) => build.runId !== next.runId)]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 8)
}

export const useStudioStore = create<StudioState>((set, get) => ({
  ready: false,
  busy: false,
  health: [],
  recentBuilds: [],
  form: initialForm,
  settingsOpen: false,
  logsOpen: false,
  soundEnabled: false,

  bootstrap: async () => {
    set({ ready: false, busy: true, error: undefined })
    try {
      const data: BootstrapData = await window.duo.getBootstrap()
      const sortedRuns = [...data.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      const active = sortedRuns.find((candidate) => candidate.status === 'running' || candidate.status === 'paused' || candidate.status === 'reveal-ready')
      const terminalRuns = sortedRuns.filter((candidate) => candidate.status !== 'running' && candidate.status !== 'paused' && candidate.status !== 'reveal-ready')
      const resumableRunIds = new Set(sortedRuns
        .filter((candidate) => candidate.status === 'paused')
        .map((candidate) => candidate.runId))
      const durableHistory = (data.recentBuilds?.length
        ? data.recentBuilds
        : terminalRuns.map(summaryFromSnapshot))
        .map((build) => ({
          ...build,
          resumable: build.status === 'paused' && resumableRunIds.has(build.runId)
        }))
      const legacyComplete = data.recentBuilds && data.recentBuilds.length === 0
        ? sortedRuns.find((candidate) => candidate.status === 'complete')
        : undefined
      set({
        ready: true,
        busy: false,
        platform: data.platform,
        settings: data.settings,
        health: data.health,
        recentBuilds: durableHistory,
        run: active ?? legacyComplete,
        soundEnabled: false,
        form: {
          ...get().form,
          workspaceRoot: data.settings.defaultWorkspaceRoot,
          executionMode: data.settings.defaultExecutionMode,
          visibilityMode: data.settings.defaultVisibilityMode,
          missionProfile: data.settings.defaultMissionProfile
        }
      })
    } catch (error) {
      set({ ready: true, busy: false, error: messageOf(error) })
    }
  },

  applySnapshot: (run) => set((state) => ({
    run,
    busy: false,
    recentBuilds: run.status === 'running'
      ? state.recentBuilds
      : upsertRecent(state.recentBuilds, summaryFromSnapshot(run))
  })),
  updateForm: (patch) => set((state) => ({ form: { ...state.form, ...patch }, error: undefined })),

  chooseWorkspace: async () => {
    try {
      const path = await window.duo.selectWorkspace()
      if (path) get().updateForm({ workspaceRoot: path, unsafeWorkspaceRootConfirmed: false })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  startRun: async () => {
    const { form, settings } = get()
    if (!settings) return
    set({ busy: true, error: undefined })
    try {
      await window.duo.startRun({
        prompt: form.prompt,
        workspaceRoot: form.workspaceRoot,
        executionMode: form.executionMode,
        visibilityMode: form.visibilityMode,
        missionProfile: form.missionProfile,
        maxTurns: settings.maxTurns,
        maxRepairLoops: settings.maxRepairLoops,
        turnTimeoutSeconds: settings.turnTimeoutSeconds,
        runTimeoutSeconds: settings.runTimeoutSeconds,
        dangerousModeConfirmed: form.dangerousModeConfirmed,
        unsafeWorkspaceRootConfirmed: form.unsafeWorkspaceRootConfirmed
      })
      set({ busy: false })
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  stopRun: async () => {
    const run = get().run
    if (!run) return
    set({ busy: true })
    try {
      set({ run: await window.duo.stopRun(run.runId), busy: false })
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  resumeRun: async (runId) => {
    const current = get().run
    const targetRunId = runId ?? current?.runId
    if (!targetRunId) return
    set({ busy: true, error: undefined })
    try {
      const resumed = await window.duo.resumeRun(targetRunId)
      get().applySnapshot(resumed)
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  revealRun: async () => {
    const run = get().run
    if (!run) return
    set({ busy: true })
    try {
      set({ run: await window.duo.revealRun(run.runId), busy: false })
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  refreshHealth: async () => {
    set({ busy: true })
    try {
      set({ health: await window.duo.refreshHealth(), busy: false })
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  saveSettings: async (settings, options = {}) => {
    set({ busy: true })
    try {
      const previousRoot = get().settings?.defaultWorkspaceRoot
      const saved = await window.duo.saveSettings(settings)
      const rootChanged = previousRoot !== undefined &&
        previousRoot.replaceAll('\\', '/').toLocaleLowerCase() !== saved.defaultWorkspaceRoot.replaceAll('\\', '/').toLocaleLowerCase()
      const refreshed = rootChanged ? await window.duo.getBootstrap() : undefined
      const resumableRunIds = new Set((refreshed?.runs ?? [])
        .filter((candidate) => candidate.status === 'paused')
        .map((candidate) => candidate.runId))
      const refreshedHistory = refreshed?.recentBuilds?.map((build) => ({
        ...build,
        resumable: build.status === 'paused' && resumableRunIds.has(build.runId)
      }))
      const syncLaunchDefaults = options.syncLaunchDefaults !== false
      set((state) => ({
        settings: saved,
        settingsOpen: syncLaunchDefaults ? false : state.settingsOpen,
        busy: false,
        recentBuilds: refreshedHistory ?? state.recentBuilds,
        form: syncLaunchDefaults ? {
          ...state.form,
          workspaceRoot: saved.defaultWorkspaceRoot,
          executionMode: saved.defaultExecutionMode,
          visibilityMode: saved.defaultVisibilityMode,
          missionProfile: saved.defaultMissionProfile
        } : state.form
      }))
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },

  openAgentCli: async (agent) => {
    try {
      await window.duo.openAgentCli(agent)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  openRunFolder: async (runId) => {
    const targetRunId = runId ?? get().run?.runId
    if (!targetRunId) return
    try {
      await window.duo.openRunFolder(targetRunId)
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLogsOpen: (logsOpen) => set({ logsOpen }),
  setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
  recoverRecentBuild: (build) => set((state) => ({
    run: undefined,
    error: undefined,
    logsOpen: false,
    form: {
      ...state.form,
      prompt: build.prompt,
      workspaceRoot: build.workspaceRoot,
      executionMode: build.executionMode,
      visibilityMode: build.visibilityMode,
      missionProfile: build.missionProfile ?? 'surprise',
      dangerousModeConfirmed: false,
      unsafeWorkspaceRootConfirmed: false
    }
  })),
  clearError: () => set({ error: undefined }),
  returnToLaunch: () =>
    set((state) => ({
      run: undefined,
      error: undefined,
      logsOpen: false,
      recentBuilds: state.run
        ? upsertRecent(state.recentBuilds, summaryFromSnapshot(state.run))
        : state.recentBuilds,
      form: {
        ...state.form,
        ...(state.run ? { prompt: state.run.prompt } : {})
      }
    }))
}))
