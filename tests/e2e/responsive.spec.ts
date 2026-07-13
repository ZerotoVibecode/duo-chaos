import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedElectron } from './electron-fixture'

async function expectMinimumFontSize(page: Page, selector: string, minimum: number): Promise<void> {
  const target = page.locator(selector).first()
  await expect(target, `${selector} should be visible`).toBeVisible()
  const pixels = await target.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(pixels, `${selector} rendered at ${pixels}px`).toBeGreaterThanOrEqual(minimum)
}

const LONG_OPINION = [
  'Consensus holds only if the chosen [FEATURE] preserves one readable interaction, a visible completion state, keyboard access, and a contained scope.',
  'The rival proposal still has to prove that its extra motion and supporting systems improve the experience instead of hiding a fragile core.',
  'Evidence should decide this argument: run the verification pass, compare the result, and keep the stronger approach even if it means conceding the earlier position.',
  'unbroken-layout-probe-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
].join(' ')

async function expectOpinionBodyNotClipped(body: Locator): Promise<void> {
  await expect(body, 'opinion body should exist before measuring its geometry').toBeVisible()
  const card = body.locator('xpath=..')
  await body.evaluate((element, replacement) => {
    element.textContent = replacement
  }, LONG_OPINION)
  await card.scrollIntoViewIfNeeded()

  const metrics = await body.evaluate((element) => {
    const style = getComputedStyle(element)
    const card = element.closest<HTMLElement>('.opinion-card')
    const bodyRect = element.getBoundingClientRect()
    const cardRect = card?.getBoundingClientRect()

    return {
      bodyClientHeight: element.clientHeight,
      bodyScrollHeight: element.scrollHeight,
      bodyClientWidth: element.clientWidth,
      bodyScrollWidth: element.scrollWidth,
      bodyOverflowX: style.overflowX,
      bodyOverflowY: style.overflowY,
      lineClamp: style.webkitLineClamp,
      cardClientHeight: card?.clientHeight ?? 0,
      cardScrollHeight: card?.scrollHeight ?? 0,
      cardOverflowY: card ? getComputedStyle(card).overflowY : 'missing',
      bodyInsideCard: !cardRect || bodyRect.bottom <= cardRect.bottom + 1,
      cardTop: cardRect?.top ?? Number.NaN,
      cardBottom: cardRect?.bottom ?? Number.NaN,
      viewportHeight: window.innerHeight
    }
  })

  expect.soft(
    metrics.bodyScrollHeight,
    `opinion body is vertically clipped (${metrics.bodyScrollHeight}px content inside ${metrics.bodyClientHeight}px)`
  ).toBeLessThanOrEqual(metrics.bodyClientHeight + 1)
  expect.soft(
    metrics.bodyScrollWidth,
    `opinion body is horizontally clipped (${metrics.bodyScrollWidth}px content inside ${metrics.bodyClientWidth}px)`
  ).toBeLessThanOrEqual(metrics.bodyClientWidth + 1)
  expect.soft(['none', '0', 'unset', '']).toContain(metrics.lineClamp)
  expect.soft(metrics.bodyOverflowX).not.toBe('hidden')
  expect.soft(metrics.bodyOverflowY).not.toBe('hidden')
  expect.soft(metrics.cardScrollHeight).toBeLessThanOrEqual(metrics.cardClientHeight + 1)
  expect.soft(metrics.cardOverflowY).not.toBe('hidden')
  expect.soft(metrics.bodyInsideCard).toBe(true)
  expect.soft(metrics.cardTop).toBeGreaterThanOrEqual(-1)
  expect.soft(metrics.cardBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1)
}

async function expectBattleBriefingNotClipped(page: Page): Promise<void> {
  const metrics = await page.locator('.battle-briefing').evaluate((element) => {
    const ceiling = element.querySelector<HTMLElement>('.briefing-contract em')
    const briefingRect = element.getBoundingClientRect()
    const ceilingRect = ceiling?.getBoundingClientRect()

    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      ceilingInside: !ceilingRect || ceilingRect.right <= briefingRect.right + 1
    }
  })

  expect(metrics.scrollWidth, 'battle briefing should not overflow horizontally').toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.clientHeight, 'battle briefing should keep its readable height').toBeGreaterThanOrEqual(44)
  expect(metrics.scrollHeight, 'battle briefing should not clip vertically').toBeLessThanOrEqual(metrics.clientHeight + 1)
  expect(metrics.ceilingInside, 'run ceiling should stay inside the battle briefing').toBe(true)
}

