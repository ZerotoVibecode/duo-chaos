import { writeFile } from 'node:fs/promises'
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
    await writeFile(join(workspacePath, 'app', 'index.html'), `<!doctype html>
      <html><head><style>html,body{margin:0;width:100%;height:100%;background:#07111d;color:#fff}main{display:grid;place-items:center;height:100%;font:700 64px system-ui}</style></head>
      <body><main>Artifact rendered</main><script>fetch('https://example.com/blocked').catch(() => undefined); window.open('https://example.com/blocked')</script></body></html>`)

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
  } finally {
    await close()
  }
})
