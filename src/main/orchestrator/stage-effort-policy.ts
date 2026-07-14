import type {
  AgentEffort,
  CodexEffort,
  QualityRoutingProfile,
  RunPhase,
  TurnKind,
  TurnStageName
} from '@shared/types'

type ExplicitEffort = Exclude<CodexEffort, 'default'>

const ORDER: readonly ExplicitEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const PROVIDER_SUPPORT: Record<'claude' | 'codex', readonly ExplicitEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ORDER
}

export interface StageEffortPolicyInput {
  agent: 'claude' | 'codex'
  selected: AgentEffort | CodexEffort
  stage: TurnStageName
  turnKind: TurnKind
  phase?: RunPhase
  qualityRouting: QualityRoutingProfile
  /** Live provider capability data, when preflight discovered a narrower ladder. */
  supportedEfforts?: readonly ExplicitEffort[]
}

export interface StageEffortDecision {
  agent: 'claude' | 'codex'
  selected: AgentEffort | CodexEffort
  /** Provider-neutral target for this kind of work. */
  target: ExplicitEffort
  /** Exact effort sent to the local CLI. */
  requested: ExplicitEffort
  qualityRouting: QualityRoutingProfile
  cappedBySelection: boolean
  fallbackFrom: ExplicitEffort | undefined
  reason: string
}

function lower(left: ExplicitEffort, right: ExplicitEffort): ExplicitEffort {
  return ORDER.indexOf(left) <= ORDER.indexOf(right) ? left : right
}

function stageTarget(input: StageEffortPolicyInput): ExplicitEffort {
  if (input.stage === 'opening' || input.stage === 'verdict' || input.stage === 'recovery') return 'low'
  if (input.stage === 'dialogue') {
    return input.turnKind === 'consensus' || input.phase === 'round.consensus' ? 'high' : 'medium'
  }

  switch (input.turnKind) {
    case 'review':
      return 'xhigh'
    case 'code':
    case 'repair':
      return 'high'
    case 'verify':
    case 'tasking':
      return 'medium'
    case 'consensus':
      return 'high'
    default:
      return 'medium'
  }
}

function closestSupported(candidate: ExplicitEffort, supported: readonly ExplicitEffort[]): ExplicitEffort {
  const unique = [...new Set(supported)].filter((effort) => ORDER.includes(effort))
  if (unique.includes(candidate)) return candidate

  const candidateIndex = ORDER.indexOf(candidate)
  const lowerOrEqual = unique
    .filter((effort) => ORDER.indexOf(effort) <= candidateIndex)
    .sort((left, right) => ORDER.indexOf(right) - ORDER.indexOf(left))[0]
  // Prefer a cheaper supported level. Only move upward if a provider exposes
  // no level at or below the semantic target.
  return lowerOrEqual ?? unique.sort((left, right) => ORDER.indexOf(left) - ORDER.indexOf(right))[0] ?? 'low'
}

/**
 * Resolves one provider-neutral quality target into the exact effort sent to
 * the selected local CLI. Agent identity affects capability fallback only;
 * it never changes the semantic target for equivalent work.
 */
export function resolveStageEffortDecision(input: StageEffortPolicyInput): StageEffortDecision {
  const target = stageTarget(input)
  const selected = input.selected === 'default' ? undefined : input.selected
  // Even the force-selected profile keeps short dialogue, recovery, and
  // mechanical verification bounded. It only forces the selected ceiling for
  // substantive source judgment and implementation.
  const forceSelected = input.qualityRouting === 'force-selected' && input.stage === 'work' && input.turnKind !== 'verify'
  const uncapped = forceSelected && selected
    ? selected
    : selected
      ? lower(selected, target)
      : target
  const supported = input.supportedEfforts ?? PROVIDER_SUPPORT[input.agent]
  const requested = closestSupported(uncapped, supported)
  const fallbackFrom = requested === uncapped ? undefined : uncapped
  const cappedBySelection = selected !== undefined && ORDER.indexOf(selected) < ORDER.indexOf(target)
  const taskLabel = input.stage === 'dialogue' ? `${input.turnKind} dialogue` : `${input.turnKind} ${input.stage}`
  const routing = forceSelected && selected
    ? `the explicit ${selected} selection`
    : `the shared ${target} quality target`
  const fallback = fallbackFrom ? `; ${fallbackFrom} is unavailable, so the closest non-upgrading supported level is ${requested}` : ''

  return {
    agent: input.agent,
    selected: input.selected,
    target,
    requested,
    qualityRouting: input.qualityRouting,
    cappedBySelection,
    fallbackFrom,
    reason: `${taskLabel} uses ${routing}${fallback}.`
  }
}

/** Backwards-compatible value API for existing orchestrator callers. */
export function resolveStageEffort(input: StageEffortPolicyInput): AgentEffort | CodexEffort {
  return resolveStageEffortDecision(input).requested
}
