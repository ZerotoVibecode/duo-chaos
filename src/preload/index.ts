import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DuoElectronApi } from '@shared/electron-api'
import type { AppSettings, RunSnapshot, StartRunRequest } from '@shared/types'

const api: DuoElectronApi = {
  getBootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  refreshHealth: () => ipcRenderer.invoke(IPC.healthRefresh),
  selectWorkspace: () => ipcRenderer.invoke(IPC.workspaceSelect),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  startRun: (request: StartRunRequest) => ipcRenderer.invoke(IPC.runStart, request),
  stopRun: (runId: string) => ipcRenderer.invoke(IPC.runStop, runId),
  resumeRun: (runId: string) => ipcRenderer.invoke(IPC.runResume, runId),
  revealRun: (runId: string) => ipcRenderer.invoke(IPC.runReveal, runId),
  revealPartialRun: (runId: string) => ipcRenderer.invoke(IPC.runRevealPartial, runId),
  openArchivedRun: (runId: string) => ipcRenderer.invoke(IPC.runOpenArchive, runId),
  openRunFolder: (runId: string) => ipcRenderer.invoke(IPC.runOpenFolder, runId),
  openGeneratedApp: (runId: string) => ipcRenderer.invoke(IPC.runOpenApp, runId),
  getArtifactPreview: (runId: string) => ipcRenderer.invoke(IPC.runArtifactPreview, runId),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.externalOpen, url),
  openAgentCli: (agent: 'codex' | 'claude') => ipcRenderer.invoke(IPC.agentCliOpen, agent),
  onRunSnapshot: (listener: (snapshot: RunSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: RunSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.runSnapshot, handler)
    return () => ipcRenderer.removeListener(IPC.runSnapshot, handler)
  },
  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose)
}

contextBridge.exposeInMainWorld('duo', api)
