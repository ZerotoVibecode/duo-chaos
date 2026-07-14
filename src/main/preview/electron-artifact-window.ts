import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import type { ReadyArtifactPreviewTarget } from './artifact-preview-target'
import {
  ARTIFACT_PREVIEW_HOST,
  ARTIFACT_PREVIEW_SCHEME
} from './artifact-resource'
import { createArtifactProtocolHandler } from './electron-artifact-capture'

const launchedArtifactWindows = new Set<ElectronBrowserWindow>()

/**
 * Generated artifacts are auxiliary Studio windows, not independent app
 * windows. Destroy them synchronously when their owner or Electron exits so a
 * closed Studio can never remain alive as a headless artifact process.
 */
export function closeArtifactWindows(): void {
  for (const artifactWindow of [...launchedArtifactWindows]) {
    if (!artifactWindow.isDestroyed()) artifactWindow.destroy()
  }
}

const ARTIFACT_LAUNCH_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

function allowedArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === `${ARTIFACT_PREVIEW_SCHEME}:` && url.hostname === ARTIFACT_PREVIEW_HOST
  } catch {
    return false
  }
}

/**
 * Opens a built browser artifact without file:// semantics or an arbitrary
 * package command. Each launch receives an ephemeral, sandboxed session whose
 * custom protocol is rooted at the already containment-checked artifact.
 */
export async function openArtifactWindow(
  target: ReadyArtifactPreviewTarget,
  owner?: ElectronBrowserWindow
): Promise<void> {
  const { BrowserWindow, net, session } = await import('electron')
  const partition = `duo-artifact-launch-${randomUUID()}`
  const artifactSession = session.fromPartition(partition, { cache: false })
  const handler = createArtifactProtocolHandler(
    target.resourceRoot,
    (path) => net.fetch(pathToFileURL(path).toString()),
    { contentSecurityPolicy: ARTIFACT_LAUNCH_CSP }
  )
  artifactSession.protocol.handle(ARTIFACT_PREVIEW_SCHEME, handler)
  artifactSession.setPermissionCheckHandler(() => false)
  artifactSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  artifactSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = allowedArtifactUrl(details.url) || details.url.startsWith('data:') || details.url.startsWith('blob:')
    callback({ cancel: !allowed })
  })
  artifactSession.on('will-download', (event) => event.preventDefault())

  const artifactWindow = new BrowserWindow({
    ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#070910',
    title: 'Generated app — Duo Chaos',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false
    }
  })
  launchedArtifactWindows.add(artifactWindow)
  artifactWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  artifactWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedArtifactUrl(url)) event.preventDefault()
  })
  artifactWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    launchedArtifactWindows.delete(artifactWindow)
    artifactSession.protocol.unhandle(ARTIFACT_PREVIEW_SCHEME)
    await Promise.allSettled([
      artifactSession.clearCache(),
      artifactSession.clearStorageData()
    ])
  }
  artifactWindow.once('closed', () => { void cleanup() })

  const entryUrl = `${ARTIFACT_PREVIEW_SCHEME}://${ARTIFACT_PREVIEW_HOST}/${encodeURIComponent(basename(target.entryPath))}`
  try {
    await artifactWindow.loadURL(entryUrl)
    if (!artifactWindow.isDestroyed()) artifactWindow.show()
  } catch (error) {
    if (!artifactWindow.isDestroyed()) artifactWindow.destroy()
    await cleanup()
    throw error
  }
}
