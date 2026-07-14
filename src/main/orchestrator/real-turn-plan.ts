import type { AgentId, RunPhase } from '@shared/types'

export type RealTurnKind = 'pitch' | 'critique' | 'consensus' | 'tasking' | 'code' | 'review' | 'verify' | 'repair'

export interface RealTurn {
  id: string
  agent: Extract<AgentId, 'claude' | 'codex'>
  kind: RealTurnKind
  phase: RunPhase
  goal: string
  revealCandidate?: boolean
}

export interface RealTurnPlanOptions {
  maxTurns: number
  maxRepairLoops: number
}

export interface QualityRepairDecisionInput {
  completedAttempts: number
  maximumAttempts: number
  previousMissingEvidence: readonly string[]
  currentMissingEvidence: readonly string[]
}

export interface QualityRepairDecision {
  reservePair: boolean
  reason: 'available' | 'attempt-limit' | 'no-evidence-progress'
}

export type RealTurnPlanVersion = 'balanced-hybrid-v1' | 'lean-collaboration-v2'

export function contributionNeedsFreshSource(
  kind: RealTurnKind,
  opponentHasAcceptedContribution: boolean
): boolean {
  // Repair contributions must produce durable work evidence, but they must
  // not mutate already-correct source merely to satisfy the orchestrator.
  if (kind === 'repair') return false
  return kind === 'code' && !opponentHasAcceptedContribution
}

function actors(runId: string): { first: RealTurn['agent']; second: RealTurn['agent'] } {
  const suffix = runId.match(/([0-9a-f])$/i)?.[1]
  const codexOpens = suffix !== undefined && Number.parseInt(suffix, 16) % 2 === 1
  return { first: codexOpens ? 'codex' : 'claude', second: codexOpens ? 'claude' : 'codex' }
}

export function buildLegacyRealTurnPlan(runId: string, options?: RealTurnPlanOptions): RealTurn[] {
  const { first, second } = actors(runId)
  const name = (agent: RealTurn['agent']): string => agent === 'claude' ? 'Claude' : 'Codex'
  const coreTurns: Array<Omit<RealTurn, 'id'>> = [
    { agent: first, kind: 'pitch', phase: 'round.pitch', goal: 'Pitch two compact, buildable directions and open with one plain-language position.' },
    { agent: second, kind: 'pitch', phase: 'round.pitch', goal: `Answer ${name(first)} directly, pitch an alternative, and identify the strongest shared constraint.` },
    { agent: first, kind: 'critique', phase: 'round.critique', goal: `Challenge ${name(second)} with concrete product and build evidence, then propose a synthesis.` },
    { agent: second, kind: 'critique', phase: 'round.consensus', goal: `Answer ${name(first)}, seal one scope and specification, and create two similarly weighted source-changing tasks.` },
    { agent: first, kind: 'code', phase: 'round.code', goal: 'Claim and implement the first substantive source-changing task. Leave the second implementation slice untouched.' },
    { agent: second, kind: 'code', phase: 'round.code', goal: 'Claim and implement the other substantive source-changing task. Integrate without replacing the first contribution.' },
    { agent: first, kind: 'review', phase: 'round.verify', goal: `Review ${name(second)}'s slice, run the available verification commands, and repair only evidenced defects.` },
    { agent: second, kind: 'review', phase: 'round.repair', goal: `Review ${name(first)}'s slice, fix remaining verified failures, and write the final reveal packet if the build is ready.`, revealCandidate: true }
  ]
  const maxTurns = Math.max(2, options?.maxTurns ?? coreTurns.length)
  const turns = coreTurns.slice(0, maxTurns)
  if (turns.length === coreTurns.length) {
    const availablePairs = Math.floor(Math.max(0, maxTurns - coreTurns.length) / 2)
    const repairPairs = Math.min(Math.max(0, options?.maxRepairLoops ?? 0), availablePairs)
    for (let loop = 1; loop <= repairPairs; loop += 1) {
      turns.push(
        { agent: first, kind: 'repair', phase: 'round.repair', goal: `Repair loop ${String(loop)}: inspect current shared evidence, claim one remaining defect, implement a bounded fix, and preserve ${name(second)}'s accepted work.` },
        { agent: second, kind: 'repair', phase: 'round.repair', goal: `Repair loop ${String(loop)}: answer ${name(first)}'s repair with fresh verification, fix only remaining evidenced defects, and update the reveal packet when the build is ready.` }
      )
    }
  }
  return turns.map((turn, index) => ({ ...turn, id: `turn-${String(index + 1).padStart(2, '0')}-${turn.agent}-${turn.kind}` }))
}

