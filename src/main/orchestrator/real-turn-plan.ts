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
