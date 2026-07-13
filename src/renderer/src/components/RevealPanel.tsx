import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  FolderOpen,
  GitCommitHorizontal,
  ImageOff,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Swords
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ArtifactPreviewResult, RunSnapshot } from '@shared/types'
import { enrichRevealPacket } from '@shared/drama'
import { buildBattleReplay } from '@shared/battle-replay'
import { deriveEvidenceMomentum } from '@renderer/lib/contributions'
import { useStudioStore } from '@renderer/store/studio-store'
import { BattleReplay } from './BattleReplay'
import { EvidenceMomentum } from './EvidenceMomentum'
import { missionPresentation } from '@renderer/lib/mission-presentation'

function uniqueText(values: string[]): string[] {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const normalized = value.trim().replace(/\s+/g, ' ')
    const key = normalized.toLocaleLowerCase()
    if (!normalized || seen.has(key)) return []
    seen.add(key)
    return [normalized]
  })
}

function shippedItems(run: RunSnapshot): string[] {
  const packet = run.revealPacket
  if (!packet) return []

  const completedTasks = run.tasks
    .filter((task) => task.status === 'done')
    .map((task) => task.publicDescription?.trim() || task.publicTitle)
  const candidates = [packet.features, packet.whatWorked, completedTasks]

  for (const candidate of candidates) {
    const items = uniqueText(candidate)
    if (items.length > 0) return items
  }
  return []
}

function formatElapsed(run: RunSnapshot): string {
  const elapsedMs = run.activeTimeMs !== undefined
    ? run.activeTimeMs
    : run.finishedAt
      ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      : Number.NaN
  const seconds = Math.max(0, Math.round(elapsedMs / 1_000))
  if (!Number.isFinite(seconds)) return 'Duration unavailable'
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  if (minutes > 0) return `${String(minutes)}m ${String(remainder)}s`
  return `${String(remainder)}s`
}

function meaningfulQuote(value: string, agent: 'Claude' | 'Codex'): boolean {
  return Boolean(value.trim()) && !new RegExp(`${agent} completed the final turn`, 'i').test(value)
}

function revealedCopy(value: string, appName: string): string {
  return value
    .replace(/\[(?:APP_NAME|PRODUCT_NAME)\]/gi, appName)
    .replace(/\[(?:FEATURE|MECHANIC|INTERACTION)\]/gi, 'signature interaction')
}

