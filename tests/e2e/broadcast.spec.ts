import { expect, test } from '@playwright/test'
import { launchIsolatedElectron } from './electron-fixture'

type BeatSample = {
  id: string
  provenance: string
  agent: string
  kind: string
  label: string
  headline: string
  body: string
}

test('keeps Simulation Mode moving like a truthful live broadcast', async () => {
  test.setTimeout(55_000)
  const { electronApp, close } = await launchIsolatedElectron()
  const page = await electronApp.firstWindow()

  try {
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.getByRole('button', { name: 'Start simulation' }).click()

    const stage = page.getByRole('region', { name: 'Broadcast stage' })
    await expect(stage, 'the broadcast stage should appear as soon as the run begins').toBeVisible({ timeout: 8_000 })
    const beat = stage.getByTestId('broadcast-beat')
    await expect(beat, 'the stage should always contain a current broadcast beat').toBeVisible({ timeout: 2_000 })

    const samples: Array<BeatSample & { observedAt: number }> = []
    const provenances = new Set<string>()
    const agentVoices = new Set<string>()
    const kinds = new Set<string>()
    const signatures = new Set<string>()
    let lastId = ''
    let lastChangeAt = Date.now()
    let longestGapMs = 0
    const deadline = Date.now() + 25_000

    while (Date.now() < deadline) {
      const sample = await beat.evaluate((element): BeatSample => ({
        id: element.getAttribute('data-beat-id') ?? '',
        provenance: element.getAttribute('data-provenance') ?? '',
        agent: element.getAttribute('data-agent') ?? '',
        kind: element.getAttribute('data-beat-kind') ?? '',
        label: element.querySelector('[data-testid="beat-provenance"]')?.textContent?.trim() ?? '',
        headline: element.querySelector('[data-testid="beat-headline"]')?.textContent?.trim() ?? '',
        body: element.querySelector('[data-testid="beat-body"]')?.textContent?.trim() ?? ''
      }))

      if (sample.id && sample.id !== lastId) {
        const observedAt = Date.now()
        longestGapMs = Math.max(longestGapMs, observedAt - lastChangeAt)
        lastChangeAt = observedAt
        lastId = sample.id
        samples.push({ ...sample, observedAt })
        provenances.add(sample.provenance)
        kinds.add(sample.kind)
        signatures.add(`${sample.provenance}|${sample.headline}|${sample.body}`)

        if (sample.provenance === 'agent') {
          expect(['claude', 'codex']).toContain(sample.agent)
          expect(sample.label).toBe('AGENT QUOTE')
          agentVoices.add(sample.agent)
        } else if (sample.provenance === 'director') {
          expect(sample.label).toBe('DIRECTOR')
          expect(['claude', 'codex']).not.toContain(sample.agent)
        } else if (sample.provenance === 'evidence') {
          expect(sample.label).toBe('LIVE EVIDENCE')
          expect(['claude', 'codex']).not.toContain(sample.agent)
        }

        expect(sample.headline.length).toBeGreaterThan(0)
        expect(sample.body.length).toBeGreaterThan(0)
      }

      const completeArc =
        samples.length >= 6 &&
        provenances.has('agent') &&
        provenances.has('director') &&
        provenances.has('evidence') &&
        agentVoices.has('claude') &&
        agentVoices.has('codex') &&
        kinds.size >= 4
      if (completeArc) break

      await page.waitForTimeout(250)
    }

    longestGapMs = Math.max(longestGapMs, Date.now() - lastChangeAt)
    expect(samples.length, 'the stage should present at least six beats during the simulation').toBeGreaterThanOrEqual(6)
    expect(signatures.size, 'beat identifiers must correspond to materially different presentation').toBeGreaterThanOrEqual(6)
    expect([...provenances]).toEqual(expect.arrayContaining(['agent', 'director', 'evidence']))
    expect([...agentVoices]).toEqual(expect.arrayContaining(['claude', 'codex']))
    expect(kinds.size, 'the simulation should move through multiple broadcast scenes').toBeGreaterThanOrEqual(4)
    expect(longestGapMs, `the stage went visually silent for ${String(longestGapMs)}ms`).toBeLessThanOrEqual(6_000)

    let identicalRun = 1
    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]
      const previous = samples[index - 1]
      const currentSignature = `${current?.provenance}|${current?.headline}|${current?.body}`
      const previousSignature = `${previous?.provenance}|${previous?.headline}|${previous?.body}`
      identicalRun = currentSignature === previousSignature ? identicalRun + 1 : 1
      expect(identicalRun, 'the broadcast should not replay the same beat three times in succession').toBeLessThanOrEqual(2)
    }
  } finally {
    await close()
  }
})
