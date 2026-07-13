import { ArrowLeft, CircleAlert, FolderOpen, LockKeyhole, OctagonX, PauseCircle, Play, Radio, SquareTerminal, TimerReset } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunSnapshot, TurnStageSnapshot } from '@shared/types'
import { useStudioStore } from '@renderer/store/studio-store'
import { deriveArenaEvent } from '@renderer/lib/spectator-state'
import { isCueEvent, playEventCue } from '@renderer/lib/sound-cues'
import { AgentCard } from './AgentCard'
import { BroadcastStage } from './BroadcastStage'
import { CompletionTakeover } from './CompletionTakeover'
import { CriticismFeed } from './CriticismFeed'
import { EvidenceMomentum } from './EvidenceMomentum'
import { TaskBoard } from './TaskBoard'
import { TerminalDeck } from './TerminalDeck'

function phaseLabel(phase: string): string {
  return phase.replace('round.', '').replace('workspace.', '').replace('.', ' / ').replace('-', ' ')
}

function clockText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function turnStageLabel(stage: TurnStageSnapshot): string {
  if (stage.status === 'timeboxed') return 'Timeboxed · work preserved'
  if (stage.stage === 'work') return 'Work lease'
  if (stage.stage === 'recovery') return 'Contract recovery'
  return stage.stage.charAt(0).toUpperCase() + stage.stage.slice(1)
}

function pauseReasonLabel(run: RunSnapshot): string {
  const provider = run.pause?.provider === 'claude' ? 'Claude' : run.pause?.provider === 'codex' ? 'Codex' : 'Provider'
  switch (run.pause?.reason) {
    case 'provider-quota': return `${provider} quota reached`
    case 'provider-auth': return `${provider} sign-in required`
    case 'provider-unavailable': return `${provider} is unavailable`
    case 'model-unavailable': return 'Selected model is unavailable'
    case 'cli-incompatible': return 'Local CLI needs attention'
    case 'provider-protocol': return 'Provider response needs recovery'
    case 'session-lost': return 'Agent session needs recovery'
    case 'stage-timeout': return 'The current work lease expired'
    case 'host-interrupted': return 'The app was interrupted'
    case 'workspace-drift': return 'Workspace changed outside the battle'
    case 'verification-failed': return 'Verification needs another pass'
    default: return 'Execution paused safely'
  }
}

