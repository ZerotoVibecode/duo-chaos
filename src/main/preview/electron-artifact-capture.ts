import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ArtifactPixelCapture } from './artifact-preview'
import {
  ARTIFACT_PREVIEW_HOST,
  ARTIFACT_PREVIEW_SCHEME,
  resolveArtifactResource
} from './artifact-resource'

const PREVIEW_WIDTH = 1280
const PREVIEW_HEIGHT = 720
const LOAD_TIMEOUT_MS = 10_000
const CAPTURE_TIMEOUT_MS = 5_000
const SETTLE_TIME_MS = 700

const PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

export type ArtifactFileFetcher = (path: string) => Promise<Response>

export function createArtifactProtocolHandler(
  resourceRoot: string,
  fetchFile: ArtifactFileFetcher
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Artifact request method is not allowed.', { status: 405 })
    }
    try {
      const path = await resolveArtifactResource(resourceRoot, request.url, request.method)
      const source = await fetchFile(path)
      const headers = new Headers(source.headers)
      headers.set('content-security-policy', PREVIEW_CSP)
      headers.set('x-content-type-options', 'nosniff')
      headers.set('cache-control', 'no-store')
      return new Response(request.method === 'HEAD' ? null : source.body, {
        status: source.status,
        statusText: source.statusText,
        headers
      })
    } catch {
      return new Response('Artifact resource unavailable.', {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      })
    }
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Artifact preview timed out.')), milliseconds)
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error('Artifact preview failed.'))
      }
    )
  })
}

function allowedPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === `${ARTIFACT_PREVIEW_SCHEME}:` && url.hostname === ARTIFACT_PREVIEW_HOST
  } catch {
    return false
  }
}

export const captureArtifactPixels: ArtifactPixelCapture = async (target) => {
  const { BrowserWindow, net, session } = await import('electron')
  const partition = `duo-artifact-preview-${randomUUID()}`
  const previewSession = session.fromPartition(partition, { cache: false })
  const handler = createArtifactProtocolHandler(
    target.resourceRoot,
    (path) => net.fetch(pathToFileURL(path).toString())
  )
  previewSession.protocol.handle(ARTIFACT_PREVIEW_SCHEME, handler)
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = allowedPreviewUrl(details.url) || details.url.startsWith('data:') || details.url.startsWith('blob:')
    callback({ cancel: !allowed })
  })
  previewSession.on('will-download', (event) => event.preventDefault())

  const previewWindow = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#070910',
    webPreferences: {
      partition,
      offscreen: true,
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
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  previewWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedPreviewUrl(url)) event.preventDefault()
  })
  previewWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const rendererFailure = new Promise<never>((_resolve, reject) => {
    previewWindow.webContents.once('render-process-gone', () => reject(new Error('Artifact renderer exited.')))
    previewWindow.once('unresponsive', () => reject(new Error('Artifact renderer became unresponsive.')))
  })
  const entryUrl = `${ARTIFACT_PREVIEW_SCHEME}://${ARTIFACT_PREVIEW_HOST}/${encodeURIComponent(basename(target.entryPath))}`

  try {
    await withTimeout(Promise.race([previewWindow.loadURL(entryUrl), rendererFailure]), LOAD_TIMEOUT_MS)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_TIME_MS))
    const image = await withTimeout(Promise.race([previewWindow.webContents.capturePage(), rendererFailure]), CAPTURE_TIMEOUT_MS)
    if (image.isEmpty()) throw new Error('Artifact preview was empty.')
    const size = image.getSize()
    return {
      imageDataUrl: image.toDataURL(),
      width: size.width,
      height: size.height,
      capturedAt: new Date().toISOString()
    }
  } finally {
    if (!previewWindow.isDestroyed()) previewWindow.destroy()
    previewSession.protocol.unhandle(ARTIFACT_PREVIEW_SCHEME)
    await Promise.allSettled([
      previewSession.clearCache(),
      previewSession.clearStorageData()
    ])
  }
}
