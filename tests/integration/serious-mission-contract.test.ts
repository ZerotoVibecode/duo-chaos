import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeSeriousAgentSpecification,
  sealSeriousMissionGuard,
  sealSeriousMissionSpecification,
  seriousBriefFingerprint,
  validateSeriousMissionContract,
  writeSeriousMissionContract,
  writeSeriousMissionGuard
} from '../../src/main/workspace/serious-mission-contract'

describe('serious mission contract', () => {
  it('seals the exact human brief and binds it into the implementation specification', async () => {
    const sealedPath = await mkdtemp(join(tmpdir(), 'duo-serious-contract-'))
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-serious-runtime-'))
    const brief = 'Build an accessible invoice dashboard with CSV import and an offline-first review queue.'
    await writeSeriousMissionContract(sealedPath, brief, '2026-07-12T00:00:00.000Z')
    const guardPath = await writeSeriousMissionGuard(runtimePath, brief, '2026-07-12T00:00:00.000Z')
    const plan = `Implement the requested accessible invoice dashboard as a local-first review queue. Parse CSV input deterministically, persist the offline state, and expose keyboard-safe invoice actions.\n\nAcceptance checks\n- Import a valid CSV while the app remains offline.\n- Review every invoice action using only the keyboard.`
    await sealSeriousMissionSpecification(sealedPath, brief, plan)
    await sealSeriousMissionGuard(runtimePath, sealedPath, brief, '2026-07-12T00:01:00.000Z')

    const contract = JSON.parse(await readFile(join(sealedPath, 'serious_contract.json'), 'utf8')) as Record<string, unknown>
    expect(contract).toMatchObject({
      version: 1,
      missionProfile: 'serious',
      brief,
      briefFingerprint: seriousBriefFingerprint(brief)
    })
    await expect(readFile(join(sealedPath, 'human_brief.md'), 'utf8')).resolves.toContain(brief)
    await expect(validateSeriousMissionContract(sealedPath, brief, guardPath)).resolves.toBe(true)

    const forgedPlan = `Replace the original implementation plan while repeating enough requested terms to look plausible. This simulates a workspace agent rewriting both the specification and its colocated contract after consensus.\n\nAcceptance checks\n- Import a different CSV invoice path while offline.\n- Review the rewritten invoice queue using the keyboard.`
    await sealSeriousMissionSpecification(sealedPath, brief, forgedPlan)
    await expect(validateSeriousMissionContract(sealedPath, brief, guardPath)).resolves.toBe(false)
  })

  it('rejects copied brief text without a substantive acceptance plan', () => {
    const brief = 'Build an accessible invoice dashboard with offline CSV review.'
    expect(analyzeSeriousAgentSpecification(brief, 'Acceptance checks\n- It works.').valid).toBe(false)
    expect(analyzeSeriousAgentSpecification(brief, `Write something unrelated in enough words to appear substantial but never address invoice review or CSV input. This deliberately avoids the requested product terms and offers no testable criteria.\n\nAcceptance checks\n- Show a decorative landing screen after startup.\n- Keep a generic button visible on the page.`).valid).toBe(false)
  })

  it('accepts a clearly labeled acceptance list even when the heading follows the plan inline', () => {
    const brief = 'Build an accessible invoice dashboard with offline CSV review.'
    const plan = `Implement the requested accessible invoice dashboard as a local-first review queue. Parse CSV input deterministically, persist offline state, and expose keyboard-safe invoice actions. Acceptance checks:\n- Import a valid CSV while the app remains offline.\n- Review every invoice action using only the keyboard.`
    const analysis = analyzeSeriousAgentSpecification(brief, plan)

    expect(analysis.valid).toBe(true)
    expect(analysis.acceptanceChecks.some((check) => /valid CSV/i.test(check))).toBe(true)
    expect(analysis.acceptanceChecks.some((check) => /keyboard/i.test(check))).toBe(true)
  })

  it('accepts schema-produced inline bullets after an explicit acceptance heading', () => {
    const brief = 'Build an accessible task garden with offline JSON import and keyboard controls.'
    const plan = `Implement a polished local-first task garden with deterministic task plants, validated JSON import, offline persistence, visible keyboard focus, and accessible controls. Acceptance checks: - Import valid JSON while offline and show a clear error for malformed JSON. - Add and complete a task using only the keyboard with visible focus.`
    const analysis = analyzeSeriousAgentSpecification(brief, plan)

    expect(analysis.valid).toBe(true)
    expect(analysis.acceptanceChecks).toHaveLength(2)
    expect(analysis.acceptanceChecks[0]).toMatch(/valid JSON while offline/iu)
    expect(analysis.acceptanceChecks[1]).toMatch(/only the keyboard/iu)
  })

  it('does not treat negated or example prose as the binding acceptance heading', () => {
    const brief = 'Build an accessible invoice dashboard with offline CSV review.'
    const bullets = '- Import a valid CSV while the app remains offline.\n- Review every invoice action using only the keyboard.'

    expect(analyzeSeriousAgentSpecification(
      brief,
      `This proposal explains the dashboard in enough detail to exceed the length boundary, but explicitly has no acceptance checks:\n${bullets}`
    ).valid).toBe(false)
    expect(analyzeSeriousAgentSpecification(
      brief,
      `This proposal explains a hypothetical dashboard and shows non-binding copy for illustration. Example acceptance checks:\n${bullets}`
    ).valid).toBe(false)
  })

  it('rejects a missing or altered binding chain', async () => {
    const sealedPath = await mkdtemp(join(tmpdir(), 'duo-serious-contract-tamper-'))
    const brief = 'Build the requested serious product without changing its purpose.'
    await writeSeriousMissionContract(sealedPath, brief, '2026-07-12T00:00:00.000Z')
    await writeFile(join(sealedPath, 'spec.md'), '# Unrelated product\n', 'utf8')

    await expect(validateSeriousMissionContract(sealedPath, brief)).resolves.toBe(false)
    await expect(validateSeriousMissionContract(sealedPath, `${brief} Extra requirement.`)).resolves.toBe(false)
  })

  it('seals a short serious brief whose stop-word-only wording has no coverage terms', async () => {
    const sealedPath = await mkdtemp(join(tmpdir(), 'duo-serious-short-contract-'))
    const runtimePath = await mkdtemp(join(tmpdir(), 'duo-serious-short-runtime-'))
    const brief = 'Build an app.'
    const plan = `Create a compact local product with a clear start state, one primary action, durable in-memory behavior, readable feedback, and a deterministic completion state that can be checked without any network access.

Acceptance checks
- Launch the finished product directly from its documented entry point.
- Complete the primary interaction twice with the same deterministic result.`
    expect(analyzeSeriousAgentSpecification(brief, plan)).toMatchObject({
      valid: true,
      requiredBriefTermCount: 0,
      coveredBriefTerms: []
    })
    await writeSeriousMissionContract(sealedPath, brief)
    const guardPath = await writeSeriousMissionGuard(runtimePath, brief)
    await sealSeriousMissionSpecification(sealedPath, brief, plan)
    await expect(sealSeriousMissionGuard(runtimePath, sealedPath, brief)).resolves.toBe(guardPath)
    await expect(validateSeriousMissionContract(sealedPath, brief, guardPath)).resolves.toBe(true)
  })
})
