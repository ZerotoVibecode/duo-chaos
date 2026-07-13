import type {
  AppSettings,
  ArtifactPreviewResult,
  RecentBuildSummary,
  RunSnapshot,
  StartRunRequest,
  StartRunResult,
  ToolHealth
} from './types'

export interface BootstrapData {
  settings: AppSettings
  health: ToolHealth[]
  runs: RunSnapshot[]
  recentBuilds?: RecentBuildSummary[]
  platform: NodeJS.Platform
}

export interface DuoElectronApi {
  getBootstrap: () => Promise<BootstrapData>
  refreshHealth: () => Promise<ToolHealth[]>
  selectWorkspace: () => Promise<string | null>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  startRun: (request: StartRunRequest) => Promise<StartRunResult>
  stopRun: (runId: string) => Promise<RunSnapshot>
  resumeRun: (runId: string) => Promise<RunSnapshot>
  revealRun: (runId: string) => Promise<RunSnapshot>
  openRunFolder: (runId: string) => Promise<void>
  openGeneratedApp: (runId: string) => Promise<void>
  getArtifactPreview: (runId: string) => Promise<ArtifactPreviewResult>
  openExternal: (url: string) => Promise<void>
  openAgentCli: (agent: 'codex' | 'claude') => Promise<void>
  onRunSnapshot: (listener: (snapshot: RunSnapshot) => void) => () => void
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
}

export const IPC = {
  bootstrap: 'app:bootstrap',
  healthRefresh: 'health:refresh',
  workspaceSelect: 'workspace:select',
  settingsSave: 'settings:save',
  runStart: 'run:start',
  runStop: 'run:stop',
  runResume: 'run:resume',
  runReveal: 'run:reveal',
  runOpenFolder: 'run:open-folder',
  runOpenApp: 'run:open-app',
  runArtifactPreview: 'run:artifact-preview',
  externalOpen: 'external:open',
  agentCliOpen: 'agent-cli:open',
  runSnapshot: 'run:snapshot',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close'
} as const
