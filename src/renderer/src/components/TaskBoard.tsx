import { Check, CircleDashed, ListTodo, Lock, ShieldAlert } from 'lucide-react'
import type { BroadcastMission, DuoEvent, DuoTask, MissionProfile, RunPhase } from '@shared/types'
import { missionPresentation } from '@renderer/lib/mission-presentation'

function waitingCopy(phase: RunPhase): { title: string; detail: string } {
  if (phase === 'round.pitch' || phase === 'round.critique' || phase === 'round.conflict') {
    return { title: 'Board locked during ideation', detail: 'Tasks open after a direction survives the conflict.' }
  }
  if (phase === 'round.consensus' || phase === 'round.tasking') {
    return { title: 'Task storm is being drafted', detail: 'The shared board will populate as the agents file real work.' }
  }
  return { title: 'No board entries yet', detail: 'The orchestrator is watching the shared workspace for task changes.' }
}

interface TaskBoardProps {
  tasks: DuoTask[]
  phase: RunPhase
  missions?: BroadcastMission[]
  events?: DuoEvent[]
  missionProfile?: MissionProfile
}

export function TaskBoard({ tasks, phase, missions = [], events = [], missionProfile = 'surprise' }: TaskBoardProps): React.JSX.Element {
  const labels = missionPresentation(missionProfile)
  const done = tasks.filter((task) => task.status === 'done').length
  const waiting = waitingCopy(phase)
  const positions = events.filter((event) => (event.type === 'opinion' || event.type === 'agent.dispatch') && (event.agent === 'claude' || event.agent === 'codex')).length
  const challenges = events.filter((event) => event.type === 'conflict'
    || event.dispatchKind === 'challenge'
    || event.dispatchKind === 'counter'
    || ((event.type === 'opinion' || event.type === 'agent.dispatch') && Boolean(event.targetAgent))).length
  return (
    <section className="glass-panel task-panel" role="region" aria-label="Mission board">
      <div className="panel-heading"><div><span className="eyebrow"><ListTodo size={13} /> Shared board</span><h2>{labels.board}</h2></div><span className="task-count">{done}/{tasks.length}</span></div>
      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="empty-task mission-drafting" data-testid="mission-drafting" aria-live="polite">
            <CircleDashed size={22} />
            <strong>Mission drafting</strong>
            <p>{positions} {positions === 1 ? 'position' : 'positions'} recorded · {challenges} {challenges === 1 ? 'challenge' : 'challenges'} live</p>
            <span>{waiting.detail}</span>
            {missions.length > 0 && (
              <div className="mission-queue" aria-label="Scheduled agent missions">
                {missions.slice(0, 4).map((mission) => (
                  <article className={`mission-card mission-${mission.status}`} key={mission.turnId}>
                    <span>{mission.agent}</span>
                    <strong>{mission.label}</strong>
                    <small>{mission.claimed ? mission.status : `${mission.status} · unclaimed`}</small>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : tasks.map((task) => (
          <article className={`task-card task-${task.status}`} key={task.id}>
            <span className="task-status-icon">{task.status === 'done' ? <Check size={14} /> : <CircleDashed size={14} />}</span>
            <div><strong>{task.publicTitle}</strong><span className={`owner owner-${task.claimedBy ?? 'none'}`}>{task.claimedBy ?? 'unclaimed'} · {task.status}</span></div>
            <span className={`risk risk-${task.risk}`}>{task.risk === 'high' ? <ShieldAlert size={11} /> : <Lock size={10} />}{task.risk}</span>
          </article>
        ))}
      </div>
    </section>
  )
}
