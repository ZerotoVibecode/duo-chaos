import type {
  BroadcastBeat,
  BroadcastEvidence,
  BroadcastMission,
  BroadcastResponseDue,
  BroadcastState,
  DuoEvent,
  DuoTask
} from '@shared/types'
import type { RealTurn } from './real-turn-plan'

export interface BuildBroadcastStateInput {
  runId: string
  now: string
  tick: number
  activeTurnIndex: number
  plan: RealTurn[]
  events: DuoEvent[]
  tasks: DuoTask[]
}

const RESPONSE_DUE_SECONDS = 60

function agentLabel(agent: RealTurn['agent']): string {
  return agent === 'claude' ? 'Claude' : 'Codex'
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function chronological(events: DuoEvent[]): DuoEvent[] {
  const unique = new Map<string, DuoEvent>()
  for (const event of events) unique.set(event.id, event)
  return [...unique.values()].sort((left, right) => {
    const byTime = timestamp(left.timestamp) - timestamp(right.timestamp)
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime
  })
}

function lastMatching(events: DuoEvent[], predicate: (event: DuoEvent) => boolean): DuoEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && predicate(event)) return event
  }
  return undefined
}

function currentTurnEvents(events: DuoEvent[], activeAgent: RealTurn['agent'], startedAt?: string): DuoEvent[] {
  const threshold = startedAt ? timestamp(startedAt) : Number.NEGATIVE_INFINITY
  return events.filter((event) => {
    if (timestamp(event.timestamp) < threshold) return false
    if (event.agent === activeAgent) return true
    return event.type.startsWith('build.') || event.type.startsWith('repair.')
  })
}

function carriesEvidence(event: DuoEvent): boolean {
  return Boolean(
    event.topic === 'inspection' ||
      event.topic === 'edit' ||
      event.topic === 'verification' ||
      event.topic === 'command-failure' ||
      event.category === 'file' ||
      event.category === 'error' ||
      event.type === 'file.changed' ||
      event.type.startsWith('build.') ||
      event.type.startsWith('repair.')
  )
}

