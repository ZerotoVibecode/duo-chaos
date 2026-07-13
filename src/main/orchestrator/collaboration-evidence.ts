import type { DuoEvent, DuoTask } from '@shared/types'

type CollaboratingAgent = Extract<DuoEvent['agent'], 'claude' | 'codex'>

export function hasReciprocalReviewEvidence(
  events: DuoEvent[],
  agent: CollaboratingAgent,
  round: number
): boolean {
  const opponent: CollaboratingAgent = agent === 'claude' ? 'codex' : 'claude'
  const eventIndex = new Map(events.map((event, index) => [event.id, { event, index }]))
  return events.some((event, index) => {
    if (
      event.type !== 'agent.dispatch' || event.agent !== agent || event.round !== round ||
      event.targetAgent !== opponent || !event.replyTo
    ) return false
    const replied = eventIndex.get(event.replyTo)
    return Boolean(
      replied && replied.index < index && replied.event.type === 'agent.dispatch' && replied.event.agent === opponent
    )
  })
}

export function hasCompletedOwnedTask(tasks: DuoTask[], agent: CollaboratingAgent): boolean {
  return tasks.some((task) => task.status === 'done' && task.claimedBy === agent)
}
