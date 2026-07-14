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
      expect(baton).toContain(constraint.sourceText)
    }
    expect(baton).toMatch(/\.duo\/sealed\/spec\.md/i)
    expect(baton).not.toMatch(/quality bar/i)
    expect(baton.length).toBeLessThan(full.length)
  })
})
