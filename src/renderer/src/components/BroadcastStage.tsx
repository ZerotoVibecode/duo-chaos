import { Activity, Gavel, LockKeyhole, Radio, Swords } from 'lucide-react'
import type { BroadcastBeat, BroadcastProvenance, DuoEvent, RunSnapshot } from '@shared/types'
import { verificationOutcomeOf } from '@shared/verification-evidence'
import { deriveBroadcastExchange, type BroadcastExchangeSlot } from '@renderer/lib/spectator-state'
import { missionPresentation } from '@renderer/lib/mission-presentation'

interface BroadcastStageProps {
  run: RunSnapshot
  conflict?: DuoEvent
}

function isAgentVoice(event: DuoEvent): boolean {
  return (event.type === 'opinion' || event.type === 'agent.dispatch') && (event.agent === 'claude' || event.agent === 'codex')
}

function isEvidence(event: DuoEvent): boolean {
  return event.type === 'agent.activity'
    || event.type === 'file.changed'
    || event.type === 'git.checkpoint'
    || event.type === 'build.started'
    || event.type === 'build.failed'
    || event.type === 'build.passed'
    || event.type === 'repair.started'
    || event.type === 'repair.completed'
    || event.type.startsWith('task.')
}

function speakerName(event: DuoEvent): string {
  if (event.agent === 'claude') return 'Claude'
  if (event.agent === 'codex') return 'Codex'
  return 'Director'
}

function fallbackBeat(run: RunSnapshot, conflict?: DuoEvent): BroadcastBeat {
  const latestVoice = run.events.filter(isAgentVoice).at(-1)
  if (latestVoice && (latestVoice.agent === 'claude' || latestVoice.agent === 'codex')) {
    return {
      id: `fallback-voice-${latestVoice.id}`,
      kind: latestVoice.dispatchKind === 'challenge' || latestVoice.dispatchKind === 'counter'
        ? latestVoice.dispatchKind
        : 'agent-quote',
      provenance: 'agent-quote',
      speaker: latestVoice.agent,
      headline: conflict?.publicTopic ?? conflict?.topic ?? `${speakerName(latestVoice)} takes the stage`,
      detail: latestVoice.publicText,
      sourceEventIds: [latestVoice.id],
      quote: {
        agent: latestVoice.agent,
        text: latestVoice.publicText,
        sourceEventId: latestVoice.id
      },
      severity: latestVoice.severity,
      createdAt: latestVoice.timestamp
    }
  }

  const latestEvidence = run.events.filter(isEvidence).at(-1)
  if (latestEvidence) {
    const verificationOutcome = verificationOutcomeOf(latestEvidence)
    return {
      id: `fallback-evidence-${latestEvidence.id}`,
      kind: verificationOutcome === 'failed' ? 'failure' : verificationOutcome === 'passed' ? 'verification' : 'evidence',
      provenance: 'evidence',
      speaker: latestEvidence.agent === 'claude' || latestEvidence.agent === 'codex' ? latestEvidence.agent : 'director',
      headline: conflict?.publicTopic ?? conflict?.topic ?? 'New workspace evidence',
      detail: latestEvidence.publicText,
      sourceEventIds: [latestEvidence.id],
      severity: latestEvidence.severity,
      createdAt: latestEvidence.timestamp
    }
  }

  const latestDirector = run.events.filter((event) => event.agent === 'director' || event.agent === 'system').at(-1)
  return {
    id: latestDirector ? `fallback-director-${latestDirector.id}` : `fallback-opening-${run.runId}`,
    kind: 'status',
    provenance: 'director',
    speaker: 'director',
    headline: conflict?.publicTopic ?? conflict?.topic ?? 'The private opening turn is live',
    detail: conflict?.resolution
      ?? latestDirector?.publicText
      ?? 'The stage will update when the first public agent position or workspace signal arrives.',
    sourceEventIds: latestDirector ? [latestDirector.id] : [],
    severity: latestDirector?.severity ?? 'low',
    createdAt: latestDirector?.timestamp ?? run.startedAt
  }
}

function displayProvenance(provenance: BroadcastProvenance): 'agent' | 'director' | 'evidence' {
  return provenance === 'agent-quote' ? 'agent' : provenance
}

function displaySpeaker(beat: BroadcastBeat): string {
  if (beat.speaker === 'claude') return 'Claude'
  if (beat.speaker === 'codex') return 'Codex'
  return 'Director desk'
}

function provenanceLabel(provenance: 'agent' | 'director' | 'evidence'): string {
  if (provenance === 'agent') return 'AGENT QUOTE'
  if (provenance === 'evidence') return 'LIVE EVIDENCE'
  return 'DIRECTOR'
}

function latestDirectorNote(run: RunSnapshot, conflict?: DuoEvent): string {
  if (conflict?.resolution) return conflict.resolution
  const event = run.events.filter((item) => item.agent === 'director' || item.type === 'decision' || item.type === 'conflict').at(-1)
  return event?.publicText ?? 'No director ruling has been recorded.'
}

