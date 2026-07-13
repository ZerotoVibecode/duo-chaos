import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createArtifactPreview, type ArtifactPixelCapture } from '@main/preview/artifact-preview'

const temporaryDirectories: string[] = []

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'duo-preview-capture-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('artifact preview capture policy', () => {
  test('returns pixels from a contained static artifact', async () => {
    const root = await workspace()
    const entryPath = join(root, 'app', 'index.html')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, '<!doctype html><h1>Safe preview</h1>')
    const capturedTargets: string[] = []
    const capture: ArtifactPixelCapture = (target) => {
      capturedTargets.push(target.entryPath)
      return Promise.resolve({
        imageDataUrl: 'data:image/png;base64,cHJldmlldw==',
        width: 1280,
        height: 720,
        capturedAt: '2026-07-11T12:00:00.000Z'
      })
    }

    await expect(createArtifactPreview({ workspacePath: root, configuredTarget: 'app' }, capture)).resolves.toEqual({
      status: 'ready',
      imageDataUrl: 'data:image/png;base64,cHJldmlldw==',
      width: 1280,
      height: 720,
      capturedAt: '2026-07-11T12:00:00.000Z'
    })
    expect(capturedTargets).toEqual([entryPath])
  })

  test('does not invoke capture for a dev-only package', async () => {
    const root = await workspace()
    const app = join(root, 'app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.html'), '<script type="module" src="/src.ts"></script>')
    await writeFile(join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    let captureCalls = 0
    const capture: ArtifactPixelCapture = () => {
      captureCalls += 1
      return Promise.reject(new Error('must not run'))
    }

    await expect(createArtifactPreview({ workspacePath: root, configuredTarget: 'app' }, capture)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-built-artifact',
      message: 'No built browser artifact is available for preview.'
    })
    expect(captureCalls).toBe(0)
  })

  test('does not expose internal capture failures', async () => {
    const root = await workspace()
    const entryPath = join(root, 'app', 'index.html')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, '<!doctype html>')
    const capture: ArtifactPixelCapture = () => Promise.reject(new Error('private path C:\\Users\\someone\\secret.txt'))

    const result = await createArtifactPreview({ workspacePath: root, configuredTarget: 'app' }, capture)

    expect(result).toEqual({
      status: 'failed',
      reason: 'capture-failed',
      message: 'The generated artifact could not be rendered safely.'
    })
    expect(JSON.stringify(result)).not.toContain('Users')
  })
})
