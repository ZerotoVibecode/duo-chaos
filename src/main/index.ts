import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC, type BootstrapData } from '@shared/electron-api'
import type { AppSettings } from '@shared/types'
import { checkAllTools } from '@main/health/health-check'
import { loadArchivedCompleteRunSnapshot, scanRecentBuilds } from '@main/history/run-history'
import { resolveOpenableRunWorkspace } from '@main/history/openable-run-workspace'
import { createArtifactPreview } from '@main/preview/artifact-preview'
import { ArtifactPreviewCache } from '@main/preview/artifact-preview-cache'
import { prepareArtifactPreviewTarget } from '@main/preview/artifact-preview-target'
import { ARTIFACT_PREVIEW_SCHEME } from '@main/preview/artifact-resource'
import { captureArtifactPixels } from '@main/preview/electron-artifact-capture'
import { closeArtifactWindows, openArtifactWindow } from '@main/preview/electron-artifact-window'
import { RunOrchestrator } from '@main/orchestrator/run-orchestrator'
import { launchInteractiveCli } from '@main/process/terminal-launcher'
import { SettingsStore } from '@main/settings/settings-store'
import { assertTrustedStudioSender, isTrustedStudioNavigation } from '@main/security/studio-trust-boundary'

let mainWindow: BrowserWindow | null = null
let settingsStore: SettingsStore
let orchestrator: RunOrchestrator
let cachedHealth: BootstrapData['health'] = []
let studioRuntimeRoot = ''
let shutdownInProgress = false
let shutdownPrepared = false
const artifactPreviewCache = new ArtifactPreviewCache()
const rendererFilePath = join(__dirname, '../renderer/index.html')
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || undefined

const isolatedE2eUserData = process.env.DUO_CHAOS_E2E === '1'
  ? process.env.DUO_CHAOS_E2E_USER_DATA?.trim()
  : undefined
if (isolatedE2eUserData) app.setPath('userData', resolve(isolatedE2eUserData))

protocol.registerSchemesAsPrivileged([{
  scheme: ARTIFACT_PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    allowServiceWorkers: false
  }
}])

function broadcastSnapshot(snapshot: BootstrapData['runs'][number]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.runSnapshot, snapshot)
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const initialWidth = Math.min(1680, Math.max(900, Math.round(workArea.width * 0.88)))
  const initialHeight = Math.min(1040, Math.max(640, Math.round(workArea.height * 0.9)))
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#05060a',
    icon: join(__dirname, '../../resources/icon.png'),
    title: 'Duo Chaos by ZeroToVibecode',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(!isMac
      ? {
          titleBarOverlay: {
            color: '#05060a00',
            symbolColor: '#d9e0f0',
            height: 46
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedStudioNavigation(url, { rendererFilePath, developmentUrl: developmentRendererUrl })) {
      event.preventDefault()
    }
  })
  const createdWindow = mainWindow
  createdWindow.once('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null
    closeArtifactWindows()
  })

  if (developmentRendererUrl) {
    void mainWindow.loadURL(developmentRendererUrl)
  } else {
    void mainWindow.loadFile(rendererFilePath)
  }
}

function trustedHandle<TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedStudioSender(event, mainWindow)
    return listener(event, ...(args as TArgs))
  })
}

async function resolveCompleteRun(runId: string): Promise<BootstrapData['runs'][number] | undefined> {
  const live = orchestrator.getSnapshot(runId)
  if (live?.status === 'complete' && live.revealPacket) return live
  const settings = await settingsStore.load()
  return await loadArchivedCompleteRunSnapshot(settings.defaultWorkspaceRoot, runId, {
    runtimeRoot: studioRuntimeRoot
  })
}