export function RevealPanel({ run }: { run: RunSnapshot }): React.JSX.Element {
  const packet = run.revealPacket ? enrichRevealPacket(run.revealPacket, run.events, run.tasks) : undefined
  const shipped = shippedItems(run)
  const replay = buildBattleReplay(run)
  const evidence = deriveEvidenceMomentum(run)
  const labels = missionPresentation(run.missionProfile)
  const { returnToLaunch } = useStudioStore()
  const [copied, setCopied] = useState(false)
  const [launchError, setLaunchError] = useState<string>()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [proofOpen, setProofOpen] = useState(false)
  const [previewState, setPreviewState] = useState<{ runId: string; result: ArtifactPreviewResult }>()
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const preview = previewState?.runId === run.runId ? previewState.result : undefined

  useEffect(() => {
    let active = true
    void window.duo.getArtifactPreview(run.runId).then(
      (result) => { if (active) setPreviewState({ runId: run.runId, result }) },
      () => {
        if (active) {
          setPreviewState({
            runId: run.runId,
            result: {
              status: 'failed',
              reason: 'capture-failed',
              message: 'The generated artifact could not be rendered safely.'
            }
          })
        }
      }
    )
    return () => { active = false }
  }, [previewAttempt, run.runId])

  if (!packet) return <></>

  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(packet.runCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  const retryPreview = (): void => {
    setPreviewState(undefined)
    setPreviewAttempt((attempt) => attempt + 1)
  }

  const openGeneratedApp = async (): Promise<void> => {
    setLaunchError(undefined)
    try {
      await window.duo.openGeneratedApp(run.runId)
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'The generated app could not be opened.')
    }
  }

  const tasksDone = evidence.shared.tasksDone
  const verificationPassed = evidence.shared.buildPasses > 0
  const bothEdited = evidence.agents.claude.edits > 0 && evidence.agents.codex.edits > 0
  const bothCompletedTasks = evidence.agents.claude.tasksDone > 0 && evidence.agents.codex.tasksDone > 0
  const collaborationLabel = bothEdited && bothCompletedTasks
    ? 'Balanced duo contribution'
    : evidence.agents.claude.edits > 0 || evidence.agents.codex.edits > 0
      ? 'Agent handoff recorded'
      : 'Contribution evidence limited'
  const statusLabel = packet.status === 'ready'
    ? 'Verified artifact'
    : packet.status === 'partial'
      ? 'Artifact with caveats'
      : 'Build incomplete'
  const kicker = packet.status === 'ready'
    ? 'The sealed build survived'
    : packet.status === 'partial'
      ? 'A partial build was preserved'
      : 'The run ended with recoverable evidence'
  const survivorEyebrow = packet.status === 'ready' ? 'What survived' : packet.status === 'partial' ? 'What was recovered' : 'Evidence recovered'
  const survivorHeading = packet.status === 'ready'
    ? 'The product they actually shipped'
    : packet.status === 'partial'
      ? 'The usable work they preserved'
      : 'What remains from the run'
  const previewPending = preview === undefined
  const artifactCanOpen = preview?.status === 'ready'
  const primaryActionLabel = previewPending
    ? 'Checking artifact…'
    : preview?.status === 'ready'
      ? packet.status === 'ready'
        ? `Launch ${packet.appName}`
        : `Open ${packet.status === 'partial' ? 'preserved' : 'recovered'} artifact`
      : packet.status === 'ready'
        ? 'Inspect app workspace'
        : packet.status === 'partial'
          ? 'Inspect preserved workspace'
          : 'Inspect failed workspace'

  const openPrimaryAction = (): void => {
    if (artifactCanOpen) void openGeneratedApp()
    else void window.duo.openRunFolder(run.runId)
  }

  return (
    <main className={`reveal-shell mission-${run.missionProfile ?? 'surprise'}`}>
      <div className="reveal-halo" aria-hidden="true"><i /><i /><span /></div>
      <section className="reveal-stage">
        <section className={`artifact-premiere artifact-${packet.status}`} role="region" aria-label="Artifact premiere">
          <div className="artifact-convergence" aria-hidden="true"><i /><i /><span /></div>
          <div className="artifact-copy">
            <span className="reveal-kicker"><Sparkles size={14} /> {kicker}</span>
            <h1 id="artifact-title">{packet.appName}</h1>
            <p className="reveal-idea">{revealedCopy(packet.idea, packet.appName)}</p>
            <p className="reveal-summary">{revealedCopy(packet.summary, packet.appName)}</p>
            {packet.knownIssues.length > 0 && (
              <aside className="artifact-caveats" role="note" aria-label="Release caveats">
                <strong>{packet.status === 'ready' ? 'Known caveat' : 'Why this is not marked ready'}</strong>
                <ul>{packet.knownIssues.slice(0, 3).map((issue) => <li key={issue}>{revealedCopy(issue, packet.appName)}</li>)}</ul>
              </aside>
            )}
          </div>

          <aside className="artifact-proof-rail" aria-label="Artifact proof">
            <div className="artifact-status">
              <span>Status</span>
              <strong><ShieldCheck size={17} />{statusLabel}</strong>
            </div>
            <div className="artifact-proof-list">
              <span><Check size={15} /><b>{tasksDone}/{run.tasks.length}</b> tasks complete</span>
              <span className={verificationPassed ? 'proof-positive' : 'proof-caveat'}><ShieldCheck size={15} />{verificationPassed ? 'Verification passed' : 'Verification not recorded'}</span>
              <span><GitCommitHorizontal size={15} /><b>{evidence.shared.checkpoints}</b> {evidence.shared.checkpoints === 1 ? 'checkpoint' : 'checkpoints'}</span>
              <span><Swords size={15} />{collaborationLabel}</span>
              <span><Clock3 size={15} />{formatElapsed(run)}</span>
            </div>
            <button className="artifact-launch" type="button" disabled={previewPending} onClick={openPrimaryAction}>
              {previewPending
                ? <LoaderCircle className="spin" size={17} />
                : artifactCanOpen ? <Play size={17} fill="currentColor" /> : <FolderOpen size={17} />} {primaryActionLabel}
            </button>
            <button
              className="artifact-details-toggle"
              type="button"
              aria-expanded={detailsOpen}
              aria-label={`${detailsOpen ? 'Close' : 'Open'} run details`}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              Run details <ChevronDown size={15} />
            </button>
          </aside>

        </section>

        <figure className={`artifact-preview artifact-preview-${preview?.status ?? 'loading'}`} aria-label={`${packet.appName} proof of life`}>
          {preview?.status === 'ready' ? (
            <>
              <img src={preview.imageDataUrl} alt={`${packet.appName} artifact preview`} width={preview.width} height={preview.height} />
              <figcaption><ShieldCheck size={14} /> Artifact rendered in an isolated preview</figcaption>
            </>
          ) : preview ? (
            <div className="artifact-preview-empty">
              <ImageOff size={23} />
              <div>
                <strong>Preview unavailable</strong><span>{preview.message}</span>
                {preview.status === 'failed' && preview.reason === 'capture-failed' && (
                  <button
                    className="artifact-preview-retry"
                    type="button"
                    aria-label="Retry artifact preview"
                    onClick={retryPreview}
                  >
                    <RefreshCw size={14} /> Retry preview
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="artifact-preview-empty artifact-preview-loading">
              <LoaderCircle size={23} />
              <div><strong>Rendering proof of life</strong><span>Generated code stays isolated; Studio receives pixels only.</span></div>
            </div>
          )}
        </figure>

        {launchError && <p className="reveal-launch-error" role="alert">{launchError}</p>}

        {detailsOpen && (
          <section className="reveal-run-details" aria-label="Run details">
            <div className="reveal-command">
              <div><span>Run command</span><code>{packet.runCommand}</code></div>
              <button className="icon-button" type="button" aria-label="Copy run command" onClick={() => void copyCommand()}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
            </div>
            <div className="reveal-utility-actions">
              <button className="secondary-button" type="button" onClick={() => void window.duo.openRunFolder(run.runId)}><FolderOpen size={15} /> Open workspace</button>
              {packet.devUrl && <button className="secondary-button" type="button" onClick={() => void window.duo.openExternal(packet.devUrl!)}><ExternalLink size={15} /> Open URL</button>}
            </div>
          </section>
        )}

        <section className="reveal-story-grid" aria-label="Build story">
          <article className="survivor-list">
            <span className="eyebrow">{survivorEyebrow}</span>
            <h2>{survivorHeading}</h2>
            <ul>{shipped.map((feature) => <li key={feature}><Check size={15} />{revealedCopy(feature, packet.appName)}</li>)}</ul>
          </article>
          <article className="drama-recap">
            <span className="eyebrow">The argument that changed it</span>
            <h2>How the build got better</h2>
            <ol>{packet.agentDramaSummary.slice(0, 4).map((item, index) => <li key={item}><b>{String(index + 1).padStart(2, '0')}</b><span>{revealedCopy(item, packet.appName)}</span></li>)}</ol>
          </article>
        </section>

        <BattleReplay scenes={replay} label={labels.replay} />

        <section className={`reveal-proof-disclosure ${proofOpen ? 'is-open' : ''}`} aria-label="Technical proof">
          <button
            type="button"
            aria-expanded={proofOpen}
            aria-label={`${proofOpen ? 'Close' : 'Open'} technical proof`}
            onClick={() => setProofOpen((open) => !open)}
          >
            <span><GitCommitHorizontal size={15} /><b>Technical proof</b></span>
            <small>{tasksDone}/{run.tasks.length} tasks · {verificationPassed ? 'build passed' : 'verification pending'} · {evidence.shared.checkpoints} checkpoint{evidence.shared.checkpoints === 1 ? '' : 's'}</small>
            <ChevronDown size={16} />
          </button>
          {proofOpen && <EvidenceMomentum run={run} variant="receipt" />}
        </section>

        {(meaningfulQuote(packet.agentQuotes.claude, 'Claude') || meaningfulQuote(packet.agentQuotes.codex, 'Codex')) && (
          <section className="after-action-exchange" aria-label="After-action exchange">
            <span className="eyebrow">After-action exchange</span>
            <div>
              {meaningfulQuote(packet.agentQuotes.claude, 'Claude') && <blockquote><span>Claude</span>“{revealedCopy(packet.agentQuotes.claude, packet.appName)}”</blockquote>}
              {meaningfulQuote(packet.agentQuotes.codex, 'Codex') && <blockquote><span>Codex</span>“{revealedCopy(packet.agentQuotes.codex, packet.appName)}”</blockquote>}
            </div>
          </section>
        )}

        <button className="text-button reveal-restart" type="button" onClick={returnToLaunch}><ArrowLeft size={14} /> Start another build</button>
      </section>
    </main>
  )
}
