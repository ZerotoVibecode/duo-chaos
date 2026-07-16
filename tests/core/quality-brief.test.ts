import { describe, expect, it } from 'vitest'
import {
  assessConsensusAgainstQualityBrief,
  compileQualityBrief,
  formatQualityBriefBatonForAgent,
  formatQualityBriefForAgent
} from '../../src/main/orchestrator/quality-brief'

describe('quality brief compiler', () => {
  it('preserves an explicit utility and audience request as binding private constraints', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a useful app for content creators. It must work locally and feel cinematic.',
      missionProfile: 'surprise'
    })

    expect(brief.privateContract.bindingBrief).toContain('useful app for content creators')
    expect(brief.privateContract.hardConstraints.map((constraint) => constraint.sourceText).join('\n')).toMatch(
      /useful app for content creators/i
    )
    expect(brief.privateContract.hardConstraints.map((constraint) => constraint.sourceText).join('\n')).toMatch(
      /work locally/i
    )
    expect(brief.privateContract.qualityBar).toEqual(expect.arrayContaining([
      expect.stringMatching(/distinctive|intentional/i),
      expect.stringMatching(/runnable|verified/i)
    ]))
    expect(brief.privateContract.acceptanceChecks.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the public projection generic and spoiler-safe', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build an offline invoice dashboard for documentary producers using CSV files.',
      missionProfile: 'serious'
    })
    const publicJson = JSON.stringify(brief.publicContract)

    expect(publicJson).not.toMatch(/invoice|documentary|producer|csv/i)
    expect(brief.publicContract.summary).toMatch(/quality contract/i)
    expect(brief.publicContract.hardConstraintCount).toBeGreaterThan(0)
  })

  it('rejects a consensus that silently replaces the requested audience and utility', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a useful app for content creators that works locally.',
      missionProfile: 'surprise'
    })

    const weak = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Museum of Almost',
      idea: 'A poetic gallery of abandoned ideas.',
      summary: 'Browse atmospheric fragments and ambient animations.',
      spec: 'Build a single-page art experiment with drifting cards.'
    })
    const aligned = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Cutlight',
      idea: 'A useful local planning board for content creators.',
      summary: 'Turn a creator brief into a cinematic shot plan.',
      spec: 'Store content projects locally, generate a shot list, and verify the complete creator workflow.'
    })

    expect(weak.valid).toBe(false)
    expect(weak.violations.join(' ')).toMatch(/human brief|constraint|content|creator|useful|local/i)
    expect(aligned).toMatchObject({ valid: true, violations: [] })
  })

  it('formats one compact private quality prompt without exposing a public copy', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Create an accessible offline CSV review tool for editors.',
      missionProfile: 'serious'
    })
    const prompt = formatQualityBriefForAgent(brief)

    expect(prompt).toMatch(/QUALITY CONTRACT/i)
    expect(prompt).toContain('accessible offline CSV review tool')
    expect(prompt).toMatch(/acceptance checks/i)
    expect(prompt.length).toBeLessThan(3_500)
  })

  it('never turns negation markers into prohibited coverage terms', () => {
    const brief = compileQualityBrief({
      humanBrief: "Build a useful local editor without a remote backend. Never use cloud storage. Avoid analytics and do not add user accounts. Don't add telemetry.",
      missionProfile: 'serious'
    })
    const restrictions = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')
    const markerTerms = new Set(['avoid', 'do', 'don', 'dont', 'must', 'never', 'no', 'not', 'without'])

    expect(restrictions.length).toBeGreaterThanOrEqual(3)
    expect(restrictions.flatMap((constraint) => constraint.coverageTerms)).not.toEqual(
      expect.arrayContaining([...markerTerms])
    )

    const compliant = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Cut',
      idea: 'A useful local editor that works without a remote backend.',
      summary: 'Editing stays local with no cloud storage, analytics, user accounts, or telemetry.',
      spec: 'Implement the editor locally. Avoid remote services and persist projects on-device.'
    })
    const violating = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Cloud Cut',
      idea: 'A useful local editor backed by a remote backend.',
      summary: 'Cloud storage, analytics, telemetry, and user accounts synchronize every edit.',
      spec: 'Implement the editor with hosted services and account-based telemetry.'
    })

    expect(compliant).toMatchObject({ valid: true, violations: [] })
    expect(violating.valid).toBe(false)
  })

  it('separates positive requirements from the undesired states they forbid', () => {
    const brief = compileQualityBrief({
      humanBrief: [
        'Fit cleanly at 900x640 and 1600x900 without clipped primary controls or page-level horizontal overflow.',
        'Run fully locally with no backend, account, analytics, remote fonts, or runtime network dependency.'
      ].join(' '),
      missionProfile: 'serious'
    })
    const required = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'require')
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')

    expect(required.map((constraint) => constraint.sourceText).join(' ')).toMatch(/fit cleanly.*run fully locally/is)
    expect(forbidden.map((constraint) => constraint.sourceText).join(' ')).toMatch(/without clipped.*no backend/is)
    expect(forbidden.flatMap((constraint) => constraint.coverageTerms)).not.toEqual(
      expect.arrayContaining(['primary', 'control', 'pagelevel'])
    )

    const compliant = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Signal Garden',
      idea: 'A local-first task garden.',
      summary: 'The responsive product works at 900x640 and 1600x900.',
      spec: 'Fit cleanly at both target sizes with no clipped controls or horizontal overflow. It uses an overflow chip inside the garden, while the page remains local-first with no backend, account, analytics, remote fonts, or runtime network dependency.'
    })
    const violating = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Signal Garden Cloud',
      idea: 'A remote task garden with a hosted backend.',
      summary: 'Analytics and user accounts synchronize state.',
      spec: 'The primary controls are clipped at 900x640 and the page has horizontal overflow.'
    })

    expect(compliant).toMatchObject({ valid: true, violations: [] })
    expect(violating.valid).toBe(false)
  })

  it('treats working without a network connection as a required offline capability', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a polished dependency-free single-page Decision Deck. A user enters three to seven options, compares two options at a time, and finishes with a ranked list. Preserve progress in localStorage, support mouse and keyboard input, include an obvious reset path, work without a network connection, and include deterministic tests for the ranking logic. The interface must remain readable at 900 by 640 and 1600 by 900.',
      missionProfile: 'serious'
    })
    const required = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'require')
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')
    const prompt = formatQualityBriefForAgent(brief)

    expect(required.map((constraint) => constraint.sourceText).join(' ')).toMatch(/work offline/i)
    expect(required.map((constraint) => constraint.sourceText)).not.toContain('work')
    expect(forbidden.map((constraint) => constraint.sourceText).join(' ')).not.toMatch(/network connection/i)
    expect(prompt).toMatch(/\[REQUIRE\].*work offline/i)
    expect(prompt).not.toMatch(/\[FORBID\].*network connection/i)
    expect(prompt).not.toMatch(/\[FORBID\]\s+(?:without|no|never|avoid|do not)\b/i)
  })

  it('rejects a substitute that drops offline operation and deterministic verification from the benchmark brief', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a polished dependency-free single-page Decision Deck. A user enters three to seven options, compares two options at a time, and finishes with a ranked list. Preserve progress in localStorage, support mouse and keyboard input, include an obvious reset path, work without a network connection, and include deterministic tests for the ranking logic. The interface must remain readable at 900 by 640 and 1600 by 900.',
      missionProfile: 'serious'
    })
    const weak = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Decision Deck',
      idea: 'A hosted pairwise choice service.',
      summary: 'Compare options with mouse and keyboard controls, save progress, and reset a ranked list.',
      spec: 'Use a remote service to synchronize the comparison flow and provide responsive controls at the target desktop sizes.'
    })

    expect(brief.privateContract.hardConstraints.map((constraint) => constraint.sourceText)).toEqual(
      expect.arrayContaining([expect.stringMatching(/work offline/i), expect.stringMatching(/deterministic tests/i)])
    )
    expect(weak.valid).toBe(false)
    expect(weak.violations.length).toBeGreaterThanOrEqual(2)
  })

  it('does not count an explicitly negated deterministic-test requirement as satisfied', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a polished dependency-free single-page Decision Deck. A user enters three to seven options, compares two options at a time, and finishes with a ranked list. Preserve progress in localStorage, support mouse and keyboard input, include an obvious reset path, work without a network connection, and include deterministic tests for the ranking logic. The interface must remain readable at 900 by 640 and 1600 by 900.',
      missionProfile: 'serious'
    })
    const base = {
      appName: 'Decision Deck',
      idea: 'A polished dependency-free single-page Decision Deck.',
      summary: 'A user enters three to seven options, compares two options at a time, and finishes with a ranked list.',
      spec: 'Preserve progress in localStorage. Support mouse and keyboard input. Include an obvious reset path. Work offline. The interface remains readable at 900 by 640 and 1600 by 900.'
    }
    const testConstraint = brief.privateContract.hardConstraints.find((constraint) =>
      /deterministic tests/i.test(constraint.sourceText)
    )
    const rejected = assessConsensusAgainstQualityBrief(brief, {
      ...base,
      spec: `${base.spec} Do not include deterministic tests for the ranking logic.`
    })
    const accepted = assessConsensusAgainstQualityBrief(brief, {
      ...base,
      spec: `${base.spec} Include deterministic tests for the ranking logic.`
    })

    expect(testConstraint).toBeDefined()
    expect(rejected.valid).toBe(false)
    expect(rejected.violations).toContain(`Consensus does not preserve human-brief constraint ${testConstraint!.id}.`)
    expect(accepted.valid).toBe(true)
  })

  it.each([
    ['does not use analytics', 'analytics', ['analytic']],
    ['cannot use remote fonts', 'remote fonts', ['remote', 'font']],
    ['lacks telemetry', 'telemetry', ['telemetry']],
    ['omits user accounts', 'user accounts', ['user', 'account']]
  ])('normalizes an extended restriction without keeping its negation verb: %s', (restriction, prohibited, expectedTerms) => {
    const brief = compileQualityBrief({
      humanBrief: `Build a local tool that ${restriction}.`,
      missionProfile: 'serious'
    })
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')
    const violating = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Tool',
      idea: `A local tool that uses ${prohibited}.`,
      summary: `${prohibited} is enabled.`,
      spec: `Implement ${prohibited} in the product.`
    })
    const prompt = formatQualityBriefForAgent(brief)

    expect(forbidden.map((constraint) => constraint.coverageTerms).flat()).toEqual(
      expect.arrayContaining(expectedTerms)
    )
    expect(prompt).not.toMatch(/\[FORBID\]\s+(?:cannot|does not|lacks|omits)\b/i)
    expect(violating.valid).toBe(false)
  })

  it('keeps the affirmative half of a mixed compliant sentence', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a local tool that must work offline and does not use analytics.',
      missionProfile: 'serious'
    })
    const compliant = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Tool',
      idea: 'A useful local tool.',
      summary: 'It works offline and does not use analytics.',
      spec: 'All product behavior remains local.'
    })
    const violating = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Tool',
      idea: 'A useful local tool.',
      summary: 'It works offline and uses analytics.',
      spec: 'Analytics is enabled in the otherwise local product.'
    })

    expect(compliant).toMatchObject({ valid: true, violations: [] })
    expect(violating.valid).toBe(false)
  })

  it.each([
    ['work without a network connection and without analytics', /analytics/i],
    ['work without a network connection or remote fonts', /remote fonts/i],
    ['work without a network connection, remote fonts, or analytics', /remote fonts.*analytics/i],
    ['work without a network connection, analytics, and telemetry', /analytics.*telemetry/i],
    ['work without a network connection nor analytics', /analytics/i],
    ['work without a network connection as well as analytics', /analytics/i]
  ])('keeps an offline requirement separate from a compound prohibition: %s', (clause, forbiddenPhrase) => {
    const brief = compileQualityBrief({
      humanBrief: `Build a local decision tool that must ${clause}.`,
      missionProfile: 'serious'
    })
    const required = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'require')
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')
    const prompt = formatQualityBriefForAgent(brief)

    expect(required.map((constraint) => constraint.sourceText).join(' ')).toMatch(/work offline/i)
    expect(forbidden.map((constraint) => constraint.sourceText).join(' ')).toMatch(forbiddenPhrase)
    expect(prompt).not.toMatch(/\[FORBID\].*work offline/i)
    expect(prompt).not.toMatch(/\[FORBID\]\s+(?:without|no|never|avoid|do not)\b/i)
  })

  it.each([
    'work without a network connection and with keyboard navigation',
    'work without a network connection and be keyboard accessible',
    'work without a network connection and allow keyboard input',
    'work without a network connection and offer keyboard input',
    'work without a network connection and enable keyboard input',
    'work without a network connection and remain keyboard accessible',
    'work without a network connection and display a status',
    'work without a network connection and persist progress locally'
  ])('never inverts a positive capability after an offline requirement: %s', (clause) => {
    const brief = compileQualityBrief({
      humanBrief: `Build a local decision tool that must ${clause}.`,
      missionProfile: 'serious'
    })
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')
    const aligned = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Choice',
      idea: 'A local offline decision tool with accessible keyboard input.',
      summary: 'Keyboard navigation works throughout the offline experience.',
      spec: `The product must ${clause.replace(/work without a network connection/iu, 'work offline')}.`
    })

    expect(forbidden.map((constraint) => constraint.sourceText).join(' ')).not.toMatch(/keyboard/i)
    expect(formatQualityBriefForAgent(brief)).not.toMatch(/\[FORBID\].*keyboard/i)
    expect(aligned.valid).toBe(true)
  })

  it.each([
    'generate a report',
    'export JSON',
    'save progress',
    'analytics'
  ])('preserves an unknown sibling after an offline requirement instead of dropping or forbidding it: %s', (capability) => {
    const brief = compileQualityBrief({
      humanBrief: `Build a local decision tool that must work without a network connection and ${capability}.`,
      missionProfile: 'serious'
    })
    const required = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'require')
    const forbidden = brief.privateContract.hardConstraints.filter((constraint) => constraint.polarity === 'forbid')

    expect(required.map((constraint) => constraint.sourceText).join(' ')).toMatch(new RegExp(capability, 'i'))
    expect(forbidden.map((constraint) => constraint.sourceText).join(' ')).not.toMatch(new RegExp(capability, 'i'))
  })

  it('matches prohibited morphology inside one affirmative clause without combining unrelated clauses', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a local design tool. Avoid remote fonts.',
      missionProfile: 'serious'
    })
    const compliant = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Local Studio',
      idea: 'A local design tool with bundled typography.',
      summary: 'Remote sync is optional. The font is bundled locally.',
      spec: 'Keep all design work local and load bundled type assets.'
    })
    const violating = assessConsensusAgainstQualityBrief(brief, {
      appName: 'Remote Studio',
      idea: 'A local design tool whose typography comes from a hosted service.',
      summary: 'A remote font loads at runtime.',
      spec: 'Fetch the font before rendering the editor.'
    })

    expect(compliant).toMatchObject({ valid: true, violations: [] })
    expect(violating.valid).toBe(false)
  })

  it.each([
    'Debate a compact direction without spending Max effort on routine dialogue.',
    'Let the final reviewer preserve a correct build without inventing an edit.',
    'Pause honestly if the exact preserved source cannot be verified.'
  ])('does not turn a process-only orchestration instruction into a product contract: %s', (humanBrief) => {
    const brief = compileQualityBrief({ humanBrief, missionProfile: 'surprise' })

    expect(brief.privateContract.hardConstraints).toEqual([])
    expect(brief.privateContract.qualityBar.length).toBeGreaterThan(0)
    expect(brief.privateContract.acceptanceChecks.length).toBeGreaterThan(0)
  })

  it('continues binding an ordinary product request after process-only filtering', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Build a useful local decision dashboard for documentary editors.',
      missionProfile: 'serious'
    })

    expect(brief.privateContract.hardConstraints.length).toBeGreaterThan(0)
    expect(brief.privateContract.hardConstraints.map((constraint) => constraint.sourceText).join(' ')).toMatch(
      /local decision dashboard/i
    )
  })

  it('formats an immutable post-consensus baton without repaying the full quality prompt', () => {
    const brief = compileQualityBrief({
      humanBrief: 'Create an accessible offline CSV review tool for documentary editors without analytics.',
      missionProfile: 'serious'
    })
    const full = formatQualityBriefForAgent(brief)
    const baton = formatQualityBriefBatonForAgent(brief)

    expect(baton).toMatch(/sealed quality baton/i)
    expect(baton).toContain(brief.fingerprint)
    for (const constraint of brief.privateContract.hardConstraints) {
      expect(baton).toContain(constraint.id)
      if (constraint.polarity === 'forbid') {
        expect(baton).toContain(constraint.coverageTerms[0]!)
      } else {
        expect(baton).toContain(constraint.sourceText)
      }
    }
    expect(baton).toMatch(/\.duo\/sealed\/spec\.md/i)
    expect(baton).not.toMatch(/quality bar/i)
    expect(baton.length).toBeLessThan(full.length)
  })
})