function registerIpc(): void {
  trustedHandle(IPC.bootstrap, async (): Promise<BootstrapData> => {
    const settings = await settingsStore.load()
    if (cachedHealth.length === 0) cachedHealth = await checkAllTools(settings)
    return {
      settings,
      health: cachedHealth,
      runs: orchestrator.listSnapshots(),
      recentBuilds: await scanRecentBuilds(settings.defaultWorkspaceRoot, 8, {
        runtimeRoot: studioRuntimeRoot
      }),
      platform: process.platform
    }
  })

  trustedHandle(IPC.healthRefresh, async () => {
    cachedHealth = await checkAllTools(await settingsStore.load())
    return cachedHealth
  })

  trustedHandle(IPC.workspaceSelect, async () => {
    const settings = await settingsStore.load()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a dedicated workspace root',
      defaultPath: settings.defaultWorkspaceRoot,
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  trustedHandle(IPC.settingsSave, async (_event, settings: AppSettings) => {
    const saved = await settingsStore.save(settings)
    cachedHealth = await checkAllTools(saved)
    return saved
  })
  trustedHandle(IPC.runStart, (_event, request: unknown) => orchestrator.start(request))
  trustedHandle(IPC.runStop, (_event, runId: string) => orchestrator.stop(runId))
  trustedHandle(IPC.runResume, (_event, runId: string) => orchestrator.resume(runId))
  trustedHandle(IPC.runReveal, (_event, runId: string) => orchestrator.reveal(runId))
  trustedHandle(IPC.runRevealPartial, (_event, runId: string) => orchestrator.revealPartial(runId))
  trustedHandle(IPC.runOpenArchive, async (_event, runId: string) => {
    const snapshot = await resolveCompleteRun(runId)
    if (!snapshot) throw new Error('This completed build could not be reopened from the local archive.')
    return snapshot
  })
  trustedHandle(IPC.runOpenFolder, async (_event, runId: string) => {
    const snapshot = orchestrator.getSnapshot(runId)
    const settings = await settingsStore.load()
    const workspacePath = await resolveOpenableRunWorkspace({
      runId,
      ...(snapshot ? { snapshot } : {}),
      workspaceRoot: settings.defaultWorkspaceRoot,
      scanOptions: { runtimeRoot: studioRuntimeRoot }
    })
    if (!workspacePath) throw new Error('Pause or finish the run before opening its folder.')
    const error = await shell.openPath(workspacePath)
    if (error) throw new Error(error)
  })
  trustedHandle(IPC.runOpenApp, async (_event, runId: string) => {
    const snapshot = await resolveCompleteRun(runId)
    if (!snapshot) throw new Error('Reveal the run before opening the generated app.')
    const configuredTarget = snapshot.revealPacket?.appPath || snapshot.appPath
    const target = await prepareArtifactPreviewTarget(snapshot.workspacePath, configuredTarget)
    if (target.status !== 'ready') throw new Error(target.message)
    await openArtifactWindow(target, mainWindow ?? undefined)
  })
  trustedHandle(IPC.runArtifactPreview, async (_event, runId: string) => {
    const snapshot = await resolveCompleteRun(runId)
    if (!snapshot) {
      throw new Error('Reveal the run before preparing its artifact preview.')
    }
    return await artifactPreviewCache.getOrCreate(runId, () => {
      const configuredTarget = snapshot.revealPacket?.appPath || snapshot.appPath
      return createArtifactPreview({
        workspacePath: snapshot.workspacePath,
        configuredTarget
      }, captureArtifactPixels)
    })
  })
  trustedHandle(IPC.externalOpen, async (_event, value: string) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP links can be opened.')
    await shell.openExternal(url.toString())
  })
  trustedHandle(IPC.agentCliOpen, async (_event, agent: 'codex' | 'claude') => {
    if (agent !== 'codex' && agent !== 'claude') throw new Error('Unknown agent CLI.')
    const settings = await settingsStore.load()
    await mkdir(settings.defaultWorkspaceRoot, { recursive: true })
    await launchInteractiveCli({
      binary: agent === 'codex' ? settings.codexPath : settings.claudePath,
      cwd: settings.defaultWorkspaceRoot
    })
  })
  trustedHandle(IPC.windowMinimize, () => mainWindow?.minimize())
  trustedHandle(IPC.windowToggleMaximize, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  trustedHandle(IPC.windowClose, () => mainWindow?.close())
}

void app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  studioRuntimeRoot = join(userData, 'runs')
  const defaultWorkspaceRoot = join(app.getPath('documents'), 'ZeroToVibecode', 'DuoChaos', 'workspaces')
  await Promise.all([
    mkdir(defaultWorkspaceRoot, { recursive: true }),
    mkdir(studioRuntimeRoot, { recursive: true })
  ])
  settingsStore = new SettingsStore(join(userData, 'settings.json'), defaultWorkspaceRoot)
  orchestrator = new RunOrchestrator({
    runtimeRoot: studioRuntimeRoot,
    getSettings: () => settingsStore.load(),
    onSnapshot: broadcastSnapshot
  })
  await orchestrator.restore()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  closeArtifactWindows()
  if (shutdownPrepared) return
  if (!orchestrator) {
    shutdownPrepared = true
    return
  }
  event.preventDefault()
  if (shutdownInProgress) return
  shutdownInProgress = true
  void orchestrator.suspendForShutdown()
    .catch(() => undefined)
    .finally(() => {
      shutdownPrepared = true
      app.quit()
    })
})
