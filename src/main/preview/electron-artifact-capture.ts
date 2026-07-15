import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  SupervisorBrowserEvidence,
  SupervisorBrowserEvidencePort,
  SupervisorBrowserViewportEvidence,
  SupervisorBrowserViewportId
} from '@main/orchestrator/supervisor-verifier'
import type { ArtifactPixelCapture } from './artifact-preview'
import type { ReadyArtifactPreviewTarget } from './artifact-preview-target'
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

export const ARTIFACT_QUALITY_VIEWPORTS: ReadonlyArray<{
  id: SupervisorBrowserViewportId
  width: number
  height: number
}> = [
  { id: 'compact', width: 900, height: 640 },
  { id: 'full', width: 1600, height: 900 }
]

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
const QUALITY_PREVIEW_CSP = PREVIEW_CSP.replace("connect-src 'none'", "connect-src 'self'")

export const DOM_QUALITY_INSPECTION = `
(async () => {
  const visible = (element) => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
  }
  const labelText = (element) => {
    const ariaLabel = element.getAttribute('aria-label') || ''
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
    const nativeLabels = 'labels' in element && element.labels
      ? Array.from(element.labels).map((label) => label.textContent || '').join(' ')
      : ''
    const semanticText = element.matches('button, a[href], [role="button"]') ? element.textContent || '' : ''
    const inputValue = element.matches('input[type="button"], input[type="submit"], input[type="reset"]') ? element.value || '' : ''
    return [ariaLabel, labelledBy, nativeLabels, semanticText, inputValue, element.getAttribute('title') || '', element.getAttribute('alt') || '']
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim()
  }
  const candidates = Array.from(document.querySelectorAll('button:not([disabled]), a[href], input:not([type="hidden"]):not([type="file"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])'))
    .filter(visible)
  const accessible = candidates.filter((element) => labelText(element).length > 0)
  const interactionCandidates = [
    ...candidates.filter((element) => !element.matches('a[href]')),
    ...candidates.filter((element) => element.matches('a[href]'))
  ].slice(0, 3)
  let interactionAttempted = false
  let interactionSucceeded = false
  let interactionAttemptCount = 0
  let interactionSuccessCount = 0
  const interactionObservedChanges = new Set()
  const fingerprint = (value) => {
    const text = String(value || '')
    const stride = Math.max(1, Math.ceil(text.length / 100000))
    let hash = 2166136261
    for (let index = 0; index < text.length; index += stride) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return String(text.length) + ':' + String(hash >>> 0)
  }
  const state = (activeCandidate) => {
    // Exclude the control being driven. Assigning an input's native value is
    // an action performed by this probe, not proof that the app observed it.
    const controls = Array.from(document.querySelectorAll('input, select, textarea, button, [role="button"]'))
      .filter((element) => element !== activeCandidate)
      .slice(0, 128)
      .map((element) => ({
        value: 'value' in element ? String(element.value) : '',
        checked: 'checked' in element ? Boolean(element.checked) : false,
        selectedIndex: 'selectedIndex' in element ? Number(element.selectedIndex) : -1,
        disabled: 'disabled' in element ? Boolean(element.disabled) : false
      }))
    const aria = Array.from(document.querySelectorAll('*'))
      .slice(0, 512)
      .map((element) => Array.from(element.attributes)
        .filter((item) => item.name.startsWith('aria-') || item.name === 'hidden' || item.name === 'open' || item.name === 'data-state')
        .map((item) => item.name + '=' + item.value)
        .join('|'))
      .join('||')
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .slice(0, 4)
      .map((canvas) => {
        try { return fingerprint(canvas.toDataURL('image/png')) } catch { return 'unavailable' }
      })
    return {
      url: window.location.href,
      dom: fingerprint(document.body?.innerHTML || ''),
      text: fingerprint(document.body?.innerText || document.body?.textContent || ''),
      controls: fingerprint(JSON.stringify(controls)),
      aria: fingerprint(aria),
      canvas: fingerprint(canvases.join('|'))
    }
  }
  const recordStateChanges = (beforeState, afterState, changes) => {
    if (afterState.url !== beforeState.url) changes.add('navigation')
    if (afterState.controls !== beforeState.controls) changes.add('value')
    if (afterState.aria !== beforeState.aria) changes.add('aria')
    if (afterState.canvas !== beforeState.canvas) changes.add('canvas')
    if (afterState.dom !== beforeState.dom || afterState.text !== beforeState.text) changes.add('dom')
  }
  for (const interactionCandidate of interactionCandidates) {
    if (!interactionCandidate?.isConnected || !visible(interactionCandidate)) continue
    interactionAttempted = true
    interactionAttemptCount += 1
    const observedChanges = new Set()
    const baselineStart = state(interactionCandidate)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const before = state(interactionCandidate)
    const ambientChanges = new Set()
    recordStateChanges(baselineStart, before, ambientChanges)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const nativeMutation = record.target === interactionCandidate &&
          record.type === 'attributes' &&
          ['value', 'checked', 'selected'].includes(record.attributeName || '')
        if (nativeMutation) continue
        observedChanges.add(record.type === 'attributes' && record.attributeName?.startsWith('aria-') ? 'aria' : 'dom')
      }
    })
    if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })

    if ('focus' in interactionCandidate) interactionCandidate.focus({ preventScroll: true })
    const form = interactionCandidate.closest?.('form')
    const preventNavigation = (event) => event.preventDefault()
    if (form && interactionCandidate.matches('button:not([type]), button[type="submit"], input[type="submit"]')) {
      form.addEventListener('submit', preventNavigation, { capture: true, once: true })
    }

    if (interactionCandidate.matches('select') && interactionCandidate.options.length > 1) {
      interactionCandidate.selectedIndex = (interactionCandidate.selectedIndex + 1) % interactionCandidate.options.length
      interactionCandidate.dispatchEvent(new Event('input', { bubbles: true }))
      interactionCandidate.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (interactionCandidate.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], input[type="range"]')) {
      const current = String(interactionCandidate.value || '')
      interactionCandidate.value = interactionCandidate.matches('input[type="number"], input[type="range"]')
        ? String(Number(current || '0') + 1)
        : (current ? current + 'a' : 'test')
      interactionCandidate.dispatchEvent(new Event('input', { bubbles: true }))
      interactionCandidate.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (typeof interactionCandidate.click === 'function') {
      interactionCandidate.click()
    } else {
      interactionCandidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }

    for (let attempt = 0; attempt < 7; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const after = state(interactionCandidate)
      recordStateChanges(before, after, observedChanges)
      if (observedChanges.size > 0) break
    }
    observer.disconnect()
    for (const ambientChange of ambientChanges) observedChanges.delete(ambientChange)
    if (observedChanges.size > 0) interactionSuccessCount += 1
    for (const observedChange of observedChanges) interactionObservedChanges.add(observedChange)
  }
  interactionSucceeded = interactionSuccessCount > 0
  const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim()
  const severeTextWrapCount = Array.from(document.querySelectorAll('body *')).filter((element) => {
    if (!visible(element) || element.closest('svg, canvas') || element.matches('input, select, textarea, button')) return false
    const text = (element.textContent || '').replace(/\\s+/g, ' ').trim()
    if (text.replace(/\\s+/g, '').length < 8) return false
    const visibleTextChild = Array.from(element.children).some((child) => visible(child) && (child.textContent || '').trim().length > 0)
    if (visibleTextChild) return false
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return false
    const lines = Math.max(1, Math.round(rect.height / lineHeight))
    const averageCharactersPerLine = text.replace(/\\s+/g, '').length / lines
    return lines >= 4 && averageCharactersPerLine < 4
  }).length
  return {
    visibleTextCharacters: bodyText.length,
    mainLandmark: Boolean(document.querySelector('main, [role="main"]')),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    severeTextWrapCount,
    interactiveElementCount: candidates.length,
    accessibleInteractiveElementCount: accessible.length,
    interactionAttempted,
    interactionSucceeded,
    interactionAttemptCount,
    interactionSuccessCount,
    interactionObservedChanges: Array.from(interactionObservedChanges).sort()
  }
})()
`

