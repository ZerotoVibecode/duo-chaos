import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ArtifactPreviewResult } from '../../src/shared/types'
import { launchIsolatedElectron } from './electron-fixture'

test('captures generated pixels in the isolated artifact session', async () => {
  test.setTimeout(60_000)
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()

  try {
    await page.getByRole('button', { name: 'Start simulation' }).click()
    await expect(page.getByRole('heading', { name: 'Live rivalry' })).toBeVisible({ timeout: 8_000 })
    const workspacePath = await page.evaluate(async () => {
      const data = await window.duo.getBootstrap()
      const run = data.runs.find((candidate) => candidate.status === 'running')
      if (!run) throw new Error('Simulation run was not found.')
      return run.workspacePath
    })
    const reveal = page.getByRole('button', { name: 'Reveal app' })
    await expect(reveal).toBeEnabled({ timeout: 35_000 })
    await reveal.click()
    await expect(page.getByRole('heading', { name: 'Afterglow Atlas' })).toBeVisible()

    const preview = await page.evaluate(async (): Promise<ArtifactPreviewResult> => {
      const data = await window.duo.getBootstrap()
      const run = data.runs.find((candidate) => candidate.status === 'complete')
      if (!run) throw new Error('Revealed run was not found.')
      return window.duo.getArtifactPreview(run.runId)
    })

    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') throw new Error(preview.message)
    expect(preview.imageDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(preview.imageDataUrl.length).toBeGreaterThan(1_000)
    expect(preview.width).toBe(1280)
    expect(preview.height).toBe(720)
    expect(JSON.stringify(preview)).not.toContain(workspacePath)

    // A built Vite app commonly emits root-relative /assets URLs. Replacing the
    // finished simulation artifact here proves the launch path does not fall
    // back to file://, where that asset URL would resolve outside the app.
    await mkdir(join(workspacePath, 'app', 'assets'), { recursive: true })
    await writeFile(join(workspacePath, 'app', 'data.json'), JSON.stringify({ message: 'local-json-ok' }))
    await writeFile(join(workspacePath, 'app', 'assets', 'artifact.js'), `
      Promise.all([
        fetch('/data.json').then((response) => response.json()),
        fetch('https://example.com/blocked').then(
          () => 'unexpected-success',
          () => 'blocked'
        )
      ]).then(([local, external]) => {
        document.body.dataset.bundleLoaded = 'true'
        document.body.dataset.localFetch = local.message
        document.body.dataset.externalFetch = external
        document.querySelector('main').textContent = 'Artifact bundle rendered'
      })
    `)
    await writeFile(join(workspacePath, 'app', 'index.html'), `<!doctype html>
      <html><head><style>html,body{margin:0;width:100%;height:100%;background:#07111d;color:#fff}main{display:grid;place-items:center;height:100%;font:700 64px system-ui}</style></head>
      <body><main>Artifact shell rendered</main><script src="/assets/artifact.js"></script><script>fetch('https://example.com/blocked').catch(() => undefined); window.open('https://example.com/blocked')</script></body></html>`)

    const launchedWindow = electronApp.waitForEvent('window')
    await page.getByRole('button', { name: 'Launch Afterglow Atlas' }).click()
    const artifactPage = await launchedWindow
    await expect(artifactPage.getByText('Artifact bundle rendered')).toBeVisible()
    await expect(artifactPage.locator('body')).toHaveAttribute('data-bundle-loaded', 'true')
    await expect(artifactPage.locator('body')).toHaveAttribute('data-local-fetch', 'local-json-ok')
    await expect(artifactPage.locator('body')).toHaveAttribute('data-external-fetch', 'blocked')
    expect(artifactPage.url()).toMatch(/^duo-artifact:\/\/app\/index\.html$/)

    const security = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => (
        candidate.webContents.getURL().startsWith('duo-artifact://app/')
      ))
      const preferences = window
        ? (window.webContents as unknown as { getLastWebPreferences: () => {
            sandbox?: boolean
            contextIsolation?: boolean
            nodeIntegration?: boolean
            webSecurity?: boolean
          } }).getLastWebPreferences()
        : undefined
      return {
        count: BrowserWindow.getAllWindows().length,
        sandbox: preferences?.sandbox,
        contextIsolation: preferences?.contextIsolation,
        nodeIntegration: preferences?.nodeIntegration,
        webSecurity: preferences?.webSecurity,
        devToolsOpened: window?.webContents.isDevToolsOpened()
      }
    })
    expect(security).toMatchObject({
      count: 2,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devToolsOpened: false
    })

    const applicationClosed = electronApp.waitForEvent('close')
    await page.getByRole('button', { name: 'Close window' }).click().catch((error: unknown) => {
      // Electron may tear down the Playwright target before click() receives
      // its acknowledgement. That is the expected outcome of this action.
      if (!page.isClosed()) throw error
    })
    await expect.poll(() => artifactPage.isClosed()).toBe(true)
    await applicationClosed
  } finally {
    await close()
  }
})