function latestEvidenceNote(run: RunSnapshot): string {
  return run.events.filter(isEvidence).at(-1)?.publicText ?? 'No public workspace evidence has landed yet.'
}

function terminalResolutionBeat(run: RunSnapshot): BroadcastBeat | undefined {
  if (run.status !== 'reveal-ready' && run.phase !== 'reveal.ready') return undefined
  const source = run.events.filter((event) => event.type === 'reveal.ready').at(-1)
  const partial = run.releaseStatus === 'partial' || source?.status === 'partial'
  const failed = run.releaseStatus === 'failed' || source?.status === 'failed'
  return {
    id: `${run.runId}:resolution:${source?.id ?? 'ready'}`,
    kind: 'resolution',
    provenance: 'director',
    speaker: 'director',
    headline: failed
      ? 'Build stopped before full completion'
      : partial
        ? 'Build reached reveal with documented caveats'
        : 'Build fully complete and ready for reveal',
    detail: source?.publicText ?? 'The readiness gate passed. The sealed app can now be revealed.',
    sourceEventIds: source ? [source.id] : [],
    severity: 'low',
    createdAt: source?.timestamp
  }
}

function exchangeSpeaker(slot?: BroadcastExchangeSlot): string {
  if (slot?.speaker === 'claude') return 'Claude'
  if (slot?.speaker === 'codex') return 'Codex'
  if (slot?.speaker === 'director') return 'Director'
  return ''
}

function ExchangeStep({ label, slot, pending }: { label: string; slot?: BroadcastExchangeSlot; pending: string }): React.JSX.Element {
  const id = label.toLowerCase()
  return (
    <li
      className={slot ? 'exchange-complete' : 'exchange-pending'}
      data-testid={`exchange-${id}`}
      data-source-event-id={slot?.sourceEventId}
    >
      <span>{label}</span>
      <strong>{slot ? exchangeSpeaker(slot) : pending}</strong>
    </li>
  )
}

export function BroadcastStage({ run, conflict }: BroadcastStageProps): React.JSX.Element {
  const serious = run.missionProfile === 'serious'
  const labels = missionPresentation(run.missionProfile)
  const beat = terminalResolutionBeat(run) ?? run.broadcast?.activeBeat ?? fallbackBeat(run, conflict)
  const exchange = deriveBroadcastExchange(run.events)
  const provenance = displayProvenance(beat.provenance)
  const quoteText = beat.quote?.text ?? beat.body ?? beat.detail
  const ideaState = run.status === 'reveal-ready'
    ? 'Sealed result'
    : run.phase === 'round.pitch' || run.phase === 'round.critique' || run.phase === 'round.conflict'
      ? 'Idea private'
      : 'Idea sealed'

  return (
    <section className={`glass-panel conflict-arena broadcast-stage provenance-${provenance} beat-${beat.kind}`} role="region" aria-label="Live broadcast stage" data-testid="broadcast-stage">
      <div className="tension-field" aria-hidden="true"><span /><span /><i /></div>
      <div className="arena-heading broadcast-heading">
        <span className="eyebrow"><Swords size={13} /> {labels.arena}</span>
        <span className="arena-lock"><LockKeyhole size={13} />{ideaState}</span>
      </div>

      <ol className="exchange-rail" aria-label="Exchange progress">
        <ExchangeStep label={serious ? 'Proposal' : 'Opening'} slot={exchange.opening} pending="Pending" />
        <ExchangeStep label={serious ? 'Challenge' : 'Counter'} slot={exchange.counter} pending="Pending" />
        <ExchangeStep label={serious ? 'Decision' : 'Verdict'} slot={exchange.verdict} pending="Pending" />
      </ol>

      <article
        className="broadcast-beat"
        role="status"
        aria-label="Current broadcast beat"
        data-testid="broadcast-beat"
        data-beat-id={beat.id}
        data-beat-kind={beat.kind}
        data-provenance={provenance}
        data-agent={beat.speaker === 'claude' || beat.speaker === 'codex' ? beat.speaker : undefined}
      >
        <div className="broadcast-beat-kicker">
          <span data-testid="beat-provenance"><Radio size={12} />{provenanceLabel(provenance)}</span>
          <small>{displaySpeaker(beat)} / {beat.kind === 'agent-quote' ? 'live voice' : beat.kind.replace('-', ' ')}</small>
        </div>
        <h2 data-testid="beat-headline">{beat.headline}</h2>
        <p data-testid="beat-body">{quoteText}</p>
      </article>

      <div className="broadcast-context" aria-label="Supporting broadcast facts">
        <p><Gavel size={13} /><span>{latestDirectorNote(run, conflict)}</span></p>
        <p><Activity size={13} /><span>{latestEvidenceNote(run)}</span></p>
      </div>
    </section>
  )
}
