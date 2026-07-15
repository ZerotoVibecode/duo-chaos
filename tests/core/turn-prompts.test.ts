import { describe, expect, it } from 'vitest'
import { composeTurnStagePrompt } from '../../src/main/orchestrator/turn-prompts'
import type { RealTurn } from '../../src/main/orchestrator/real-turn-plan'

const turn: RealTurn = {
  id: 'turn-05-claude-code',
  agent: 'claude',
  kind: 'code',
  phase: 'round.code',
  goal: 'Implement one distinct source-changing slice.'
}

const base = {
  runId: 'duo-run-stage-prompts',
  round: 5,
  turn,
  humanBrief: 'Build a sealed local app.',
  latestStatement: 'codex-r4-verdict: "I want a smaller testable core."',
  board: 'task-1: Build the public [FEATURE] [claimed; claude]',
  finalTurn: false
}

describe('turn stage prompts', () => {
  it('keeps serious product requirements binding while allowing solution debate', () => {
    const prompt = composeTurnStagePrompt({
      ...base,
      stage: 'dialogue',
      missionProfile: 'serious',
      turn: {
        id: 'turn-01-claude-pitch',
        agent: 'claude',
        kind: 'pitch',
        phase: 'round.pitch',
        goal: 'Open with a concrete direction.'
      }
    } as never)

    expect(prompt).toMatch(/serious mission|binding product brief/i)
    expect(prompt).toMatch(/do not replace|must not replace/i)
    expect(prompt).toMatch(/architecture|ux|implementation/i)
    expect(prompt).toMatch(/acceptance checks|acceptance criteria/i)
  })

  it('keeps surprise missions free to invent the product', () => {
    const prompt = composeTurnStagePrompt({ ...base, stage: 'dialogue', missionProfile: 'surprise' } as never)
    expect(prompt).toMatch(/mission profile[^\n]*surprise build/i)
    expect(prompt).toMatch(/invent|choose the product/i)
    expect(prompt).toMatch(/explicit.*(?:domain|audience|platform|usefulness).*binding/is)
    expect(prompt).not.toMatch(/human brief is a binding product brief/i)
  })

  it('uses full brief context for dialogue and an immutable compact baton after consensus', () => {
    const dialoguePrompt = composeTurnStagePrompt({
      ...base,
      stage: 'dialogue',
      qualityContract: 'QUALITY CONTRACT (private; binding)\n- Must serve content creators\n- Keyboard journey passes'
    })
    const sourcePrompt = composeTurnStagePrompt({
      ...base,
      stage: 'work',
      briefReference: 'Binding brief sealed at .duo/sealed/spec.md under fingerprint quality-123.',
      qualityBaton: 'SEALED QUALITY BATON\nFingerprint: quality-123\nconstraint-1 [REQUIRE] Must serve content creators'
    })

    expect(dialoguePrompt).toContain('HUMAN BRIEF')
    expect(dialoguePrompt).toContain(base.humanBrief)
    expect(dialoguePrompt).toContain('QUALITY CONTRACT (private; binding)')
    expect(sourcePrompt).toContain('SEALED BRIEF REFERENCE')
    expect(sourcePrompt).toContain('SEALED QUALITY BATON')
    expect(sourcePrompt).not.toContain(base.humanBrief)
    expect(sourcePrompt).not.toContain('QUALITY CONTRACT (private; binding)')
  })

  it('requires real public speech before a long source-writing lease begins', () => {
    const prompt = composeTurnStagePrompt({ ...base, stage: 'opening' })
    expect(prompt).toMatch(/^Stage:\s*opening/im)
    expect(prompt).toMatch(/before (?:any )?source work/i)
    expect(prompt).toMatch(/public\/dispatches\.jsonl/i)
    expect(prompt).toMatch(/public\/opinions\.jsonl/i)
    expect(prompt).toMatch(/reply.*latest statement/i)
  })

  it('keeps the selected-effort work lease focused on implementation and evidence', () => {
    const prompt = composeTurnStagePrompt({ ...base, stage: 'work' })
    expect(prompt).toMatch(/^Stage:\s*work/im)
    expect(prompt).toMatch(/implement|source-changing/i)
    expect(prompt).toMatch(/do not redo|do not reopen/i)
    expect(prompt).toMatch(/update.*board/i)
  })

  it('elevates a vague surprise brief inside one compact source contribution', () => {
    const prompt = composeTurnStagePrompt({
      ...base,
      humanBrief: 'Build me a good looking website.',
      stage: 'work',
      missionProfile: 'surprise',
      leanContribution: true
    })

    expect(prompt).toMatch(/distinctive, polished product/i)
    expect(prompt).toMatch(/signature interaction/i)
    expect(prompt).toMatch(/deliberate visual direction/i)
    expect(prompt).toMatch(/accessible controls/i)
    expect(prompt).toMatch(/batch.*reads|batch.*searches/i)
    expect(prompt).toMatch(/\.duo\/sealed\/idea\.md/i)
    expect(prompt).toMatch(/\.duo\/sealed\/spec\.md/i)
    expect(prompt).toMatch(/\.duo\/board\.json/i)
    expect(prompt).toMatch(/mark.*task.*done|explicitly blocked/i)
    expect(prompt).toMatch(/verification evidence/i)
    expect(prompt).toMatch(/reply-linked handoff/i)
    expect(prompt).toMatch(/cohesive contribution/i)
    expect(prompt).toMatch(/do not run git commands/i)
    expect(prompt).toMatch(/shell.*already starts.*workspace root/i)
    expect(prompt).toMatch(/never.*\bcd\b/i)
    expect(prompt).toMatch(/windows.*npm\.cmd.*npx\.cmd/i)
    expect(prompt).toMatch(/(?:denied|classifier).*do not retry.*(?:tool|command)|do not retry.*(?:denied|classifier).*(?:tool|command)/i)
    expect(prompt).toMatch(/record.*once.*(?:fallback|continue|finish)|record.*limitation.*once/i)
    expect(prompt).not.toMatch(/reveal_packet\.json/i)
  })

  it('elevates serious implementation without replacing the binding product', () => {
    const prompt = composeTurnStagePrompt({
      ...base,
      stage: 'work',
      missionProfile: 'serious',
      leanContribution: true
    })

    expect(prompt).toMatch(/sealed brief and acceptance checks are binding/i)
    expect(prompt).toMatch(/improve the solution without substituting a different product/i)
    expect(prompt).toMatch(/distinctive.*polished/i)
    expect(prompt).toMatch(/signature interaction/i)
    expect(prompt).toMatch(/deliberate visual direction/i)
    expect(prompt).toMatch(/accessible controls/i)
  })

  it('keeps Smart toolbelts selective and Broad toolbelts proactive without capability inventory', () => {
    const smart = composeTurnStagePrompt({
      ...base,
      stage: 'work',
      leanContribution: true,
      customizationProfile: 'smart'
    })
    const broad = composeTurnStagePrompt({
      ...base,
      stage: 'work',
      leanContribution: true,
      customizationProfile: 'full-local'
    })

    expect(smart).toMatch(/on demand.*reduce uncertainty|only when.*reduce uncertainty/is)
    expect(smart).not.toMatch(/proactively consider/i)
    expect(broad).toMatch(/proactively consider.*already-available.*(?:skill|plugin|mcp)/is)
    expect(broad).toMatch(/never inventory|do not inventory/i)
    expect(broad).toMatch(/never invoke subagents|do not.*subagents/i)
  })

  it('frames a structured capsule as one real turn instead of a synthetic three-message exchange', () => {
    const prompt = composeTurnStagePrompt({
      ...base,
      stage: 'dialogue',
      turn: {
        id: 'turn-02-codex-pitch',
        agent: 'codex',
        kind: 'pitch',
        phase: 'round.pitch',
        goal: 'Answer Claude directly and offer a concrete alternative.'
      },
      latestStatementId: 'dialogue-accepted-claude-opening'
    })

    expect(prompt).toMatch(/one real (?:agent )?statement|one substantive statement/i)
    expect(prompt).toMatch(/do not (?:simulate|invent).*(?:conversation|teammate|reply)/i)
    expect(prompt).toMatch(/opening.*first position/i)
    expect(prompt).toMatch(/counter.*reply/i)
    expect(prompt).toMatch(/verdict.*consensus/i)
  })

  it('gives consensus an immutable compact pitch catalog and requires exact source ids', () => {
    const prompt = composeTurnStagePrompt({
      ...base,
      stage: 'dialogue',
      turn: {
        id: 'turn-04-codex-consensus',
        agent: 'codex',
        kind: 'consensus',
        phase: 'round.consensus',
        goal: 'Seal one direction.'
      },
      pitchCatalog: [
        { pitchId: 'pitch-111111111111111111111111', agent: 'claude', title: 'Bloom Board' },
        { pitchId: 'pitch-222222222222222222222222', agent: 'codex', title: 'Focus Field' }
      ]
    })

    expect(prompt).toContain('IMMUTABLE PITCH CATALOG')
    expect(prompt).toContain('pitch-111111111111111111111111 | claude | Bloom Board')
    expect(prompt).toContain('pitch-222222222222222222222222 | codex | Focus Field')
    expect(prompt).toMatch(/sourcePitchIds.*exact.*(?:one or two|1-2)/is)
    expect(prompt).toMatch(/every task file boundary.*app\//isu)
  })

  it('makes verdict and recovery short contract-only handoffs', () => {
    const verdict = composeTurnStagePrompt({ ...base, stage: 'verdict' })
    const recovery = composeTurnStagePrompt({
      ...base,
      turn: {
        ...base.turn,
        kind: 'critique',
        phase: 'round.consensus'
      },
      stage: 'recovery',
      recoveryReasons: ['missing-dispatch', 'missing-opinion']
    })
    expect(verdict).toMatch(/^Stage:\s*verdict/im)
    expect(verdict).toMatch(/do not edit source|no source edits/i)
    expect(verdict).toMatch(/verdict|handoff/i)
    expect(recovery).toMatch(/^Stage:\s*recovery/im)
    expect(recovery).toMatch(/contract-only recovery/i)
    expect(recovery).toContain('missing-dispatch')
    expect(recovery).toMatch(/do not (?:inspect|edit).*app|no app inspection/i)
    expect(recovery).toMatch(/recovery capsule contract/i)
    expect(recovery).toMatch(/orchestrator.*persist/iu)
    expect(recovery).toMatch(/do not include.*(?:paths|commands|file operations)/iu)
  })

  it('makes a rejected quality consensus actionable during dialogue recovery', () => {
    const recovery = composeTurnStagePrompt({
      ...base,
      stage: 'recovery',
      recoveryOriginStage: 'dialogue',
      recoveryReasons: ['consensus-quality-contract', 'missing-dispatch', 'missing-opinion']
    })

    expect(recovery).toMatch(/failed the binding quality brief/iu)
    expect(recovery).toMatch(/rewrite.*consensus.*(?:idea|summary|spec)/isu)
    expect(recovery).toMatch(/visual direction/iu)
    expect(recovery).toMatch(/every binding (?:product )?requirement/iu)
  })

  it('gives the final verdict an explicit canonical reveal packet contract', () => {
    const prompt = composeTurnStagePrompt({ ...base, stage: 'verdict', finalTurn: true })
    for (const key of ['appName', 'idea', 'summary', 'features', 'runCommand', 'appPath', 'whatWorked', 'knownIssues', 'agentDramaSummary', 'gitCheckpoints', 'agentQuotes']) {
      expect(prompt).toContain(`"${key}"`)
    }
    expect(prompt).toContain('.duo/sealed/reveal_packet.json')
  })

  it('uses distinct recovery dispatch IDs for different failed stages in one round', () => {
    const openingRecovery = composeTurnStagePrompt({
      ...base,
      stage: 'recovery',
      recoveryOriginStage: 'opening',
      recoveryReasons: ['missing-dispatch']
    })
    const verdictRecovery = composeTurnStagePrompt({
      ...base,
      stage: 'recovery',
      recoveryOriginStage: 'verdict',
      recoveryReasons: ['missing-dispatch']
    })

    expect(openingRecovery).toMatch(/origin stage:\s*opening/iu)
    expect(verdictRecovery).toMatch(/origin stage:\s*verdict/iu)
    expect(openingRecovery).not.toBe(verdictRecovery)
  })
})
