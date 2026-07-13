import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createArtifactProtocolHandler } from '@main/preview/electron-artifact-capture'

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
})