export type ArtifactFileFetcher = (path: string) => Promise<Response>

export interface ArtifactProtocolPolicy {
  contentSecurityPolicy?: string
}

export function createArtifactProtocolHandler(
  resourceRoot: string,
  fetchFile: ArtifactFileFetcher,
  policy: ArtifactProtocolPolicy = {}
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Artifact request method is not allowed.', { status: 405 })
    }
    try {
      const path = await resolveArtifactResource(resourceRoot, request.url, request.method)
      const source = await fetchFile(path)
      const headers = new Headers(source.headers)
      headers.set('content-security-policy', policy.contentSecurityPolicy ?? PREVIEW_CSP)
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

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('Artifact preview was cancelled.'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Artifact preview was cancelled.'))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('Artifact preview failed.'))
      }
    )
  })
}

interface DomQualityEvidence {
  visibleTextCharacters: number
  mainLandmark: boolean
  horizontalOverflow: boolean
  severeTextWrapCount: number
  interactiveElementCount: number
  accessibleInteractiveElementCount: number
  interactionAttempted: boolean
  interactionSucceeded: boolean
  interactionAttemptCount: number
  interactionSuccessCount: number
  interactionObservedChanges: string[]
}

interface CapturedViewport {
  imageDataUrl: string
  width: number
  height: number
  capturedAt: string
  consoleErrors: string[]
  pageErrors: string[]
  dom?: DomQualityEvidence
}

