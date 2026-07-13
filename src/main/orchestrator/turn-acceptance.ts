import type { DuoEvent, TurnStageName, TurnStageSnapshot } from '@shared/types'
import type { ProcessRunResult } from '@main/process/process-runner'
import type { VerificationOutcome } from '@shared/verification-evidence'

type TurnAgent = Extract<DuoEvent['agent'], 'claude' | 'codex'>

export interface TurnAcceptanceInput {
  agent: TurnAgent
  round: number
  result: ProcessRunResult
  events: DuoEvent[]
  stage?: TurnStageName
  requiresSourceChange?: boolean
  durableSourceChanged?: boolean
  durableWorkEvidence?: boolean
  forbidsSourceChange?: boolean
  requiresWorkEvidence?: boolean
  requiresOpinion?: boolean
}

export type TurnAcceptanceOutcome = 'accepted' | 'recovery-required' | 'timeboxed' | 'fatal'

export interface TurnAcceptance {
  accepted: boolean
  outcome: TurnAcceptanceOutcome
  reasons: string[]
}

export interface DurableWorkEvidenceInput {
  durableSourceChanged: boolean
  preservedOpeningSource: boolean
  queuedVerification?: VerificationOutcome
  streamedVerification?: VerificationOutcome
  successfulWorkspaceCommand: boolean
  protocolBuildFailed: boolean
}

/**
 * Process output is normalized onto the UI event queue asynchronously. The
 * direct stream receipt is therefore authoritative for stage acceptance when
 * the same successful command has not reached that queue yet. A recorded
 * build failure remains a conservative blocker in either path.
 */
export function hasDurableWorkEvidence(input: DurableWorkEvidenceInput): boolean {
  return input.durableSourceChanged || input.preservedOpeningSource ||
    input.queuedVerification === 'passed' || input.streamedVerification === 'passed' ||
    input.successfulWorkspaceCommand
}

export function reusableDurableWorkEvidence(
  receipt: Pick<TurnStageSnapshot, 'turnId' | 'stage' | 'durableWorkEvidence' | 'evidenceFingerprint'> | undefined,
  turnId: string,
  stage: TurnStageName,
  currentFingerprint: string | undefined
): boolean {
  return receipt?.turnId === turnId && receipt.stage === stage &&
    receipt.durableWorkEvidence === true && receipt.evidenceFingerprint !== undefined &&
    receipt.evidenceFingerprint === currentFingerprint
}

const NO_TASK_RESPONSE = /(?:i (?:do not|don't) (?:see|have).{0,80}(?:task|request)|what would you like me to (?:do|help with))/i

export function assessTurnAcceptance(input: TurnAcceptanceInput): TurnAcceptance {
  const relevant = input.events.filter((event) => event.agent === input.agent && event.round === input.round)
  const reasons: string[] = []
  const stage = input.stage
  const requiresDispatch = stage === undefined || stage === 'dialogue' || stage === 'opening' || stage === 'verdict' || stage === 'recovery'
  const requiresOpinion = input.requiresOpinion ?? (
    stage === undefined || stage === 'dialogue' || stage === 'verdict' || stage === 'recovery'
  )
  const observedSourceChange = relevant.some((event) =>
    event.type === 'file.changed' || event.type === 'agent.activity' && event.category === 'file'
  )
  const durableSourceChanged = input.durableSourceChanged ?? observedSourceChange
  const durableWorkEvidence = input.durableWorkEvidence ?? durableSourceChanged

  const leaseTimebox = input.result.cancelled && input.result.cancelReason === 'lease'
  const fatalProcess = input.result.cancelled && !leaseTimebox || input.result.exitCode !== 0 && !input.result.timedOut && !leaseTimebox
  if (input.result.cancelled && !leaseTimebox) reasons.push('process-cancelled')
  else if (input.result.exitCode !== 0 && !input.result.timedOut) reasons.push('process-failed')
  if (requiresDispatch && !relevant.some((event) => event.type === 'agent.dispatch')) reasons.push('missing-dispatch')
  if (requiresOpinion && !relevant.some((event) => event.type === 'opinion')) reasons.push('missing-opinion')
  if (input.requiresSourceChange && !durableSourceChanged) reasons.push('missing-source-change')
  if (input.requiresWorkEvidence && !durableWorkEvidence) reasons.push('missing-work-evidence')
  if (input.forbidsSourceChange && durableSourceChanged) reasons.push('forbidden-source-change')
  if (relevant.some((event) => event.privateText && NO_TASK_RESPONSE.test(event.privateText))) reasons.push('no-task-response')

  if (fatalProcess) return { accepted: false, outcome: 'fatal', reasons }
  if (input.result.timedOut || leaseTimebox) {
    const timeoutReason = stage === 'work' ? 'work-lease-expired' : 'stage-timeout'
    const missingContract = reasons.some((reason) => reason === 'missing-dispatch' || reason === 'missing-opinion' || reason === 'no-task-response')
    const durableTimedWork = input.requiresSourceChange ? durableSourceChanged : durableWorkEvidence
    if (!missingContract && (stage !== 'work' || durableTimedWork)) {
      return { accepted: false, outcome: 'timeboxed', reasons: [timeoutReason, ...reasons] }
    }
    reasons.unshift(timeoutReason)
  }
  if (reasons.some((reason) => reason === 'missing-dispatch' || reason === 'missing-opinion' || reason === 'no-task-response')) {
    return { accepted: false, outcome: 'recovery-required', reasons }
  }
  if (reasons.length > 0) return { accepted: false, outcome: 'fatal', reasons }
  return { accepted: true, outcome: 'accepted', reasons: [] }
}