export function buildRealTurnPlan(runId: string, options?: RealTurnPlanOptions): RealTurn[] {
  const { first, second } = actors(runId)
  const name = (agent: RealTurn['agent']): string => agent === 'claude' ? 'Claude' : 'Codex'
  const coreTurns: Array<Omit<RealTurn, 'id'>> = [
    { agent: first, kind: 'pitch', phase: 'round.pitch', goal: 'Pitch two compact, buildable directions and open with one plain-language position.' },
    { agent: second, kind: 'pitch', phase: 'round.pitch', goal: `Answer ${name(first)} directly, pitch an alternative, and identify the strongest shared constraint.` },
    { agent: first, kind: 'critique', phase: 'round.critique', goal: `Challenge ${name(second)} with concrete product and build evidence, then propose a synthesis.` },
    { agent: second, kind: 'critique', phase: 'round.consensus', goal: `Answer ${name(first)}, seal one scope and specification, and create two similarly weighted source-changing tasks.` },
    { agent: first, kind: 'code', phase: 'round.code', goal: 'Claim and implement the first substantive source-changing task. Leave the second implementation slice untouched.' },
    { agent: second, kind: 'code', phase: 'round.code', goal: `Review ${name(first)}'s accepted contribution, challenge weak choices, then implement and integrate the other substantive source-changing task without replacing good work.` },
    {
      agent: first,
      kind: 'review',
      phase: 'round.verify',
      goal: `Review ${name(second)}'s integrated contribution against the sealed specification and current verification evidence. Accept it or identify only concrete release-blocking defects.`,
      revealCandidate: true
    }
  ]
  const maxTurns = Math.max(2, options?.maxTurns ?? coreTurns.length)
  const turns = coreTurns.slice(0, maxTurns)
  if (turns.length === coreTurns.length) {
    const availablePairs = Math.floor(Math.max(0, maxTurns - coreTurns.length) / 2)
    const repairPairs = Math.min(Math.max(0, options?.maxRepairLoops ?? 0), availablePairs)
    for (let loop = 1; loop <= repairPairs; loop += 1) {
      turns.push(
        {
          agent: second,
          kind: 'repair',
          phase: 'round.repair',
          goal: `Repair loop ${String(loop)}: inspect current shared evidence, claim one remaining defect, implement a bounded fix, and preserve ${name(first)}'s accepted work.`
        },
        {
          agent: first,
          kind: 'repair',
          phase: 'round.repair',
          goal: `Repair loop ${String(loop)}: answer ${name(second)}'s repair with fresh verification, fix only remaining evidenced defects, and update the reveal packet when the build is ready.`
        }
      )
    }
  }
  return turns.map((turn, index) => ({ ...turn, id: `turn-${String(index + 1).padStart(2, '0')}-${turn.agent}-${turn.kind}` }))
}

/**
 * Appends a new, explicitly user-authorized quality-repair capsule after the
 * normal plan has finished. IDs are stable across restart so a durable cursor
 * can resume the reserved pair without replaying an earlier expensive turn.
 */
export function buildQualityRepairTurns(
  runId: string,
  attempt: number,
  missingEvidence: readonly string[]
): RealTurn[] {
  const { first: defaultFirst } = actors(runId)
  const missingClaude = missingEvidence.some((item) => /^Claude\b/i.test(item))
  const missingCodex = missingEvidence.some((item) => /^Codex\b/i.test(item))
  const first: RealTurn['agent'] = missingClaude && !missingCodex
    ? 'claude'
    : missingCodex && !missingClaude
      ? 'codex'
      : defaultFirst
  const second: RealTurn['agent'] = first === 'claude' ? 'codex' : 'claude'
  const name = (agent: RealTurn['agent']): string => agent === 'claude' ? 'Claude' : 'Codex'
  const index = Math.max(1, Math.trunc(attempt))
  const evidence = missingEvidence.length > 0
    ? missingEvidence.join('; ')
    : 'final independent release proof'
  const prefix = `quality-repair-${String(index).padStart(2, '0')}`
  return [
    {
      id: `${prefix}-${first}-repair`,
      agent: first,
      kind: 'repair',
      phase: 'round.repair',
      goal: `Reserved quality repair ${String(index)}. Close only these missing evidence categories: ${evidence}. Inspect the preserved workspace and opponent handoff, make a bounded substantive correction when source proof is missing, verify it directly, and do not replay completed work.`
    },
    {
      id: `${prefix}-${second}-review`,
      agent: second,
      kind: 'review',
      phase: 'round.verify',
      goal: `Review ${name(first)}'s reserved repair against the sealed quality brief and the current preserved revision. Close the remaining evidence categories, repair only a concrete release blocker, run direct verification, and write a ready reveal packet only when the proof is complete.`,
      revealCandidate: true
    }
  ]
}

function evidenceKey(values: readonly string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .join('\n')
}

/**
 * A full repair pair gives both agents one chance to repair and re-review.
 * Replaying the same paid pair after no evidence changed is not recovery; it
 * is a quota loop. Changing evidence may continue only to the configured cap.
 */
export function decideQualityRepair(input: QualityRepairDecisionInput): QualityRepairDecision {
  const completedAttempts = Math.max(0, Math.trunc(input.completedAttempts))
  const maximumAttempts = Math.max(1, Math.trunc(input.maximumAttempts))
  if (completedAttempts >= maximumAttempts) {
    return { reservePair: false, reason: 'attempt-limit' }
  }
  if (
    completedAttempts > 0 &&
    evidenceKey(input.previousMissingEvidence) === evidenceKey(input.currentMissingEvidence)
  ) {
    return { reservePair: false, reason: 'no-evidence-progress' }
  }
  return { reservePair: true, reason: 'available' }
}