function resetCountdown(resetAt: string, now: number): string {
  const remaining = new Date(resetAt).getTime() - now
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Retry window is open'
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  if (minutes < 60) return `Retry window opens in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `Retry window opens in ${hours}h${remainder > 0 ? ` ${remainder}m` : ''}`
}

export function RunDashboard({ run }: { run: RunSnapshot }): React.JSX.Element {
  const { busy, logsOpen, error, soundEnabled, stopRun, resumeRun, revealRun, openRunFolder, setLogsOpen, returnToLaunch } = useStudioStore()
  const [now, setNow] = useState(() => Date.now())
  const [stopConfirmationOpen, setStopConfirmationOpen] = useState(false)
  const lastCueId = useRef<string | undefined>(undefined)
  useEffect(() => {
    const update = (): void => setNow(Date.now())
    update()
    if (run.finishedAt || (run.status === 'paused' && !run.pause?.resetAt)) return undefined
    const interval = setInterval(update, 1_000)
    return () => clearInterval(interval)
  }, [run.finishedAt, run.pause?.resetAt, run.startedAt, run.status])
  useEffect(() => {
    const cue = run.events.filter((event) => isCueEvent(event.type)).at(-1)
    if (!cue) return
    if (!soundEnabled || lastCueId.current === undefined) {
      lastCueId.current = cue.id
      return
    }
    if (lastCueId.current !== cue.id) {
      lastCueId.current = cue.id
      playEventCue(cue.type)
    }
  }, [run.events, soundEnabled])
  const conflict = useMemo(() => {
    const latestConflict = deriveArenaEvent(run.events)
    const latestDecision = run.events.filter((event) => event.type === 'decision').at(-1)
    return latestConflict
      ? {
          ...latestConflict,
          ...(latestDecision?.winner ? { winner: latestDecision.winner } : {}),
          ...(latestDecision?.resolution ? { resolution: latestDecision.resolution } : {})
        }
      : undefined
  }, [run.events])
  const turnStage = run.turnStage
  const progress = Math.min(100, Math.round((run.round / Math.max(1, run.totalTurns ?? 9)) * 100))
  const elapsedUntil = run.finishedAt ? new Date(run.finishedAt).getTime() : now
  const elapsed = run.activeTimeMs !== undefined
    ? Math.max(0, run.activeTimeMs)
    : Math.max(0, elapsedUntil - new Date(run.startedAt).getTime())
  const elapsedText = `${String(Math.floor(elapsed / 60_000)).padStart(2, '0')}:${String(Math.floor((elapsed % 60_000) / 1_000)).padStart(2, '0')}`
  const remaining = turnStage ? Math.max(0, new Date(turnStage.deadlineAt).getTime() - now) : 0
  const totalTurns = Math.max(1, run.totalTurns ?? 9)
  const ended = run.status === 'cancelled' || run.status === 'failed'

  return (
    <main className={`run-shell mission-${run.missionProfile ?? 'surprise'}`}>
      <section
        className={`run-pulse glass-panel run-${run.status} ${turnStage?.status === 'timeboxed' ? 'turn-timeboxed' : ''}`}
        role="region"
        aria-label="Run pulse"
      >
        <div className="pulse-status"><span className="live-orb"><i /></span><div><span className="eyebrow"><Radio size={12} /> Run pulse</span><strong>{phaseLabel(run.phase)}</strong></div></div>
        <div className="pulse-progress">
          <div>
            <span>Turn {run.round} of {totalTurns}</span>
            {turnStage && (
              <span className={`turn-stage-clock stage-${turnStage.stage} status-${turnStage.status}`}>
                {turnStageLabel(turnStage)}{turnStage.status === 'running' ? ` · ${clockText(remaining)} left` : ''}
              </span>
            )}
          </div>
          <i><b style={{ width: `${progress}%` }} /></i>
        </div>
        <div className="pulse-metrics"><span><small>Elapsed</small><strong>{elapsedText}</strong></span><span><small>Mission</small><strong>{run.missionProfile ?? 'surprise'}</strong></span><span><small>Mode</small><strong>{run.executionMode}</strong></span><span><small>Shield</small><strong>{run.visibilityMode}</strong></span></div>
        <div className="run-actions">
          <button className="secondary-button compact" type="button" onClick={() => setLogsOpen(!logsOpen)}><SquareTerminal size={14} /> Logs</button>
          <button className="stop-button" type="button" onClick={() => setStopConfirmationOpen(true)} disabled={(run.status !== 'running' && run.status !== 'paused') || busy}><OctagonX size={15} /> Stop</button>
          {run.status !== 'reveal-ready' && (
            <button className="reveal-button" type="button" disabled><LockKeyhole size={15} /> Reveal locked</button>
          )}
        </div>
      </section>

      {stopConfirmationOpen && (
        <div className="stop-confirmation-layer">
          <section className="stop-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="stop-confirmation-title" aria-describedby="stop-confirmation-copy">
            <span className="stop-confirmation-glyph" aria-hidden="true"><OctagonX size={22} /></span>
            <div>
              <span className="eyebrow">Permanent cancellation</span>
              <h2 id="stop-confirmation-title">Cancel this battle permanently?</h2>
              <p id="stop-confirmation-copy">The workspace and logs stay on disk, but this battle cannot be resumed. Use Stop only when you want to abandon the current agent session.</p>
            </div>
            <div className="stop-confirmation-actions">
              <button className="secondary-button" type="button" autoFocus onClick={() => setStopConfirmationOpen(false)}>Keep battle running</button>
              <button className="stop-button confirm-stop" type="button" disabled={busy} onClick={() => { setStopConfirmationOpen(false); void stopRun() }}><OctagonX size={15} /> Cancel battle permanently</button>
            </div>
          </section>
        </div>
      )}

      {error && <div className="inline-error dashboard-error" role="alert">{error}</div>}

      {run.status === 'paused' && run.pause && (
        <section className="battle-suspended glass-panel" role="region" aria-labelledby="battle-suspended-title" aria-live="polite">
          <span className="suspended-glyph" aria-hidden="true"><PauseCircle size={22} /></span>
          <div className="suspended-copy">
            <span className="eyebrow">Durable battle checkpoint</span>
            <h2 id="battle-suspended-title">Battle suspended</h2>
            <strong>{pauseReasonLabel(run)}</strong>
            <span className="suspended-code"><small>Support code</small><code>{run.pause.reason}</code></span>
            <p>{run.pause.message}</p>
            {run.pause.action && <p className="suspended-action">{run.pause.action}</p>}
          </div>
          {run.pause.resetAt && (
            <time className="suspended-reset" dateTime={run.pause.resetAt}><TimerReset size={15} />{resetCountdown(run.pause.resetAt, now)}</time>
          )}
          <div className="suspended-actions">
            <button className="secondary-button" type="button" onClick={() => void openRunFolder(run.runId)} disabled={busy}><FolderOpen size={15} /> Open workspace</button>
            <button className="primary-button resume-battle" type="button" onClick={() => void resumeRun(run.runId)} disabled={busy || !run.pause.resumable}><Play size={15} /> Resume battle</button>
          </div>
        </section>
      )}

      {ended && (
        <section className="run-exit-panel glass-panel" aria-live="polite">
          <span className="exit-icon"><CircleAlert size={17} /></span>
          <div>
            <strong>{run.status === 'cancelled' ? 'Build stopped safely.' : 'This build ended early.'}</strong>
            <p>The workspace is preserved. Return to the prompt to revise the request, modes, models, or run limits.</p>
          </div>
          <button className="secondary-button" type="button" onClick={returnToLaunch}><ArrowLeft size={15} /> Back to prompt</button>
        </section>
      )}

      <section className="duel-grid">
        <AgentCard agent="claude" run={run} />
        <BroadcastStage conflict={conflict} run={run} />
        <AgentCard agent="codex" run={run} />
      </section>

      <section className="work-grid">
        <CriticismFeed events={run.events} missionProfile={run.missionProfile} />
        <div className="work-side-stack">
          <EvidenceMomentum run={run} />
          <TaskBoard tasks={run.tasks} phase={run.phase} missions={run.broadcast?.missions} events={run.events} missionProfile={run.missionProfile} />
        </div>
      </section>

      <TerminalDeck events={run.events} open={logsOpen} onToggle={() => setLogsOpen(!logsOpen)} />
      {run.status === 'reveal-ready' && <CompletionTakeover run={run} busy={busy} onReveal={() => void revealRun()} />}
    </main>
  )
}
