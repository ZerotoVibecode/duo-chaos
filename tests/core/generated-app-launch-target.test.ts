import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveGeneratedAppLaunchTarget } from '@main/generated-app-launch-target'

const temporaryDirectories: string[] = []

async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'duo-launch-target-'))
  temporaryDirectories.push(workspacePath)
  return workspacePath
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('resolveGeneratedAppLaunchTarget', () => {
  test('opens app/index.html when the configured target is the app directory', async () => {
    const workspacePath = await createWorkspace()
    const appDirectory = join(workspacePath, 'app')
    const indexPath = join(appDirectory, 'index.html')
    await mkdir(appDirectory)
    await writeFile(indexPath, '<!doctype html>')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, 'app')).resolves.toBe(indexPath)
  })

  test('preserves an explicit generated app file target', async () => {
    const workspacePath = await createWorkspace()
    const explicitTarget = join(workspacePath, 'app', 'launch.html')
    await mkdir(join(workspacePath, 'app'))
    await writeFile(explicitTarget, '<!doctype html>')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, explicitTarget)).resolves.toBe(explicitTarget)
  })

  test('normalizes portable backslash paths inside the generated workspace', async () => {
    const workspacePath = await createWorkspace()
    const explicitTarget = join(workspacePath, 'app', 'index.html')
    await mkdir(join(workspacePath, 'app'))
    await writeFile(explicitTarget, '<!doctype html>')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, 'app\\index.html')).resolves.toBe(explicitTarget)
  })

  test('rejects absolute and traversal targets outside the generated workspace', async () => {
    const workspacePath = await createWorkspace()
    const outsidePath = await createWorkspace()
    const outsideHtml = join(outsidePath, 'outside.html')
    await writeFile(outsideHtml, '<!doctype html>')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, outsideHtml)).rejects.toThrow(/outside/i)
    await expect(resolveGeneratedAppLaunchTarget(workspacePath, '..\\outside.html')).rejects.toThrow(/outside/i)
  })

  test('rejects executable files even when they are inside the workspace', async () => {
    const workspacePath = await createWorkspace()
    const executable = join(workspacePath, 'app.exe')
    await writeFile(executable, 'not really an executable')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, executable)).rejects.toThrow(/html|launch/i)
  })

  test('requires a built artifact when package scripts own the source index', async () => {
    const workspacePath = await createWorkspace()
    const appDirectory = join(workspacePath, 'app')
    await mkdir(appDirectory)
    await writeFile(join(appDirectory, 'index.html'), '<!doctype html><script type="module" src="/src.ts"></script>')
    await writeFile(join(appDirectory, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, 'app')).rejects.toThrow(/build|run command/i)
    await expect(resolveGeneratedAppLaunchTarget(workspacePath, join(appDirectory, 'index.html'))).rejects.toThrow(/build|run command/i)
  })

  test('prefers built HTML output over a package source index', async () => {
    const workspacePath = await createWorkspace()
    const appDirectory = join(workspacePath, 'app')
    const distDirectory = join(appDirectory, 'dist')
    await mkdir(distDirectory, { recursive: true })
    await writeFile(join(appDirectory, 'index.html'), '<!doctype html><script type="module" src="/src.ts"></script>')
    await writeFile(join(appDirectory, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    await writeFile(join(distDirectory, 'index.html'), '<!doctype html><h1>Built</h1>')

    await expect(resolveGeneratedAppLaunchTarget(workspacePath, 'app')).resolves.toBe(join(distDirectory, 'index.html'))
  })
})
