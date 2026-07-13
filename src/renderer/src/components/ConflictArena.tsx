import { Gavel, LockKeyhole, Swords } from 'lucide-react'
import type { DuoEvent, RunPhase } from '@shared/types'

interface ConflictArenaProps {
  conflict?: DuoEvent
  phase: RunPhase
  revealReady: boolean
}

export function ConflictArena({ conflict, phase, revealReady }: ConflictArenaProps): React.JSX.Element {
  const ideaState = revealReady
    ? 'Sealed result'
    : phase === 'round.pitch' || phase === 'round.critique' || phase === 'round.conflict'
      ? 'Idea private'
      : 'Idea sealed'
  return (
    <article className="glass-panel conflict-arena">
      <div className="tension-field" aria-hidden="true"><span /><span /><i /></div>
      <div className="arena-heading">
        <span className="eyebrow"><Swords size={13} /> Conflict arena</span>
        <span className="arena-lock"><LockKeyhole size={13} />{ideaState}</span>
      </div>
      {conflict ? (
        <div className="arena-content">
          <h2>{conflict.publicTopic ?? conflict.topic ?? 'Active disagreement'}</h2>
          <div className="positions">
            <div className="position claude-position"><span>Claude</span><p>{conflict.claudePosition ?? 'Push the experience further.'}</p></div>
            <div className="versus">VS</div>
            <div className="position codex-position"><span>Codex</span><p>{conflict.codexPosition ?? 'Protect the runnable core.'}</p></div>
          </div>
          <div className="verdict">
            <Gavel size={15} />
            <div><span>{conflict.winner ? `Verdict · ${conflict.winner}` : conflict.status === 'forming' ? 'Live evidence' : 'Challenge open'}</span><p>{conflict.resolution ?? 'Evidence from the next build turn will decide this conflict.'}</p></div>
          </div>
        </div>
      ) : (
        <div className="arena-empty"><h2>Agents are entering the arena.</h2><p>The first truthful activity or public position will appear here.</p></div>
      )}
    </article>
  )
}
