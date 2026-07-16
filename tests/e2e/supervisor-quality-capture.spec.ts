import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

interface CapturedQualityEvidence {
  viewports: Array<{
    id: 'compact' | 'full'
    width: number
    height: number
    pointerInteractionAttempted: boolean
    pointerInteractionSucceeded: boolean
    keyboardInteractionAttempted: boolean
    keyboardInteractionSucceeded: boolean
    keyboardObservedChanges: string[]
    externalNetworkRequestCount: number
  }>
}

async function captureQualityEvidence(html: string): Promise<CapturedQualityEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'duo-chaos-quality-capture-'))
  const artifactRoot = join(root, 'artifact')
  const entryPath = join(artifactRoot, 'index.html')
  const outputPath = join(root, 'quality-evidence.json')
  const userData = join(root, 'user-data')

  await mkdir(artifactRoot, { recursive: true })
  await writeFile(entryPath, html)

  let electronApp: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    electronApp = await electron.launch({
      args: [join(process.cwd(), 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        DUO_CHAOS_E2E: '1',
        DUO_CHAOS_E2E_USER_DATA: userData,
        DUO_CHAOS_E2E_QUALITY_ENTRY: entryPath,
        DUO_CHAOS_E2E_QUALITY_ROOT: artifactRoot,
        DUO_CHAOS_E2E_QUALITY_OUTPUT: outputPath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    })

    await electronApp.waitForEvent('close', { timeout: 20_000 })
    const payload = JSON.parse(await readFile(outputPath, 'utf8')) as CapturedQualityEvidence | { error: string }
    if ('error' in payload) throw new Error(payload.error)
    return payload
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

test('captures reset trusted pointer, keyboard, and blocked external-network evidence', async () => {
  const evidence = await captureQualityEvidence(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Trusted input fixture</title>
  </head>
  <body>
    <main>
      <label for="ideas">Ideas</label>
      <textarea id="ideas"></textarea>
      <button data-testid="start" type="button">Start</button>
      <button data-testid="choose-left" type="button">Choose left</button>
      <output id="result" aria-live="polite">Waiting</output>
    </main>
    <script>
      const result = document.querySelector('#result')
      let pointerCount = 0
      let keyboardCount = 0
      document.querySelector('[data-testid="start"]').addEventListener('click', () => {
        pointerCount += 1
        result.dataset.state = 'pointer-' + pointerCount
        result.textContent = 'Pointer accepted ' + pointerCount
        document.querySelectorAll('button').forEach((button) => { button.disabled = true })
      })
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight') return
        keyboardCount += 1
        result.dataset.state = 'keyboard-' + keyboardCount
        result.textContent = 'Keyboard accepted ' + keyboardCount
      })
      fetch('https://example.invalid/duo-chaos-e2e-probe').catch(() => undefined)
    </script>
  </body>
</html>`)

  expect(evidence.viewports.map((viewport) => viewport.id)).toEqual(['compact', 'full'])
  for (const viewport of evidence.viewports) {
    expect(viewport.width).toBe(viewport.id === 'compact' ? 900 : 1600)
    expect(viewport.height).toBe(viewport.id === 'compact' ? 640 : 900)
    expect(viewport.pointerInteractionAttempted).toBe(true)
    expect(viewport.pointerInteractionSucceeded).toBe(true)
    expect(viewport.keyboardInteractionAttempted).toBe(true)
    expect(viewport.keyboardInteractionSucceeded).toBe(true)
    expect(viewport.keyboardObservedChanges).not.toEqual([])
    expect(viewport.externalNetworkRequestCount).toBeGreaterThan(0)
  }
})

test('does not mistake a native control value change for app keyboard behavior', async () => {
  const evidence = await captureQualityEvidence(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Native input only fixture</title>
  </head>
  <body>
    <main>
      <label for="choice">Choice</label>
      <select id="choice">
        <option>First</option>
        <option>Second</option>
      </select>
    </main>
  </body>
</html>`)

  for (const viewport of evidence.viewports) {
    expect(viewport.keyboardInteractionAttempted).toBe(true)
    expect(viewport.keyboardInteractionSucceeded).toBe(false)
    expect(viewport.keyboardObservedChanges).toEqual([])
  }
})