function evidenceFrom(events: DuoEvent[]): BroadcastEvidence {
  return events.reduce<BroadcastEvidence>(
    (result, event) => {
      const text = event.publicText.toLowerCase()
      const inspection = event.topic === 'inspection' || /\binspect(?:ing|ed|ion)?\b/.test(text)
      const edit = event.topic === 'edit' || event.category === 'file' || event.type === 'file.changed'
      const verification =
        event.topic === 'verification' || event.type === 'build.started' || event.type === 'build.passed'
      const failure =
        event.topic === 'command-failure' || event.category === 'error' || event.type === 'build.failed'
      return {
        inspections: result.inspections + Number(inspection),
        edits: result.edits + Number(edit),
        verifications: result.verifications + Number(verification),
        failures: result.failures + Number(failure)
      }
    },
    { inspections: 0, edits: 0, verifications: 0, failures: 0 }
  )
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${String(value)} ${value === 1 ? singular : plural}`
}

function missionLabel(turn: RealTurn): string {
  const labels: Record<RealTurn['kind'], string> = {
    pitch: 'Hidden pitch',
    critique: 'Counter-position',
    consensus: 'Consensus decision',
    tasking: 'Shared board draft',
    code: 'Scoped implementation',
    review: 'Cross-review',
    verify: 'Verification round',
    repair: 'Repair and reveal'
  }
  return labels[turn.kind]
}

function scheduledMissions(plan: RealTurn[], activeTurnIndex: number): BroadcastMission[] {
  return plan.slice(activeTurnIndex, activeTurnIndex + 3).map((turn, index) => ({
    turnId: turn.id,
    agent: turn.agent,
    label: missionLabel(turn),
    status: index === 0 ? 'active' : 'queued',
    claimed: false
  }))
}

function recentAgentQuotes(events: DuoEvent[]): DuoEvent[] {
  const quotes = events.filter(
    (event) =>
      (event.type === 'opinion' || event.type === 'agent.dispatch') &&
      (event.agent === 'claude' || event.agent === 'codex')
  )
  const recent: DuoEvent[] = []
  for (const agent of ['claude', 'codex'] as const) {
    const quote = lastMatching(quotes, (event) => event.agent === agent)
    if (quote) recent.push(quote)
  }
  return recent.sort((left, right) => timestamp(right.timestamp) - timestamp(left.timestamp))
}

function dispatchBeatKind(event: DuoEvent, activeAgent: RealTurn['agent']): BroadcastBeat['kind'] {
  if (event.type !== 'agent.dispatch') return event.agent === activeAgent ? 'agent-quote' : 'replay'
  switch (event.dispatchKind) {
    case 'opening':
      return 'opening'
    case 'challenge':
      return 'challenge'
    case 'counter':
      return 'counter'
    case 'evidence':
      return 'evidence'
    case 'concession':
      return 'concession'
    case 'decision':
    case 'verdict':
      return 'decision'
    case 'repair':
      return 'repair'
    default:
      return event.agent === activeAgent ? 'agent-quote' : 'replay'
  }
}

function quoteBeat(runId: string, event: DuoEvent, activeAgent: RealTurn['agent']): BroadcastBeat | undefined {
  if (event.agent !== 'claude' && event.agent !== 'codex') return undefined
  return {
    id: `${runId}:quote:${event.id}`,
    kind: dispatchBeatKind(event, activeAgent),
    speaker: event.agent,
    provenance: 'agent-quote',
    headline:
      event.agent === activeAgent
        ? `${agentLabel(event.agent)} is on the record`
        : `Earlier, ${agentLabel(event.agent)} said`,
    detail: event.publicText,
    sourceEventIds: [event.id],
    severity: event.severity,
    createdAt: event.timestamp,
    quote: {
      agent: event.agent,
      text: event.publicText,
      sourceEventId: event.id
    }
  }
}

function responseBeat(
  runId: string,
  due: BroadcastResponseDue,
  sourceEvent: DuoEvent,
  activeAgent: RealTurn['agent']
): BroadcastBeat {
  return {
    id: `${runId}:response:${sourceEvent.id}:${String(Math.floor(due.waitingSeconds / 30))}`,
    kind: 'response-clock',
    speaker: 'director',
    provenance: 'director',
    headline: `${agentLabel(due.agent)} response queued`,
    detail: `${agentLabel(activeAgent)} has held the single-writer workspace for ${String(due.waitingSeconds)} seconds. ${agentLabel(due.agent)} is scheduled next.`,
    sourceEventIds: [sourceEvent.id],
    createdAt: sourceEvent.timestamp
  }
}

function activeTurnBeat(runId: string, sourceEvent: DuoEvent, activeAgent: RealTurn['agent']): BroadcastBeat {
  return {
    id: `${runId}:on-air:${sourceEvent.id}`,
    kind: 'heartbeat',
    speaker: 'director',
    provenance: 'director',
    headline: `${agentLabel(activeAgent)} holds the live turn`,
    detail: sourceEvent.publicText,
    sourceEventIds: [sourceEvent.id],
    createdAt: sourceEvent.timestamp
  }
}

function evidenceBeat(
  runId: string,
  evidence: BroadcastEvidence,
  sourceEvents: DuoEvent[],
  activeAgent: RealTurn['agent']
): BroadcastBeat | undefined {
  if (sourceEvents.length === 0) return undefined
  return {
    id: `${runId}:evidence:${sourceEvents.map((event) => event.id).join(':')}`,
    kind: 'evidence',
    speaker: 'director',
    provenance: 'evidence',
    headline: `${agentLabel(activeAgent)} is producing live evidence`,
    detail: [
      countLabel(evidence.inspections, 'inspection'),
      countLabel(evidence.edits, 'edit'),
      countLabel(evidence.verifications, 'verification'),
      countLabel(evidence.failures, 'failure')
    ].join(' / '),
    sourceEventIds: sourceEvents.map((event) => event.id),
    createdAt: sourceEvents.at(-1)?.timestamp
  }
}

function challengeBeat(runId: string, conflict: DuoEvent): BroadcastBeat {
  return {
    id: `${runId}:challenge:${conflict.id}`,
    kind: 'challenge',
    speaker: 'director',
    provenance: 'director',
    headline: conflict.publicTopic ?? conflict.topic ?? 'Challenge open',
    detail: conflict.resolution ?? conflict.publicText,
    sourceEventIds: [conflict.id],
    severity: conflict.severity,
    createdAt: conflict.timestamp
  }
}

function eventBeat(runId: string, event: DuoEvent): BroadcastBeat | undefined {
  const common = {
    speaker: 'director' as const,
    detail: event.publicText,
    sourceEventIds: [event.id],
    severity: event.severity,
    createdAt: event.timestamp
  }
  switch (event.type) {
    case 'phase.changed':
      return {
        ...common,
        id: `${runId}:phase:${event.id}`,
        kind: 'heartbeat',
        provenance: 'director',
        headline: 'The run has entered a new phase'
      }
    case 'agent.started':
      return {
        ...common,
        id: `${runId}:turn:${event.id}`,
        kind: 'live-move',
        provenance: 'evidence',
        headline: `${event.agent === 'claude' || event.agent === 'codex' ? agentLabel(event.agent) : 'An agent'} has the workspace`
      }
    case 'task.created':
    case 'task.claimed':
    case 'task.updated':
      return {
        ...common,
        id: `${runId}:task:${event.id}`,
        kind: 'task',
        provenance: 'evidence',
        headline:
          event.type === 'task.created'
            ? 'A mission entered the shared board'
            : event.type === 'task.claimed'
              ? 'A mission was claimed'
              : 'The shared board changed'
      }
    case 'build.started':
      return {
        ...common,
        id: `${runId}:verification:${event.id}`,
        kind: 'verification',
        provenance: 'evidence',
        headline: 'Verification is running'
      }
    case 'build.failed':
      return {
        ...common,
        id: `${runId}:failure:${event.id}`,
        kind: 'failure',
        provenance: 'evidence',
        headline: 'The build broke'
      }
    case 'build.passed':
      return {
        ...common,
        id: `${runId}:passed:${event.id}`,
        kind: 'verification',
        provenance: 'evidence',
        headline: 'The build passed'
      }
    case 'repair.started':
    case 'repair.completed':
      return {
        ...common,
        id: `${runId}:repair:${event.id}`,
        kind: 'repair',
        provenance: 'evidence',
        headline: event.type === 'repair.started' ? 'A repair is under way' : 'The repair completed'
      }
    case 'decision':
      return {
        ...common,
        id: `${runId}:decision:${event.id}`,
        kind: 'decision',
        provenance: 'director',
        headline: 'A recorded decision changed the run'
      }
    default:
      return undefined
  }
}

function dedupeBeats(beats: BroadcastBeat[]): BroadcastBeat[] {
  const seenIds = new Set<string>()
  const seenPresentation = new Set<string>()
  return beats.filter((beat) => {
    const presentation = [beat.kind, beat.provenance, beat.speaker, beat.headline, beat.detail].join('\u0000')
    if (seenIds.has(beat.id) || seenPresentation.has(presentation)) return false
    seenIds.add(beat.id)
    seenPresentation.add(presentation)
    return true
  })
}

function sortBeatsByRecency(beats: BroadcastBeat[]): BroadcastBeat[] {
  return [...beats].sort((left, right) => timestamp(right.createdAt ?? '') - timestamp(left.createdAt ?? ''))
}

function fallbackBeat(runId: string, source?: DuoEvent): BroadcastBeat {
  if (source) {
    return {
      id: `${runId}:status:${source.id}`,
      kind: 'status',
      speaker: 'director',
      provenance: 'director',
      headline: 'Live evidence received',
      detail: source.publicText,
      sourceEventIds: [source.id],
      severity: source.severity,
      createdAt: source.timestamp
    }
  }
  return {
    id: `${runId}:status:warming-up`,
    kind: 'status',
    speaker: 'director',
    provenance: 'director',
    headline: 'Broadcast warming up',
    detail: 'No public evidence has arrived yet.',
    sourceEventIds: []
  }
}

function resolutionBeat(runId: string, source: DuoEvent): BroadcastBeat {
  const partial = source.status === 'partial'
  const failed = source.status === 'failed'
  return {
    id: `${runId}:resolution:${source.id}`,
    kind: 'resolution',
    speaker: 'director',
    provenance: 'director',
    headline: failed
      ? 'Build stopped before full completion'
      : partial
        ? 'Build reached reveal with documented caveats'
        : 'Build fully complete and ready for reveal',
    detail: source.publicText,
    sourceEventIds: [source.id],
    severity: source.severity,
    createdAt: source.timestamp
  }
}

export function buildBroadcastState(input: BuildBroadcastStateInput): BroadcastState {
  const events = chronological(input.events)
  const activeTurn = input.plan[input.activeTurnIndex]
  const activeAgent =
    activeTurn?.agent ?? lastMatching(events, (event) => event.agent === 'claude' || event.agent === 'codex')?.agent
  const safeActiveAgent: RealTurn['agent'] = activeAgent === 'codex' ? 'codex' : 'claude'
  const activeStarted = lastMatching(
    events,
    (event) => event.type === 'agent.started' && event.agent === safeActiveAgent
  )
  const activeEvents = currentTurnEvents(events, safeActiveAgent, activeStarted?.timestamp).filter(carriesEvidence)
  const evidence = evidenceFrom(activeEvents)
  const nextTurn = input.plan[input.activeTurnIndex + 1]
  const waitingSeconds = activeStarted
    ? Math.max(0, Math.floor((timestamp(input.now) - timestamp(activeStarted.timestamp)) / 1_000))
    : 0
  const responseDue =
    activeStarted && nextTurn && nextTurn.agent !== safeActiveAgent && waitingSeconds >= RESPONSE_DUE_SECONDS
      ? {
          agent: nextTurn.agent,
          since: activeStarted.timestamp,
          waitingSeconds,
          nextTurnId: nextTurn.id
        }
      : undefined

  const readiness = lastMatching(events, (event) => event.type === 'reveal.ready')
  if (readiness) {
    const resolution = resolutionBeat(input.runId, readiness)
    return {
      activeBeat: resolution,
      beats: [resolution],
      evidence,
      missions: scheduledMissions(input.plan, input.activeTurnIndex)
    }
  }

  const candidates: BroadcastBeat[] = []
  for (const event of recentAgentQuotes(events)) {
    const quote = quoteBeat(input.runId, event, safeActiveAgent)
    if (quote) candidates.push(quote)
  }
  if (activeStarted) candidates.push(activeTurnBeat(input.runId, activeStarted, safeActiveAgent))
  if (responseDue && activeStarted) {
    candidates.push(responseBeat(input.runId, responseDue, activeStarted, safeActiveAgent))
  }
  const evidenceUpdate = evidenceBeat(input.runId, evidence, activeEvents, safeActiveAgent)
  if (evidenceUpdate) candidates.push(evidenceUpdate)
  const conflict = lastMatching(events, (event) => event.type === 'conflict' && event.status !== 'resolved')
  if (conflict) candidates.push(challengeBeat(input.runId, conflict))
  const sceneBeats = events
    .map((event) => eventBeat(input.runId, event))
    .filter((beat): beat is BroadcastBeat => Boolean(beat))
    .slice(-8)
  candidates.push(...sceneBeats)

  const beats = dedupeBeats(sortBeatsByRecency(candidates))
  if (beats.length === 0) beats.push(fallbackBeat(input.runId, events.at(-1)))

  const tick = Number.isFinite(input.tick) ? Math.max(0, Math.trunc(input.tick)) : 0
  return {
    activeBeat: beats[tick % beats.length]!,
    beats,
    evidence,
    missions: scheduledMissions(input.plan, input.activeTurnIndex),
    ...(responseDue ? { responseDue } : {})
  }
}
