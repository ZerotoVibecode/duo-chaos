import type { DuoEvent } from '@shared/types'

export interface BroadcastExchangeSlot {
  sourceEventId: string
  speaker: 'claude' | 'codex' | 'director'
  text: string
}

export interface BroadcastExchange {
  claimKey?: string
  opening?: BroadcastExchangeSlot
  counter?: BroadcastExchangeSlot
  verdict?: BroadcastExchangeSlot
}

function eventTime(event: DuoEvent): number {
  const value = Date.parse(event.timestamp)
  return Number.isFinite(value) ? value : 0
}

function asExchangeSlot(event: DuoEvent): BroadcastExchangeSlot | undefined {
  if (event.agent !== 'claude' && event.agent !== 'codex' && event.agent !== 'director') return undefined
  return { sourceEventId: event.id, speaker: event.agent, text: event.publicText }
}

function sharesExchange(event: DuoEvent, anchor: DuoEvent, replyIds: Set<string>): boolean {
  if (anchor.claimKey && event.claimKey === anchor.claimKey) return true
  return Boolean(event.replyTo && replyIds.has(event.replyTo))
}

export function deriveBroadcastExchange(events: DuoEvent[]): BroadcastExchange {
  const ordered = [...events].sort((left, right) => eventTime(left) - eventTime(right))
  const opening = ordered
    .filter((event) => event.type === 'agent.dispatch'
      && (event.agent === 'claude' || event.agent === 'codex')
      && (event.dispatchKind === 'opening' || event.dispatchKind === 'position' || event.dispatchKind === 'challenge'))
    .at(-1)

  if (!opening) return {}

  const openingIndex = ordered.indexOf(opening)
  const afterOpening = ordered.slice(openingIndex + 1)
  const counter = afterOpening.find((event) => event.type === 'agent.dispatch'
    && (event.agent === 'claude' || event.agent === 'codex')
    && (event.dispatchKind === 'counter' || event.dispatchKind === 'reaction' || event.dispatchKind === 'concession')
    && sharesExchange(event, opening, new Set([opening.id])))
  const replyIds = new Set([opening.id, ...(counter ? [counter.id] : [])])
  const afterCounter = counter ? ordered.slice(ordered.indexOf(counter) + 1) : afterOpening
  const verdict = afterCounter.find((event) => (
    event.type === 'decision'
      || (event.type === 'agent.dispatch'
        && (event.dispatchKind === 'verdict' || event.dispatchKind === 'decision' || event.dispatchKind === 'closing'))
  ) && sharesExchange(event, opening, replyIds))

  const openingSlot = asExchangeSlot(opening)
  const counterSlot = counter ? asExchangeSlot(counter) : undefined
  const verdictSlot = verdict ? asExchangeSlot(verdict) : undefined
  return {
    ...(opening.claimKey ? { claimKey: opening.claimKey } : {}),
    ...(openingSlot ? { opening: openingSlot } : {}),
    ...(counterSlot ? { counter: counterSlot } : {}),
    ...(verdictSlot ? { verdict: verdictSlot } : {})
  }
}

function isLiveActivity(event: DuoEvent): boolean {
  return event.type === 'agent.activity' || event.type.startsWith('task.') || event.type === 'build.failed' || event.type === 'git.checkpoint'
}

export function recentDistinctActivity(events: DuoEvent[], limit = 6): DuoEvent[] {
  const selected: DuoEvent[] = []
  const seen = new Set<string>()
  for (let index = events.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const event = events[index]
    if (!event || !isLiveActivity(event)) continue
    const signature = `${event.agent}\0${event.category ?? event.type}\0${event.publicText}`
    if (seen.has(signature)) continue
    seen.add(signature)
    selected.push(event)
  }
  return selected
}

function latest(events: DuoEvent[], type: DuoEvent['type'], agent: 'claude' | 'codex'): DuoEvent | undefined {
  return events.filter((event) => event.type === type && event.agent === agent).at(-1)
}

export function deriveArenaEvent(events: DuoEvent[]): DuoEvent | undefined {
  const explicit = events.filter((event) => event.type === 'conflict').at(-1)
  if (explicit) return explicit

  const claudeOpinion = latest(events, 'opinion', 'claude')
  const codexOpinion = latest(events, 'opinion', 'codex')
  const claudeActivity = latest(events, 'agent.activity', 'claude')
  const codexActivity = latest(events, 'agent.activity', 'codex')
  if (!claudeOpinion && !codexOpinion && !claudeActivity && !codexActivity) return undefined

  const bothHavePositions = Boolean(claudeOpinion && codexOpinion)
  const timestamp = [claudeOpinion, codexOpinion, claudeActivity, codexActivity]
    .filter((event): event is DuoEvent => Boolean(event))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1)?.timestamp ?? new Date().toISOString()
  const round = Math.max(0, ...[claudeOpinion, codexOpinion, claudeActivity, codexActivity].map((event) => event?.round ?? 0))
  const publicTopic = claudeOpinion || codexOpinion
    ? bothHavePositions ? 'Two positions are live' : `${claudeOpinion ? 'Claude' : 'Codex'} opened the first position`
    : 'Evidence is accumulating'
  return {
    id: `derived-arena-${String(round)}`,
    type: 'conflict',
    runId: (claudeOpinion ?? codexOpinion ?? claudeActivity ?? codexActivity)!.runId,
    round,
    timestamp,
    agent: 'director',
    publicText: publicTopic,
    publicTopic,
    claudePosition: claudeOpinion?.publicText ?? claudeActivity?.publicText ?? 'No public position filed yet.',
    codexPosition: codexOpinion?.publicText ?? codexActivity?.publicText ?? 'No public position filed yet.',
    resolution: bothHavePositions
      ? 'No verdict yet. The next concrete build evidence decides which position survives.'
      : claudeOpinion || codexOpinion
        ? 'The other agent has not filed a public counter-position yet.'
        : 'The first recorded challenge will open the formal conflict.',
    status: bothHavePositions ? 'open' : 'forming',
    impact: bothHavePositions ? 'medium' : 'low',
    heat: Math.max(claudeOpinion?.heat ?? 0.35, codexOpinion?.heat ?? 0.35),
    spoilerRisk: 0.05,
    severity: bothHavePositions ? 'medium' : 'low'
  }
}
