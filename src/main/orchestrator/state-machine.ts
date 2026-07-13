import type { RunPhase } from '@shared/types'

export type RunAction =
  | 'START'
  | 'PREFLIGHT_OK'
  | 'WORKSPACE_READY'
  | 'SEEDED'
  | 'PITCHED'
  | 'CRITIQUED'
  | 'CONFLICT_FOUND'
  | 'NO_CONFLICT'
  | 'CONFLICT_RESOLVED'
  | 'CONSENSUS_REACHED'
  | 'TASKS_READY'
  | 'TASK_CLAIMED'
  | 'CODE_TURN_DONE'
  | 'REVIEW_DONE'
  | 'REPAIR_NEEDED'
  | 'REPAIR_DONE'
  | 'VERIFY'
  | 'VERIFIED'
  | 'REVEAL_PREPARED'
  | 'REVEAL_READY'
  | 'COMPLETE'
  | 'PAUSE'
  | 'RESUME'
  | 'FAIL'
  | 'CANCEL'

const TRANSITIONS: Partial<Record<RunPhase, Partial<Record<RunAction, RunPhase>>>> = {
  idle: { START: 'preflight' },
  preflight: { PREFLIGHT_OK: 'workspace.create', FAIL: 'failed', CANCEL: 'cancelled' },
  'workspace.create': { WORKSPACE_READY: 'round.pitch', FAIL: 'failed', CANCEL: 'cancelled' },
  'workspace.seed': { SEEDED: 'round.pitch', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.pitch': { PITCHED: 'round.critique', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.critique': {
    CRITIQUED: 'round.conflict',
    CONFLICT_FOUND: 'round.conflict',
    NO_CONFLICT: 'round.consensus',
    FAIL: 'failed',
    CANCEL: 'cancelled'
  },
  'round.conflict': { CONFLICT_RESOLVED: 'round.consensus', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.consensus': { CONSENSUS_REACHED: 'round.tasking', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.tasking': { TASKS_READY: 'round.claim', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.claim': { TASK_CLAIMED: 'round.code', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.code': { CODE_TURN_DONE: 'round.cross-review', VERIFY: 'round.verify', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.cross-review': {
    REVIEW_DONE: 'round.code',
    REPAIR_NEEDED: 'round.repair',
    VERIFY: 'round.verify',
    FAIL: 'failed',
    CANCEL: 'cancelled'
  },
  'round.repair': { REPAIR_DONE: 'round.verify', FAIL: 'failed', CANCEL: 'cancelled' },
  'round.verify': { VERIFIED: 'reveal.prepare', REPAIR_NEEDED: 'round.repair', FAIL: 'failed', CANCEL: 'cancelled' },
  'reveal.prepare': { REVEAL_PREPARED: 'reveal.ready', REVEAL_READY: 'reveal.ready', FAIL: 'failed', CANCEL: 'cancelled' },
  'reveal.ready': { COMPLETE: 'complete', CANCEL: 'cancelled' },
  paused: { RESUME: 'preflight', CANCEL: 'cancelled' }
}

export function transitionRun(state: RunPhase, action: RunAction): RunPhase {
  if (action === 'PAUSE' && !['idle', 'complete', 'failed', 'cancelled', 'paused'].includes(state)) return 'paused'
  if (action === 'CANCEL' && !['idle', 'complete', 'failed', 'cancelled'].includes(state)) return 'cancelled'
  if (action === 'FAIL' && !['idle', 'complete', 'failed', 'cancelled'].includes(state)) return 'failed'
  const next = TRANSITIONS[state]?.[action]
  if (!next) throw new Error(`Invalid transition: ${state} + ${action}`)
  return next
}

export function canReveal(state: RunPhase): boolean {
  return state === 'reveal.ready' || state === 'complete'
}
