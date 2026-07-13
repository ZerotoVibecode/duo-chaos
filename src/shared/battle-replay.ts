import type { AgentId, DuoEvent, DuoTask, RunSnapshot } from './types'
import { latestVerificationEvidence, verificationOutcomeOf } from './verification-evidence'

export type BattleReplayKind =
  | 'challenge'
  | 'counter'
  | 'position'
  | 'response'
  | 'decision'
  | 'task'
  | 'failure'
  | 'repair'
  | 'verification'
  | 'reveal'

export interface BattleReplayScene {
  id: string
  kind: BattleReplayKind
  round: number
  agent: Extract<AgentId, 'claude' | 'codex' | 'director'>
  eyebrow: string
  headline: string
  body: string
  sourceEventIds: string[]
  sourceTaskIds: string[]
}

const PUBLIC_AGENTS = new Set<AgentId>(['claude', 'codex', 'director'])

function displayAgent(agent: DuoEvent['agent']): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  return 'The director'
}

function publicAgent(agent: DuoEvent['agent']): BattleReplayScene['agent'] {
  return agent === 'claude' || agent === 'codex' ? agent : 'director'
}

function publicText(event: DuoEvent): string {
  return event.publicText.trim().replace(/\s+/g, ' ')
}

function scene(
  kind: BattleReplayKind,
  event: DuoEvent,
  eyebrow: string,
  headline: string,
  body = publicText(event),
  sourceEventIds = [event.id],
  sourceTaskIds: string[] = []
): BattleReplayScene {
  return {
    id: `battle-${kind}-${event.id}`,
    kind,
    round: event.round,
    agent: publicAgent(event.agent),
    eyebrow,
    headline,
    body,
    sourceEventIds,
    sourceTaskIds
  }
}

function taskForEvent(event: DuoEvent, tasks: DuoTask[]): DuoTask | undefined {
  if (event.task?.status === 'done') return event.task
  const taskIds = new Set([event.task?.id, ...(event.relatedTaskIds ?? [])].filter((value): value is string => Boolean(value)))
  return tasks.find((task) => task.status === 'done' && taskIds.has(task.id))
}

function findDirectExchange(events: DuoEvent[]): [DuoEvent, DuoEvent] | undefined {
  const byId = new Map(events.map((event) => [event.id, event]))
  for (const reply of events) {
    if (!reply.replyTo || (reply.agent !== 'claude' && reply.agent !== 'codex')) continue
    const opening = byId.get(reply.replyTo)
    if (!opening || (opening.agent !== 'claude' && opening.agent !== 'codex') || opening.agent === reply.agent) continue
    if (!publicText(opening) || !publicText(reply)) continue
    return [opening, reply]
  }

  const positions = events.filter((event) => (
    event.type === 'opinion' || event.type === 'agent.dispatch'
  ) && (event.agent === 'claude' || event.agent === 'codex'))
  for (let index = 1; index < positions.length; index += 1) {
    const opening = positions[index - 1]
    const reply = positions[index]
    if (!opening || !reply || opening.agent === reply.agent) continue
    if (opening.targetAgent !== reply.agent || reply.targetAgent !== opening.agent) continue
    if (!publicText(opening) || !publicText(reply)) continue
    return [opening, reply]
  }
  return undefined
}

/**
 * Builds a compact reveal replay from the public run record. It deliberately
 * skips categories with no recorded evidence instead of filling gaps with a
 * generated story.
 */
export function buildBattleReplay(run: Pick<RunSnapshot, 'events' | 'tasks'>): BattleReplayScene[] {
  const indexed = run.events.map((event, index) => ({ event, index }))
  const events = indexed
    .filter(({ event }) => PUBLIC_AGENTS.has(event.agent) && publicText(event).length > 0)
    .sort((left, right) => {
      const time = left.event.timestamp.localeCompare(right.event.timestamp)
      if (time !== 0) return time
      if (left.event.round !== right.event.round) return left.event.round - right.event.round
      return left.index - right.index
    })
    .map(({ event }) => event)

  const selected: BattleReplayScene[] = []
  const exchange = findDirectExchange(events)
  if (exchange) {
    const [opening, reply] = exchange
    const openingIsChallenge = opening.dispatchKind === 'challenge'
    const replyIsCounter = reply.dispatchKind === 'counter'
    selected.push(scene(
      openingIsChallenge ? 'challenge' : 'position',
      opening,
      openingIsChallenge ? 'Opening challenge' : 'Opening position',
      openingIsChallenge
        ? `${displayAgent(opening.agent)} opened a direct challenge`
        : `${displayAgent(opening.agent)} took the first position`
    ))
    selected.push(scene(
      replyIsCounter ? 'counter' : 'response',
      reply,
      replyIsCounter ? 'Direct counter' : 'Recorded response',
      `${displayAgent(reply.agent)} answered ${displayAgent(opening.agent)} directly`,
      publicText(reply),
      [reply.id, opening.id]
    ))
  } else {
    const conflict = events.find((event) => event.type === 'conflict')
    if (conflict) selected.push(scene('challenge', conflict, 'Conflict opened', 'A recorded disagreement surfaced'))
  }

  const decision = [...events].reverse().find((event) => event.type === 'decision')
  if (decision) selected.push(scene('decision', decision, 'Recorded decision', 'The shared direction changed'))

  const taskEvent = events.find((event) => event.type === 'task.updated' && taskForEvent(event, run.tasks))
  if (taskEvent) {
    const task = taskForEvent(taskEvent, run.tasks)
    if (task) {
      const taskBody = [task.publicTitle, publicText(taskEvent)]
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .join(' — ')
      selected.push(scene(
        'task',
        taskEvent,
        'Task milestone',
        `${displayAgent(taskEvent.agent)} closed recorded work`,
        taskBody,
        [taskEvent.id],
        [task.id]
      ))
    }
  }

  const failure = events.filter((event) => verificationOutcomeOf(event) === 'failed').at(-1)
  if (failure) selected.push(scene('failure', failure, 'Build resistance', 'A recorded verification failed'))

  const failureIndex = failure ? events.indexOf(failure) : -1
  const repair = failureIndex >= 0
    ? events.slice(failureIndex + 1).find((event) => event.type === 'repair.completed')
    : [...events].reverse().find((event) => event.type === 'repair.completed')
  if (repair) selected.push(scene('repair', repair, 'Repair recorded', `${displayAgent(repair.agent)} completed a repair`))

  const repairIndex = repair ? events.indexOf(repair) : -1
  const evidenceIndex = Math.max(failureIndex, repairIndex)
  const latestVerification = latestVerificationEvidence(events)
  const verification = latestVerification?.outcome === 'passed' && latestVerification.index > evidenceIndex
    ? latestVerification.event
    : undefined
  if (verification) selected.push(scene('verification', verification, 'Verification evidence', 'A recorded verification passed'))

  const reveal = events.filter((event) => event.type === 'reveal.ready').at(-1)
    ?? events.filter((event) => event.type === 'run.completed').at(-1)
  if (reveal) selected.push(scene('reveal', reveal, 'Reveal record', 'The sealed result reached reveal'))

  const eventOrder = new Map(events.map((event, index) => [event.id, index]))
  return selected
    .sort((left, right) => (eventOrder.get(left.sourceEventIds[0] ?? '') ?? Number.MAX_SAFE_INTEGER)
      - (eventOrder.get(right.sourceEventIds[0] ?? '') ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 8)
}
