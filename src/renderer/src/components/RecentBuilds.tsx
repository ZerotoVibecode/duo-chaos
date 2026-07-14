import { Bot, Check, CircleAlert, Clock3, Eye, FolderClock, FolderOpen, GitCommitHorizontal, PauseCircle, Play, RotateCcw, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import type { RecentBuildSummary } from '@shared/types'

interface RecentBuildsProps {
  builds: RecentBuildSummary[]
  onRecover: (build: RecentBuildSummary) => void
  onResume?: (build: RecentBuildSummary) => void
  onOpen?: (build: RecentBuildSummary) => void
  onReveal?: (build: RecentBuildSummary) => void
  onOpenApp?: (build: RecentBuildSummary) => void
}

function statusLabel(build: RecentBuildSummary): string {
  if (build.status === 'complete' && build.releaseStatus === 'partial') return 'Partial · revealed'
  if (build.status === 'complete' && build.releaseStatus === 'failed') return 'Failed · revealed'
  if (build.status === 'complete') return 'Complete'
  const status = build.status
  if (status === 'paused') return build.pauseReason === 'quality-repair' ? 'Quality repair ready' : 'Paused'
  if (status === 'reveal-ready') return 'Ready · sealed'
  if (status === 'interrupted') return 'Interrupted'
  if (status === 'cancelled') return 'Cancelled'
  return 'Needs attention'
}

function displayDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function providerProof(build: RecentBuildSummary): { label: string; title: string; live: boolean } {
  if (build.executionMode === 'simulation') {
    return { label: 'Simulation', title: 'Created without live AI CLIs', live: false }
  }
  const recordedActivity = build.proof.claude.turns + build.proof.claude.messages + build.proof.claude.edits +
    build.proof.codex.turns + build.proof.codex.messages + build.proof.codex.edits
  return recordedActivity > 0
    ? { label: 'Real CLI', title: 'Recorded activity from local AI CLIs', live: true }
    : { label: 'No CLI calls', title: 'Configured for Real Mode but no provider activity was recorded', live: false }
}

export function RecentBuilds({ builds, onRecover, onResume, onOpen, onReveal, onOpenApp }: RecentBuildsProps): React.JSX.Element {
  return (
    <section className="glass-panel recent-builds" role="region" aria-label="Recent builds">
      <div className="recent-builds-heading">
        <div><span className="eyebrow"><FolderClock size={13} /> Local archive</span><h2>Recent builds</h2></div>
        <span>{builds.length} saved</span>
      </div>
      {builds.length === 0 ? (
        <div className="recent-build-empty"><Clock3 size={17} /><span>Your first finished or interrupted run will appear here.</span></div>
      ) : (
        <div className="recent-build-list">
          {builds.map((build) => {
            const provider = providerProof(build)
            const buildName = build.appName ?? 'sealed build'
            const verificationPassed = build.releaseStatus === 'ready' || build.proof.buildPasses > 0
            return (
            <article className={`recent-build-card recent-${build.status}${build.status === 'complete' && build.releaseStatus && build.releaseStatus !== 'ready' ? ` recent-release-${build.releaseStatus}` : ''}`} data-testid={`recent-build-${build.runId}`} key={build.runId}>
              <div className="recent-build-topline">
                <span className="recent-build-status">
                  {build.status === 'complete' && (!build.releaseStatus || build.releaseStatus === 'ready') ? <ShieldCheck size={12} /> : build.status === 'paused' ? <PauseCircle size={12} /> : <CircleAlert size={12} />}
                  {statusLabel(build)}
                </span>
                <time dateTime={build.startedAt}>{displayDate(build.startedAt)}</time>
              </div>
              <div className="recent-build-title">
                <strong>{build.appName ?? 'Sealed build'}</strong>
                <span>{build.status === 'paused' && build.pauseReason === 'quality-repair' ? 'Partial artifact sealed · repair can resume' : build.status === 'paused' && build.resumable ? 'Battle checkpoint preserved' : build.recoverable ? 'Workspace preserved · safe to recover' : build.sealed ? 'Idea remains private' : 'Reveal unlocked'}</span>
              </div>
              <div className="recent-proof-row" aria-label="Recorded build proof">
                <span title={provider.title}>
                  {provider.live ? <Bot size={11} /> : <Sparkles size={11} />}
                  {provider.label}
                </span>
                {build.proof.tasksTotal > 0 && <span><Check size={11} />{build.proof.tasksDone}/{build.proof.tasksTotal} tasks</span>}
                {build.proof.checkpoints > 0 && <span><GitCommitHorizontal size={11} />{build.proof.checkpoints} checkpoint{build.proof.checkpoints === 1 ? '' : 's'}</span>}
                {verificationPassed && <span><Wrench size={11} />verified</span>}
              </div>
              <div className="recent-contribution" aria-label="Recorded agent contribution">
                <span><b>Claude</b> {build.proof.claude.turns} turns · {build.proof.claude.edits} edit events · {build.proof.claude.messages} messages</span>
                <span><b>Codex</b> {build.proof.codex.turns} turns · {build.proof.codex.edits} edit events · {build.proof.codex.messages} messages</span>
              </div>
              {build.status === 'paused' && build.resumable && onResume ? (
                <button className="recent-recover recent-resume" type="button" aria-label={`Resume battle for ${buildName}`} onClick={() => onResume(build)}><Play size={13} /> Resume battle</button>
              ) : build.status === 'complete' && (onReveal || onOpenApp || onOpen) ? (
                <div className="recent-build-actions">
                  {onReveal && <button className="recent-recover recent-reveal" type="button" aria-label={`View reveal for ${buildName}`} onClick={() => onReveal(build)}><Eye size={13} /> View reveal</button>}
                  {onOpenApp && <button className="recent-recover recent-open-app" type="button" aria-label={`Open app for ${buildName}`} onClick={() => onOpenApp(build)}><Play size={13} /> Open app</button>}
                  {onOpen && <button className="recent-folder-action" type="button" title="Open workspace" aria-label={`Open workspace for ${buildName}`} onClick={() => onOpen(build)}><FolderOpen size={13} /></button>}
                </div>
              ) : build.recoverable && (
                <button className="recent-recover" type="button" aria-label={`Use prompt again for ${buildName}`} onClick={() => onRecover(build)}><RotateCcw size={13} /> Use prompt again</button>
              )}
            </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
