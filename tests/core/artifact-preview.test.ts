import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveArtifactResource } from '@main/preview/artifact-resource'
import { prepareArtifactPreviewTarget } from '@main/preview/artifact-preview-target'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('artifact preview resources', () => {
  test('resolves only GET and HEAD resources below the artifact root', async () => {
    const root = await temporaryDirectory('duo-preview-root-')
    const asset = join(root, 'assets', 'app.js')
    await mkdir(dirname(asset), { recursive: true })
    await writeFile(asset, 'console.log("preview")')

    await expect(resolveArtifactResource(root, 'duo-artifact://app/assets/app.js', 'GET')).resolves.toBe(asset)
    await expect(resolveArtifactResource(root, 'duo-artifact://app/assets/app.js', 'HEAD')).resolves.toBe(asset)
    await expect(resolveArtifactResource(root, 'duo-artifact://app/assets/app.js', 'POST')).rejects.toThrow(/method/i)
  })

  test('rejects malformed, foreign, and traversal requests', async () => {
    const root = await temporaryDirectory('duo-preview-root-')
    await writeFile(join(root, 'index.html'), '<!doctype html>')

    await expect(resolveArtifactResource(root, 'https://app/index.html', 'GET')).rejects.toThrow(/origin|protocol/i)
    await expect(resolveArtifactResource(root, 'duo-artifact://other/index.html', 'GET')).rejects.toThrow(/origin|host/i)
    await expect(resolveArtifactResource(root, 'duo-artifact://app/%E0%A4%A', 'GET')).rejects.toThrow(/path|encoding/i)
    await expect(resolveArtifactResource(root, 'duo-artifact://app/%2e%2e/%2e%2e/secret.txt', 'GET')).rejects.toThrow()
  })

  test('rejects a symlink that leaves the artifact root', async () => {
    const root = await temporaryDirectory('duo-preview-root-')
    const outside = await temporaryDirectory('duo-preview-outside-')
    await writeFile(join(outside, 'secret.txt'), 'not preview content')
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(resolveArtifactResource(root, 'duo-artifact://app/escape/secret.txt', 'GET')).rejects.toThrow(/outside|root/i)
  })
})

describe('artifact preview target preparation', () => {
  test('prepares a static HTML artifact without running a command', async () => {
    const workspace = await temporaryDirectory('duo-preview-workspace-')
    const entryPath = join(workspace, 'app', 'index.html')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, '<!doctype html>')

    await expect(prepareArtifactPreviewTarget(workspace, 'app')).resolves.toEqual({
      status: 'ready',
      entryPath,
      resourceRoot: dirname(entryPath)
    })
  })

  test('reports a dev-only package as unavailable instead of running its scripts', async () => {
    const workspace = await temporaryDirectory('duo-preview-workspace-')
    const app = join(workspace, 'app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.html'), '<script type="module" src="/src.ts"></script>')
    await writeFile(join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))

    await expect(prepareArtifactPreviewTarget(workspace, 'app')).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-built-artifact',
      message: 'No built browser artifact is available for preview.'
    })
  })

  test('prefers a built package artifact', async () => {
    const workspace = await temporaryDirectory('duo-preview-workspace-')
    const app = join(workspace, 'app')
    const entryPath = join(app, 'dist', 'index.html')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(join(app, 'index.html'), '<script type="module" src="/src.ts"></script>')
    await writeFile(join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    await writeFile(entryPath, '<!doctype html><h1>Built</h1>')

    await expect(prepareArtifactPreviewTarget(workspace, 'app')).resolves.toEqual({
      status: 'ready',
      entryPath,
      resourceRoot: dirname(entryPath)
    })
  })
})
