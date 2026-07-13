import { Activity, Flame, LockKeyhole, MessageSquareReply, MessageSquareQuote, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DuoEvent, MissionProfile } from '@shared/types'
import { missionPresentation } from '@renderer/lib/mission-presentation'

interface CriticismFeedProps {
  events: DuoEvent[]
  missionProfile?: MissionProfile
}

type FeedFilter = 'all' | 'claude' | 'codex' | 'hot'

const LIVE_ACTIVITY_TYPES = new Set<DuoEvent['type']>([
  'agent.started',
  'agent.activity',
  'task.created',
  'task.claimed',
  'task.updated',
  'file.changed',
  'git.checkpoint',
  'build.started',
  'build.failed',
  'build.passed',
  'repair.started',
  'repair.completed',
  'run.paused',
  'run.resumed',
  'reveal.ready',
  'run.completed',
  'run.failed',
  'run.cancelled'
])

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function CriticismFeed({ events, missionProfile = 'surprise' }: CriticismFeedProps): React.JSX.Element {
  const labels = missionPresentation(missionProfile)
  const [filter, setFilter] = useState<FeedFilter>('all')
  const feed = useRef<HTMLDivElement | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)
  const followLatest = useRef(true)
  const dialogue = useMemo(
    () => events
      .filter((event) => event.type === 'opinion' || event.type === 'agent.dispatch')
      .filter((event) => filter === 'all'
        || (filter === 'hot'
          ? (event.heat ?? 0) >= 0.65 || event.dispatchKind === 'challenge' || event.dispatchKind === 'counter' || event.dispatchKind === 'verdict'
          : event.agent === filter))
      .sort((left, right) => timestamp(left.timestamp) - timestamp(right.timestamp)),
    [events, filter]
  )
  const activity = useMemo(() => {
    const latestBySignal = new Map<string, DuoEvent>()
    events
      .filter((event) => LIVE_ACTIVITY_TYPES.has(event.type) && event.publicText.trim().length > 0)
      .sort((left, right) => timestamp(left.timestamp) - timestamp(right.timestamp))
      .forEach((event) => {
        const signal = `${event.agent}|${event.topic ?? ''}|${event.publicText}`
        latestBySignal.set(signal, event)
      })

    return [...latestBySignal.values()]
      .sort((left, right) => timestamp(left.timestamp) - timestamp(right.timestamp))
      .slice(-6)
  }, [events])

  useEffect(() => {
    if (followLatest.current) bottom.current?.scrollIntoView?.({ block: 'nearest' })
  }, [dialogue.length, filter])

  return (
    <section className="glass-panel criticism-panel">
      <div className="panel-heading feed-heading">
        <div><span className="eyebrow"><MessageSquareQuote size={13} /> Agent comms</span><h2>{labels.feed}</h2></div>
        <div className="feed-filters" aria-label="Criticism filters">
          <SlidersHorizontal size={14} />
          {(['all', 'claude', 'codex', 'hot'] as const).map((item) => (
            <button key={item} type="button" aria-pressed={filter === item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>
          ))}
        </div>
      </div>
      <section className="live-activity" role="region" aria-label="Live activity">
        <div className="live-activity-heading">
          <span><Activity size={12} /> Live pulse</span>
          <small>{activity.length} recent</small>
        </div>
        {activity.length > 0 ? (
          <div className="activity-list" role="list" aria-label="Recent factual run activity">
            {activity.map((event) => (
              <article
                role="listitem"
                className={`activity-item activity-${event.agent}`}
                key={event.id}
              >
                <i aria-hidden="true" />
                <span>{displayAgent(event.agent)}</span>
                <p>{event.publicText}</p>
                <small>R{event.round}</small>
              </article>
            ))}
          </div>
        ) : (
          <div className="activity-placeholder"><i aria-hidden="true" /><span>Listening for the first factual workspace signal…</span></div>
        )}
      </section>
      <div
        ref={feed}
        className="opinion-feed"
        role="log"
        aria-label={labels.feed}
        aria-live="polite"
        onScroll={() => {
          const element = feed.current
          if (!element) return
          followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
        }}
      >
        {dialogue.length === 0 ? (
          <div className="empty-feed"><MessageSquareQuote size={22} /><strong>First public position pending.</strong><span>Public positions appear here when an agent addresses the other.</span></div>
        ) : dialogue.map((event) => <OpinionCard event={event} key={event.id} />)}
        <div ref={bottom} className="feed-bottom-anchor" aria-hidden="true" />
      </div>
    </section>
  )
}

function displayAgent(agent: DuoEvent['agent']): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  return 'Director'
}

function OpinionCard({ event }: { event: DuoEvent }): React.JSX.Element {
  const agent = displayAgent(event.agent)
  const target = event.targetAgent ? displayAgent(event.targetAgent) : undefined
  const heat = event.heat === undefined ? undefined : Math.round(event.heat * 100)
  const confidence = event.confidence === undefined ? undefined : Math.round(event.confidence * 100)
  return (
    <article className={`opinion-card opinion-${event.agent} severity-${event.severity}`} data-testid={`opinion-card-${event.id}`}>
      <div className="opinion-meta">
        <div>
          <span className="opinion-agent opinion-target">{target ? `${agent} to ${target}` : agent}</span>
          {event.replyTo && <span className="opinion-reply"><MessageSquareReply size={11} /> Replying on record</span>}
        </div>
        <div><span className="tone-pill">{event.tone ?? event.dispatchKind ?? event.topic ?? 'opinion'}</span>{event.rawAvailable && <LockKeyhole size={12} />}</div>
      </div>
      <p className="dialogue-text" data-testid="opinion-body">{event.publicText}</p>
      <div className="opinion-data">
        <span><Flame size={12} /> Heat {heat === undefined ? 'unscored' : heat}</span>
        <i className={heat === undefined ? 'unscored' : ''}><b style={{ width: `${String(heat ?? 0)}%` }} /></i>
        <span>Confidence {confidence === undefined ? 'unscored' : `${String(confidence)}%`}</span><small>R{event.round}</small>
      </div>
    </article>
  )
}