test('fits the complete cockpit when windowed and fills a large display', async () => {
  test.setTimeout(75_000)
  const screenshots = join(process.cwd(), 'test-results', 'visual')
  await mkdir(screenshots, { recursive: true })
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()

  try {
    await page.setViewportSize({ width: 1000, height: 700 })
    await expect(page.getByRole('heading', { name: 'Start the blind build.' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Agent loadout' })).toBeVisible()
    const codexModel = page.getByLabel('Codex model')
    const claudeModel = page.getByLabel('Claude model')
    await expect(codexModel).toBeVisible()
    await expect(claudeModel).toBeVisible()
    await expect(codexModel.locator('option[value=""]')).toHaveText('CLI default')
    await expect(codexModel.locator('option[value="gpt-5.6-sol"]')).toContainText('Sol')
    await expect(codexModel.locator('option[value="gpt-5.6-terra"]')).toContainText('Terra')
    await expect(claudeModel.locator('option[value=""]')).toHaveText('CLI default')
    await expect(claudeModel.locator('option[value="fable"]')).toHaveText('Fable')
    await expect(claudeModel.locator('option[value="opus"]')).toHaveText('Opus')
    await expect(claudeModel.locator('option[value="sonnet"]')).toHaveText('Sonnet')
    await expect(page.getByRole('button', { name: /clean capture/i })).toHaveCount(0)
    await codexModel.selectOption('gpt-5.6-terra')
    await claudeModel.selectOption('sonnet')
    await expect(codexModel).toHaveValue('gpt-5.6-terra')
    await expect(claudeModel).toHaveValue('sonnet')
    await codexModel.selectOption('')
    await claudeModel.selectOption('')
    await expectMinimumFontSize(page, '.hero-copy p', 12)
    await expectMinimumFontSize(page, '.prompt-field textarea', 13)
    await expectMinimumFontSize(page, '.mode-card strong', 11)
    await expectMinimumFontSize(page, '.mode-card small', 10)
    await expectMinimumFontSize(page, '.loadout-agent-identity strong', 12)
    await expectMinimumFontSize(page, '.loadout-agent-identity small', 10)
    await expectMinimumFontSize(page, '.loadout-field > span', 10)
    await expectMinimumFontSize(page, '.loadout-field select', 11)
    await expectMinimumFontSize(page, '.loadout-effective', 10)
    await expectBattleBriefingNotClipped(page)
    const clippedRuntimeProfiles = await page.locator('.loadout-effective strong').evaluateAll((profiles) => profiles.filter((profile) => (
      profile.scrollHeight > profile.clientHeight + 1 || profile.scrollWidth > profile.clientWidth + 1
    )).length)
    expect(clippedRuntimeProfiles).toBe(0)
    await expectMinimumFontSize(page, '.system-check strong', 10)
    await expectMinimumFontSize(page, '.readiness-note span', 10)
    await expectMinimumFontSize(page, '.sequence-rail strong', 11)
    await expect(page.getByRole('button', { name: 'Start simulation' })).toBeVisible()
    const cockpitFit = await page.locator('.prompt-cockpit').evaluate((element) => {
      const cockpit = element.getBoundingClientRect()
      const action = element.querySelector<HTMLElement>('.launch-actions')?.getBoundingClientRect()
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        actionInside: Boolean(action && action.top >= cockpit.top - 1 && action.bottom <= cockpit.bottom + 1)
      }
    })
    expect(cockpitFit.scrollHeight).toBeLessThanOrEqual(cockpitFit.clientHeight + 1)
    expect(cockpitFit.actionInside).toBe(true)

    await page.getByRole('button', { name: 'Open settings' }).click()
    await expectMinimumFontSize(page, '.settings-content h3', 13)
    await expectMinimumFontSize(page, '.settings-help', 11)
    await expectMinimumFontSize(page, '.settings-field span', 10)
    await expectMinimumFontSize(page, '.settings-field input', 11)
    await expectMinimumFontSize(page, '.settings-warning', 11)
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(screenshots, '08-windowed-settings.png') })
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page.screenshot({ path: join(screenshots, '04-windowed-launch.png') })
    const compact = await page.evaluate(() => {
      const shell = document.querySelector('.launch-shell')?.getBoundingClientRect()
      const sequence = document.querySelector('.sequence-rail')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        pageHeight: document.documentElement.scrollHeight,
        shell: shell ? { width: shell.width, height: shell.height, bottom: shell.bottom } : null,
        sequence: sequence ? { width: sequence.width, height: sequence.height, bottom: sequence.bottom } : null
      }
    })
    expect(compact.pageWidth).toBeLessThanOrEqual(compact.viewportWidth + 1)
    expect(compact.pageHeight).toBeLessThanOrEqual(compact.viewportHeight + 2)
    expect(compact.sequence?.bottom).toBeLessThanOrEqual(compact.viewportHeight)

    await page.setViewportSize({ width: 2048, height: 1152 })
    const wide = await page.evaluate(() => {
      const shell = document.querySelector('.launch-shell')?.getBoundingClientRect()
      const grid = document.querySelector('.launch-grid')?.getBoundingClientRect()
      const loadout = document.querySelector('.agent-loadout-panel')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        shell: shell ? { width: shell.width, height: shell.height } : null,
        grid: grid ? { width: grid.width, height: grid.height } : null,
        loadout: loadout ? { width: loadout.width, height: loadout.height } : null
      }
    })
    expect(wide.shell?.width ?? 0).toBeGreaterThan(wide.viewportWidth * 0.92)
    expect(wide.grid?.height ?? 0).toBeGreaterThan((wide.viewportHeight - 46) * 0.72)
    expect(wide.loadout?.height ?? Number.POSITIVE_INFINITY).toBeLessThan((wide.grid?.height ?? 0) * 0.72)
    await expectBattleBriefingNotClipped(page)
    await page.screenshot({ path: join(screenshots, '05-fullscreen-launch.png') })

    await page.setViewportSize({ width: 1000, height: 700 })
    await page.getByRole('button', { name: 'Start simulation' }).click()
    await expect(page.getByRole('heading', { name: 'Live rivalry' })).toBeVisible({ timeout: 8_000 })
    await expect(page.getByRole('heading', { name: 'Evidence momentum' })).toBeVisible()
    await expect(page.locator('.opinion-card').first()).toBeVisible({ timeout: 10_000 })
    await expectMinimumFontSize(page, '.pulse-progress > div', 10)
    await expectMinimumFontSize(page, '.agent-state', 10)
    await expectMinimumFontSize(page, '.agent-runtime', 10)
    await expectMinimumFontSize(page, '.agent-metrics span', 10)
    await expectMinimumFontSize(page, '.agent-metrics strong', 11)
    await expectMinimumFontSize(page, '.agent-stance > span', 10)
    await expectMinimumFontSize(page, '.agent-stance p', 12)
    await expectMinimumFontSize(page, '.opinion-agent', 10)
    await expectMinimumFontSize(page, '.opinion-target', 10)
    await expectMinimumFontSize(page, '.tone-pill', 10)
    await expectMinimumFontSize(page, '.opinion-card > p', 12)
    await expectMinimumFontSize(page, '.opinion-data', 10)
    await expectMinimumFontSize(page, '.terminal-toggle > span', 11)
    await expectOpinionBodyNotClipped(page.locator('.opinion-card > p').first())
    await page.getByRole('button', { name: 'Logs' }).click()
    await expectMinimumFontSize(page, '.terminal-pane > div', 10)
    await expectMinimumFontSize(page, '.terminal-pane > div strong', 10)
    await expectMinimumFontSize(page, '.terminal-pane pre', 11)
    const evidenceFit = await page.locator('.evidence-momentum').evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(evidenceFit.scrollHeight).toBeLessThanOrEqual(evidenceFit.clientHeight + 1)
    expect(evidenceFit.scrollWidth).toBeLessThanOrEqual(evidenceFit.clientWidth + 1)
    const compactDashboard = await page.evaluate(() => {
      const shell = document.querySelector('.run-shell')?.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-deck')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
        shell: shell ? { width: shell.width, height: shell.height, bottom: shell.bottom } : null,
        terminal: terminal ? { width: terminal.width, height: terminal.height, bottom: terminal.bottom } : null
      }
    })
    expect(compactDashboard.shell?.width ?? 0).toBeGreaterThan(compactDashboard.viewportWidth * 0.92)
    expect(compactDashboard.pageHeight).toBeLessThanOrEqual(compactDashboard.viewportHeight + 2)
    expect(compactDashboard.terminal?.bottom ?? 0).toBeGreaterThan(compactDashboard.viewportHeight * 0.88)
    await page.screenshot({ path: join(screenshots, '06-windowed-run.png') })

    await page.getByRole('button', { name: 'Logs' }).click()
    await page.setViewportSize({ width: 2048, height: 1152 })
    const wideDashboard = await page.evaluate(() => {
      const shell = document.querySelector('.run-shell')?.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-deck')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
        shell: shell ? { width: shell.width, height: shell.height, bottom: shell.bottom } : null,
        terminal: terminal ? { width: terminal.width, height: terminal.height, bottom: terminal.bottom } : null
      }
    })
    expect(wideDashboard.shell?.width ?? 0).toBeGreaterThan(wideDashboard.viewportWidth * 0.92)
    expect(wideDashboard.pageHeight).toBeLessThanOrEqual(wideDashboard.viewportHeight + 2)
    expect(wideDashboard.terminal?.bottom ?? 0).toBeGreaterThan(wideDashboard.viewportHeight * 0.88)
    await expectOpinionBodyNotClipped(page.locator('.opinion-card > p').first())
    await page.screenshot({ path: join(screenshots, '07-fullscreen-run.png') })

    const reveal = page.getByRole('button', { name: 'Reveal app' })
    await expect(reveal).toBeEnabled({ timeout: 30_000 })
    await reveal.click()

    await page.setViewportSize({ width: 1000, height: 700 })
    await expect(page.getByRole('region', { name: 'Artifact premiere' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Launch Afterglow Atlas' })).toBeVisible()
    await expect(page.locator('.artifact-preview img')).toBeVisible({ timeout: 15_000 })
    const compactReveal = await page.evaluate(() => {
      const stage = document.querySelector('.reveal-stage')?.getBoundingClientRect()
      const premiere = document.querySelector('.artifact-premiere')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        stageWidth: stage?.width ?? 0,
        premiereBottom: premiere?.bottom ?? Number.POSITIVE_INFINITY
      }
    })
    expect(compactReveal.pageWidth).toBeLessThanOrEqual(compactReveal.viewportWidth + 1)
    expect(compactReveal.stageWidth).toBeGreaterThan(compactReveal.viewportWidth * 0.93)
    expect(compactReveal.premiereBottom).toBeLessThanOrEqual(700)
    await page.screenshot({ path: join(screenshots, '09-windowed-reveal.png') })

    await page.setViewportSize({ width: 2048, height: 1152 })
    const wideReveal = await page.evaluate(() => {
      const stage = document.querySelector('.reveal-stage')?.getBoundingClientRect()
      const premiere = document.querySelector('.artifact-premiere')?.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        stageWidth: stage?.width ?? 0,
        premiereHeight: premiere?.height ?? 0
      }
    })
    expect(wideReveal.stageWidth).toBeGreaterThan(wideReveal.viewportWidth * 0.78)
    expect(wideReveal.premiereHeight).toBeGreaterThan(430)
    await page.screenshot({ path: join(screenshots, '10-fullscreen-reveal.png') })
  } finally {
    await close()
  }
})
