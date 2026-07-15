import { describe, expect, it } from 'vitest'
import {
  buildQualityRepairTurns,
  buildRealTurnPlan,
  contributionNeedsFreshSource,
  decideQualityRepair
} from '../../src/main/orchestrator/real-turn-plan'

describe('real-mode turn plan', () => {
  it('gives both agents product debate and substantive source responsibility', () => {
    const plan = buildRealTurnPlan('run-1')
    const claudeKinds = plan.filter((turn) => turn.agent === 'claude').map((turn) => turn.kind)
    const codexKinds = plan.filter((turn) => turn.agent === 'codex').map((turn) => turn.kind)

    expect(claudeKinds).toEqual(expect.arrayContaining(['pitch', 'critique', 'code']))
    expect(codexKinds).toEqual(expect.arrayContaining(['pitch', 'critique', 'code']))
    expect(plan.filter((turn) => turn.kind === 'review')).toHaveLength(1)
  })

  it('lets the second pitcher resolve consensus only after both critique positions exist', () => {
    const plan = buildRealTurnPlan('run-consensus')
    expect(plan[3]).toMatchObject({ agent: 'codex', kind: 'critique', phase: 'round.consensus' })
  })

  it('alternates opening and closing authority across generated run ids', () => {
    const claudeFirst = buildRealTurnPlan('duo-run-a')
    const codexFirst = buildRealTurnPlan('duo-run-b')

    expect(claudeFirst[0]?.agent).toBe('claude')
    expect(claudeFirst[6]).toMatchObject({ agent: 'claude', revealCandidate: true })
    expect(codexFirst[0]?.agent).toBe('codex')
    expect(codexFirst[6]).toMatchObject({ agent: 'codex', revealCandidate: true })
  })

  it('never leaves one agent silent for two consecutive turns', () => {
    const plan = buildRealTurnPlan('run-strict-alternation')

    for (let index = 1; index < plan.length; index += 1) {
      expect(plan[index]?.agent, `turn ${String(index + 1)} should answer the other agent`).not.toBe(
        plan[index - 1]?.agent
      )
    }
  })

  it('uses four compact debates, two deep contributions, and one compact reciprocal review', () => {
    const plan = buildRealTurnPlan('run-fair-broadcast')
    const counts = plan.reduce(
      (result, turn) => ({ ...result, [turn.agent]: result[turn.agent] + 1 }),
      { claude: 0, codex: 0 }
    )

    expect(plan).toHaveLength(7)
    expect(Object.values(counts).sort()).toEqual([3, 4])
    expect(plan.map((turn) => turn.kind)).toEqual([
      'pitch', 'pitch', 'critique', 'critique', 'code', 'code', 'review'
    ])
  })

  it('uses configured repair loops as balanced Claude and Codex repair pairs', () => {
    const plan = buildRealTurnPlan('run-balanced-repairs', { maxTurns: 12, maxRepairLoops: 4 })
    const counts = plan.reduce(
      (result, turn) => ({ ...result, [turn.agent]: result[turn.agent] + 1 }),
      { claude: 0, codex: 0 }
    )

    expect(plan).toHaveLength(11)
    expect(plan.slice(7).map((turn) => `${turn.agent}:${turn.kind}`)).toEqual([
      'codex:repair',
      'claude:repair',
      'codex:repair',
      'claude:repair'
    ])
    expect(plan[6]).toMatchObject({ agent: 'claude', kind: 'review', revealCandidate: true })
    expect(Object.values(counts).sort()).toEqual([5, 6])
    expect(plan[7]?.goal).toMatch(/preserve Claude's accepted work/i)
    expect(plan[8]?.goal).toMatch(/answer Codex's repair/i)
  })

  it('never appends half a repair pair when the turn ceiling is odd', () => {
    const plan = buildRealTurnPlan('run-no-half-pair', { maxTurns: 11, maxRepairLoops: 4 })
    expect(plan).toHaveLength(11)
    expect(plan.at(-1)).toMatchObject({ agent: 'claude', kind: 'repair' })
  })

  it('lets the integrating contributor preserve a correct source tree when verification is the honest contribution', () => {
    expect(contributionNeedsFreshSource('code', false)).toBe(true)
    expect(contributionNeedsFreshSource('code', true)).toBe(false)
    expect(contributionNeedsFreshSource('review', true)).toBe(false)
    // A repair lease may legitimately prove the current revision is already
    // correct. Work evidence is still mandatory, but a performative source
    // edit is not.
    expect(contributionNeedsFreshSource('repair', true)).toBe(false)
  })

  it('reserves a fresh balanced repair and review pair without replaying prior turns', () => {
    const turns = buildQualityRepairTurns('duo-run-quality', 2, [
      'Claude accepted contribution',
      'Codex reply-linked cross-review'
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      id: 'quality-repair-02-claude-repair',
      agent: 'claude',
      kind: 'repair',
      phase: 'round.repair'
    })
    expect(turns[1]).toMatchObject({
      id: 'quality-repair-02-codex-review',
      agent: 'codex',
      kind: 'review',
      revealCandidate: true
    })
    expect(turns[0]?.goal).toContain('Claude accepted contribution')
    expect(turns[1]?.goal).toMatch(/current preserved revision/i)
  })

  it('does not demand performative source edits for exact-current review-only gaps', () => {
    const turns = buildQualityRepairTurns('duo-run-review-only-b', 1, [
      'Codex exact-current cross-review'
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      agent: 'codex',
      kind: 'review',
      phase: 'round.verify'
    })
    expect(turns[0]?.goal).toMatch(/no source edit is required or desired/i)
    expect(turns[0]?.goal).toMatch(/accepted or blocking verdict/i)
    expect(turns[1]?.goal).toMatch(/without changing correct source/i)
  })

  it('bounds paid quality repair and stops when a full pair produces no new evidence', () => {
    expect(decideQualityRepair({
      completedAttempts: 0,
      maximumAttempts: 4,
      previousMissingEvidence: [],
      currentMissingEvidence: ['Browser interaction proof', 'Codex current review']
    })).toEqual({ reservePair: true, reason: 'available' })

    expect(decideQualityRepair({
      completedAttempts: 1,
      maximumAttempts: 4,
      previousMissingEvidence: ['Codex current review', 'Browser interaction proof'],
      currentMissingEvidence: ['Browser interaction proof', 'Codex current review']
    })).toEqual({ reservePair: false, reason: 'no-evidence-progress' })

    expect(decideQualityRepair({
      completedAttempts: 4,
      maximumAttempts: 4,
      previousMissingEvidence: ['Browser interaction proof'],
      currentMissingEvidence: ['Fresh verification failure']
    })).toEqual({ reservePair: false, reason: 'attempt-limit' })
  })
})