async function capturePreviewViewport(
  target: ReadyArtifactPreviewTarget,
  width: number,
  height: number,
  abortSignal?: AbortSignal,
  inspectDom = false,
  allowSameOriginConnections = false
): Promise<CapturedViewport> {
  if (abortSignal?.aborted) throw new Error('Artifact preview was cancelled.')
  const { BrowserWindow, net, session } = await import('electron')
  const partition = `duo-artifact-preview-${randomUUID()}`
  const previewSession = session.fromPartition(partition, { cache: false })
  const handler = createArtifactProtocolHandler(
    target.resourceRoot,
    (path) => net.fetch(pathToFileURL(path).toString()),
    allowSameOriginConnections ? { contentSecurityPolicy: QUALITY_PREVIEW_CSP } : undefined
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
    width,
    height,
    useContentSize: true,
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

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  previewWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message.slice(0, 500))
  })
  previewWindow.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame) pageErrors.push(errorDescription.slice(0, 500))
  })

  const rendererFailure = new Promise<never>((_resolve, reject) => {
    previewWindow.webContents.once('render-process-gone', () => reject(new Error('Artifact renderer exited.')))
    previewWindow.once('unresponsive', () => reject(new Error('Artifact renderer became unresponsive.')))
  })
  const entryUrl = `${ARTIFACT_PREVIEW_SCHEME}://${ARTIFACT_PREVIEW_HOST}/${encodeURIComponent(basename(target.entryPath))}`

  try {
    await withTimeout(withAbort(Promise.race([previewWindow.loadURL(entryUrl), rendererFailure]), abortSignal), LOAD_TIMEOUT_MS)
    await withAbort(new Promise((resolve) => setTimeout(resolve, SETTLE_TIME_MS)), abortSignal)
    const dom = inspectDom
      ? await withTimeout(withAbort(Promise.race([
          previewWindow.webContents.executeJavaScript(DOM_QUALITY_INSPECTION, true) as Promise<DomQualityEvidence>,
          rendererFailure
        ]), abortSignal), CAPTURE_TIMEOUT_MS)
      : undefined
    const image = await withTimeout(withAbort(Promise.race([
      previewWindow.webContents.capturePage(),
      rendererFailure
    ]), abortSignal), CAPTURE_TIMEOUT_MS)
    if (image.isEmpty()) throw new Error('Artifact preview was empty.')
    const size = image.getSize()
    return {
      imageDataUrl: image.toDataURL(),
      width: size.width,
      height: size.height,
      capturedAt: new Date().toISOString(),
      consoleErrors,
      pageErrors,
      ...(dom ? { dom } : {})
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

export const captureArtifactPixels: ArtifactPixelCapture = async (target) => {
  const captured = await capturePreviewViewport(target, PREVIEW_WIDTH, PREVIEW_HEIGHT)
  return {
    imageDataUrl: captured.imageDataUrl,
    width: captured.width,
    height: captured.height,
    capturedAt: captured.capturedAt
  }
}

export const captureArtifactQualityEvidence: SupervisorBrowserEvidencePort['capture'] = async (request) => {
  const target: ReadyArtifactPreviewTarget = {
    status: 'ready',
    entryPath: request.entryPath,
    resourceRoot: request.resourceRoot || dirname(request.entryPath)
  }
  const viewports: SupervisorBrowserViewportEvidence[] = []
  for (const viewport of ARTIFACT_QUALITY_VIEWPORTS) {
    const captured = await capturePreviewViewport(
      target,
      viewport.width,
      viewport.height,
      request.abortSignal,
      true,
      true
    )
    const dom = captured.dom
    if (!dom) throw new Error('Artifact browser quality evidence was incomplete.')
    viewports.push({
      id: viewport.id,
      width: captured.width,
      height: captured.height,
      screenshotCaptured: true,
      imageDataUrl: captured.imageDataUrl,
      visibleTextCharacters: dom.visibleTextCharacters,
      mainLandmark: dom.mainLandmark,
      horizontalOverflow: dom.horizontalOverflow,
      severeTextWrapCount: dom.severeTextWrapCount,
      interactiveElementCount: dom.interactiveElementCount,
      accessibleInteractiveElementCount: dom.accessibleInteractiveElementCount,
      interactionAttempted: dom.interactionAttempted,
      interactionSucceeded: dom.interactionSucceeded,
      interactionAttemptCount: dom.interactionAttemptCount,
      interactionSuccessCount: dom.interactionSuccessCount,
      interactionObservedChanges: dom.interactionObservedChanges,
      consoleErrors: captured.consoleErrors,
      pageErrors: captured.pageErrors
    })
  }
  return { viewports } satisfies SupervisorBrowserEvidence
}
