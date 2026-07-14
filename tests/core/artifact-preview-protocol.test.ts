import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ARTIFACT_QUALITY_VIEWPORTS,
  createArtifactProtocolHandler,
  DOM_QUALITY_INSPECTION
} from '@main/preview/electron-artifact-capture'

const temporaryDirectories: string[] = []

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'duo-preview-protocol-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('artifact preview protocol handler', () => {
  test('publishes deterministic compact and full-screen quality viewports', () => {
    expect(ARTIFACT_QUALITY_VIEWPORTS).toEqual([
      { id: 'compact', width: 900, height: 640 },
      { id: 'full', width: 1600, height: 900 }
    ])
  })

  test('serves a contained HTML response with a restrictive preview policy', async () => {
    const root = await artifactRoot()
    const index = join(root, 'index.html')
    await writeFile(index, '<!doctype html><h1>Artifact</h1>')
    const fetched: string[] = []
    const handler = createArtifactProtocolHandler(root, (path) => {
      fetched.push(path)
      return Promise.resolve(new Response('<!doctype html><h1>Artifact</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      }))
    })

    const response = await handler(new Request('duo-artifact://app/index.html'))

    expect(fetched).toEqual([index])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain("frame-src 'none'")
  })

  test('does not reveal filesystem details when a resource is rejected', async () => {
    const root = await artifactRoot()
    const handler = createArtifactProtocolHandler(root, () => Promise.reject(new Error('fetch should not run')))

    const response = await handler(new Request('duo-artifact://app/missing.html'))

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Artifact resource unavailable.')
    expect([...response.headers.keys()]).not.toContain('x-file-path')
  })

  test('rejects state-changing request methods', async () => {
    const root = await artifactRoot()
    await writeFile(join(root, 'index.html'), '<!doctype html>')
    const handler = createArtifactProtocolHandler(root, () => Promise.resolve(new Response('unexpected')))

    const response = await handler(new Request('duo-artifact://app/index.html', { method: 'POST' }))

    expect(response.status).toBe(405)
  })

  test('lets launch windows opt into same-origin fetches without weakening the default capture policy', async () => {
    const root = await artifactRoot()
    const index = join(root, 'index.html')
    await writeFile(index, '<!doctype html>')
    const handler = createArtifactProtocolHandler(
      root,
      (path) => Promise.resolve(new Response(path)),
      { contentSecurityPolicy: "default-src 'self'; connect-src 'self'" }
    )

    const response = await handler(new Request('duo-artifact://app/index.html'))

    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'; connect-src 'self'")
  })

  test('does not treat dispatching a click to a dead button as interaction proof', async () => {
    const dom = new JSDOM('<!doctype html><html><body><main><button type="button">Do nothing</button></main></body></html>', {
      runScripts: 'dangerously',
      url: 'https://artifact.test/'
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON: () => ({}) })
    })

    const evidence = await dom.window.eval(DOM_QUALITY_INSPECTION) as {
      interactionAttempted: boolean
      interactionSucceeded: boolean
      interactionObservedChanges: string[]
    }

    expect(evidence.interactionAttempted).toBe(true)
    expect(evidence.interactionSucceeded).toBe(false)
    expect(evidence.interactionObservedChanges).toEqual([])
  })

  test('accepts a safe generic interaction only when it causes an observable state change', async () => {
    const dom = new JSDOM('<!doctype html><html><body><main><button type="button" aria-pressed="false">Toggle</button></main><script>document.querySelector("button").addEventListener("click", (event) => event.currentTarget.setAttribute("aria-pressed", "true"))</script></body></html>', {
      runScripts: 'dangerously',
      url: 'https://artifact.test/'
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON: () => ({}) })
    })

    const evidence = await dom.window.eval(DOM_QUALITY_INSPECTION) as {
      interactionAttempted: boolean
      interactionSucceeded: boolean
      interactionObservedChanges: string[]
    }

    expect(evidence.interactionAttempted).toBe(true)
    expect(evidence.interactionSucceeded).toBe(true)
    expect(evidence.interactionObservedChanges).toContain('aria')
  })

  test('does not misattribute ambient DOM activity to a dead control', async () => {
    const dom = new JSDOM('<!doctype html><html><body><main data-pulse="0"><button type="button">Still dead</button></main><script>let pulse = 0; setInterval(() => document.querySelector("main").dataset.pulse = String(++pulse), 15)</script></body></html>', {
      runScripts: 'dangerously',
      url: 'https://artifact.test/'
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON: () => ({}) })
    })

    const evidence = await dom.window.eval(DOM_QUALITY_INSPECTION) as {
      interactionSucceeded: boolean
      interactionObservedChanges: string[]
    }
    dom.window.close()

    expect(evidence.interactionSucceeded).toBe(false)
    expect(evidence.interactionObservedChanges).toEqual([])
  })
})
