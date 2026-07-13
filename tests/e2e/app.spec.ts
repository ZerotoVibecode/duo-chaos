import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedElectron } from './electron-fixture'

async function expectMinimumFontSize(page: Page, selector: string, minimum: number): Promise<void> {
  const target = page.locator(selector).first()
  await expect(target, `${selector} should be visible`).toBeVisible()
  const pixels = await target.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(pixels, `${selector} rendered at ${pixels}px`).toBeGreaterThanOrEqual(minimum)
}

test('launches a full Simulation Mode run through the reveal', async () => {
  test.setTimeout(50_000)
  const screenshots = join(process.cwd(), 'test-results', 'visual')
  await mkdir(screenshots, { recursive: true })
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()
  await page.setViewportSize({ width: 1440, height: 920 })
  await page.screenshot({ path: join(screenshots, '00-boot.png'), fullPage: true })

  await expect(page.getByRole('heading', { name: 'Start the blind build.' })).toBeVisible()
  await page.screenshot({ path: join(screenshots, '01-launch.png'), fullPage: true })

  await page.getByRole('button', { name: 'Start simulation' }).click()
  await expect(page.getByRole('heading', { name: 'Live rivalry' })).toBeVisible({ timeout: 8_000 })
  await expect(page.getByRole('heading', { name: 'Evidence momentum' })).toBeVisible()
  await expect(page.getByText(/Claude thinks Codex/i).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Atmosphere vs buildability' })).toBeVisible({ timeout: 12_000 })
  const missionBoard = page.getByRole('region', { name: 'Mission board' })
  await expect(missionBoard.getByText('Spoiler-sealed shared task')).toHaveCount(2, { timeout: 12_000 })
  await expect(page.getByText('Shape the first-run atmosphere')).toHaveCount(0)
  await expectMinimumFontSize(page, '.exchange-rail li > span', 10)
  await expectMinimumFontSize(page, '.broadcast-beat h2', 16)
  await expectMinimumFontSize(page, '.broadcast-beat p', 12)
  await expectMinimumFontSize(page, '.broadcast-context p', 10)
  await expectMinimumFontSize(page, '.task-card strong', 11)
  await expectMinimumFontSize(page, '.owner', 10)
  await expectMinimumFontSize(page, '.risk', 10)
  await page.screenshot({ path: join(screenshots, '02-run.png'), fullPage: true })

  const reveal = page.getByRole('button', { name: 'Reveal app' })
  await expect(reveal).toBeEnabled({ timeout: 28_000 })
  await expect(page.getByRole('heading', { name: 'The build survived' })).toBeVisible()
  await expect(page.getByText('2/2 tasks complete')).toBeVisible()
  await expectMinimumFontSize(page, '.completion-core h1', 32)
  await expectMinimumFontSize(page, '.completion-proof span', 11)
  await page.screenshot({ path: join(screenshots, '02-complete.png'), fullPage: true })
  await reveal.click()
  await expect(page.getByRole('heading', { name: 'Afterglow Atlas' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Artifact premiere' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Launch Afterglow Atlas' })).toBeVisible()
  await expect(page.getByText('Verified artifact')).toBeVisible()
  await expect(page.locator('.artifact-preview img')).toBeVisible({ timeout: 15_000 })
  expect(await page.locator('.artifact-preview img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('region', { name: "Director's cut" })).toBeVisible()
  await expect(page.getByRole('button', { name: /watch director's cut/i })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Battle receipt' })).toHaveCount(0)
  await page.getByRole('button', { name: /watch director's cut/i }).click()
  await expect(page.getByRole('button', { name: /pause director's cut|replay director's cut/i })).toBeVisible()
  const clippedReplayLabels = await page.locator('.battle-replay-rail button span').evaluateAll((labels) => labels.filter((label) => (
    label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1
  )).length)
  expect(clippedReplayLabels).toBe(0)
  await expectMinimumFontSize(page, '.reveal-kicker', 10)
  await expectMinimumFontSize(page, '.reveal-summary', 13)
  await expectMinimumFontSize(page, '.artifact-status strong', 15)
  await expectMinimumFontSize(page, '.artifact-proof-list span', 11)
  await expectMinimumFontSize(page, '.artifact-launch', 12)
  await expectMinimumFontSize(page, '.reveal-story-grid li', 12)
  await expectMinimumFontSize(page, '.after-action-exchange blockquote', 14)
  await expectMinimumFontSize(page, '.text-button', 11)
  await page.waitForTimeout(1_000)
  await page.screenshot({ path: join(screenshots, '03-reveal.png'), fullPage: true })
  await page.getByRole('button', { name: /open technical proof/i }).click()
  await expect(page.getByRole('region', { name: 'Battle receipt' })).toBeVisible()
  await page.getByRole('region', { name: 'Battle receipt' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, '03b-reveal-details.png') })

  await close()
})

test('stops a live build and returns to the editable prompt', async () => {
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()
  try {
    await page.setViewportSize({ width: 1200, height: 760 })
    await page.getByRole('button', { name: 'Start simulation' }).click()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled({ timeout: 8_000 })
    await page.getByRole('button', { name: 'Stop' }).click()
    const confirmation = page.getByRole('alertdialog', { name: /cancel this battle permanently/i })
    await expect(confirmation).toContainText(/cannot be resumed/i)
    await confirmation.getByRole('button', { name: /cancel battle permanently/i }).click()
    await expect(page.getByText('Build stopped safely.')).toBeVisible()
    await page.getByRole('button', { name: 'Back to prompt' }).click()
    await expect(page.getByRole('heading', { name: 'Start the blind build.' })).toBeVisible()
    await expect(page.getByLabel('Opening prompt')).toHaveValue(/Create a surprising local app/)
  } finally {
    await close()
  }
})
