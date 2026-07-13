import type {
  AgentEffort,
  CodexEffort,
  QualityRoutingProfile,
  RunPhase,
  TurnKind,
  TurnStageName
} from '@shared/types'

const ORDER: readonly CodexEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function cap<T extends AgentEffort | CodexEffort>(selected: T, ceiling: CodexEffort): T | CodexEffort {
  const selectedIndex = ORDER.indexOf(selected)
  const ceilingIndex = ORDER.indexOf(ceiling)
  if (selected === 'default') return ceiling
  return selectedIndex <= ceilingIndex ? selected : ceiling
}

export interface StageEffortPolicyInput {
  agent: 'claude' | 'codex'
  selected: AgentEffort | CodexEffort
  stage: TurnStageName
  turnKind: TurnKind
  phase?: RunPhase
  qualityRouting: QualityRoutingProfile
}

/**
 * Premium effort is reserved for bounded judgment. Long Claude tool loops run
 * at High by default; this keeps product quality while avoiding Max-priced
 * repository tours and repeated tool reasoning.
 */
export function resolveStageEffort(input: StageEffortPolicyInput): AgentEffort | CodexEffort {
  if (input.stage === 'opening' || input.stage === 'verdict' || input.stage === 'recovery') return 'low'
  if (input.stage === 'dialogue') {
    return cap(input.selected, input.turnKind === 'consensus' || input.phase === 'round.consensus' ? 'high' : 'medium')
  }
  if (input.turnKind === 'verify') return cap(input.selected, 'low')
  if (input.qualityRouting === 'force-selected') {
    return input.selected === 'default' ? (input.agent === 'claude' ? 'high' : 'medium') : input.selected
  }
  if (input.agent === 'claude') {
    if (input.turnKind === 'review') return input.selected === 'default' ? 'high' : input.selected
    return cap(input.selected, 'high')
  }
  return input.selected === 'default' ? 'medium' : input.selected
}
