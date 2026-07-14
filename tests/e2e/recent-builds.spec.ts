import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedElectron } from './electron-fixture'

const ARCHIVE_CARD = (index: number): string => `
  <article class="recent-build-card recent-complete" data-archive-probe="${index}">
    <div class="recent-build-topline">
      <span class="recent-build-status">Complete</span>
      <time>Jul 11, 23:5${index}</time>
    </div>
    <div class="recent-build-title">
      <strong>Afterglow Atlas ${index}</strong>
      <span>Reveal unlocked</span>
    </div>
    <div class="recent-proof-row"><span>1 checkpoint</span><span>verified</span></div>
    <div class="recent-contribution" aria-label="Recorded agent contribution">
      <span><b>Claude</b> 6 turns · 4 edit events · 8 messages</span>
      <span><b>Codex</b> 6 turns · 5 edit events · 9 messages</span>
    </div>
    <div class="recent-build-actions">
      <button class="recent-recover recent-reveal" type="button">View reveal</button>
      <button class="recent-recover recent-open-app" type="button">Open app</button>
      <button class="recent-folder-action" type="button" aria-label="Open workspace">W</button>
    </div>
  </article>`

async function installArchiveProbe(page: Page): Promise<void> {
  await page.locator('.recent-builds').evaluate((panel, cards) => {
    panel.querySelector('.recent-build-empty')?.remove()
    panel.querySelector('.recent-build-list')?.remove()

    const list = document.createElement('div')
    list.className = 'recent-build-list'
    list.innerHTML = cards.join('')
    panel.append(list)
  }, Array.from({ length: 4 }, (_, index) => ARCHIVE_CARD(index + 1)))
}

async function expectArchiveCardsStayIntact(page: Page, compact: boolean): Promise<void> {
  const list = page.locator('.recent-build-list')
  const cards = page.locator('[data-archive-probe]')
  await expect(cards).toHaveCount(4)

  for (const card of await cards.all()) {
    await card.scrollIntoViewIfNeeded()
    const geometry = await card.evaluate((element) => {
      const contribution = element.querySelector<HTMLElement>('.recent-contribution')
      const cardRect = element.getBoundingClientRect()
      const contributionRect = contribution?.getBoundingClientRect()
      const listRect = element.parentElement?.getBoundingClientRect()
      return {
        cardClientHeight: element.clientHeight,
        cardScrollHeight: element.scrollHeight,
        cardOverflowY: getComputedStyle(element).overflowY,
        contributionDisplay: contribution ? getComputedStyle(contribution).display : 'missing',
        contributionInsideCard: Boolean(contributionRect && contributionRect.bottom <= cardRect.bottom + 1),
        contributionReachable: Boolean(listRect && contributionRect && contributionRect.top >= listRect.top - 1 && contributionRect.bottom <= listRect.bottom + 1),
        titleVisible: Boolean(element.querySelector<HTMLElement>('.recent-build-title strong')?.offsetParent),
        actionVisible: Boolean(element.querySelector<HTMLElement>('.recent-recover')?.offsetParent)
      }
    })

    expect.soft(geometry.contributionDisplay === 'none').toBe(compact)
    expect.soft(geometry.cardScrollHeight).toBeLessThanOrEqual(geometry.cardClientHeight + 1)
    expect.soft(geometry.cardOverflowY).not.toBe('hidden')
    expect.soft(geometry.titleVisible).toBe(true)
    expect.soft(geometry.actionVisible).toBe(true)
    if (!compact) {
      expect.soft(geometry.contributionInsideCard).toBe(true)
      expect.soft(geometry.contributionReachable).toBe(true)
    }
  }

  const listGeometry = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY
  }))
  expect(listGeometry.overflowY).toBe('auto')
  expect(listGeometry.scrollHeight).toBeGreaterThan(listGeometry.clientHeight)
}

test('keeps complete recent-build cards readable in compact and full-screen archives', async () => {
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()

  try {
    await page.setViewportSize({ width: 1000, height: 700 })
    await expect(page.getByRole('heading', { name: 'Recent builds' })).toBeVisible()
    await installArchiveProbe(page)
    await expectArchiveCardsStayIntact(page, true)

    await page.setViewportSize({ width: 2048, height: 1152 })
    await expectArchiveCardsStayIntact(page, false)
  } finally {
    await close()
  }
})
