import { Check, Eye, GitCommitHorizontal, RadioTower, ShieldCheck, Sparkles, UsersRound } from 'lucide-react'
import type { RunSnapshot } from '@shared/types'
import { currentVerificationPassCount } from '@shared/verification-evidence'
import { deriveAgentContribution } from '@renderer/lib/contributions'
import { missionPresentation } from '@renderer/lib/mission-presentation'

interface CompletionTakeoverProps {
  run: RunSnapshot
  busy: boolean
  onReveal: () => void
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function usageLine(run: RunSnapshot, agent: 'claude' | 'codex'): string {
  const usage = run.agentUsage?.[agent]
  if (!usage || usage.calls === 0) return 'No provider report'
  const cost = usage.reportedCostUsd === undefined ? '' : ` · $${usage.reportedCostUsd.toFixed(2)} reported`
  return `${compactNumber.format(usage.processedInputTokens)} processed · ${compactNumber.format(usage.cachedInputTokens)} cached · ${compactNumber.format(usage.outputTokens)} output${cost}`
}

export function CompletionTakeover({ run, busy, onReveal }: CompletionTakeoverProps): React.JSX.Element {
  const labels = missionPresentation(run.missionProfile)
  const tasksDone = run.tasks.filter((task) => task.status === 'done').length
  const checkpoints = run.events.filter((event) => event.type === 'git.checkpoint').length
  const verificationPassed = run.releaseStatus === 'ready' || currentVerificationPassCount(run.events) > 0
  const releaseEvent = run.events.filter((event) => event.type === 'reveal.ready').at(-1)
  const claude = deriveAgentContribution(run, 'claude')
  const codex = deriveAgentContribution(run, 'codex')
  const bothContributed = claude.turns + claude.messages + claude.edits > 0
    && codex.turns + codex.messages + codex.edits > 0
  const partial = run.releaseStatus === 'partial'
  const failed = run.releaseStatus === 'failed'
  const heading = failed
    ? 'Build stopped before full completion.'
    : partial
      ? 'Build reached reveal with caveats.'
      : labels.completion
  const kicker = failed ? 'Diagnostics packet prepared' : partial ? 'Caveats documented' : run.missionProfile === 'serious' ? 'DELIVERY VERIFIED' : 'BUILD SURVIVED'
  const action = failed || partial ? 'Inspect result' : 'Reveal app'

  return (
    <section className={`completion-takeover release-${run.releaseStatus ?? 'ready'}`} role="region" aria-label={heading} aria-live="assertive">
      <div className="completion-grid" aria-hidden="true" />
      <div className="completion-terminal">
        <div className="completion-terminal-bar"><span><i /> FINAL SIGNAL</span><span>DUO/{run.runId.slice(-8).toUpperCase()}</span></div>
        <div className="completion-core">
          <span className="completion-kicker"><RadioTower size={14} /> {kicker}</span>
          <Sparkles className="completion-spark" size={28} aria-hidden="true" />
          <h1>{heading}</h1>
          <p>{releaseEvent?.publicText ?? 'The agents finished the run and sealed the release packet.'}</p>
          <div className="completion-proof" aria-label="Completion proof">
            {run.tasks.length > 0 && <span><Check size={14} />{tasksDone}/{run.tasks.length} tasks complete</span>}
            {verificationPassed && <span><ShieldCheck size={14} />Verification passed</span>}
            {checkpoints > 0 && <span><GitCommitHorizontal size={14} />Final checkpoint recorded</span>}
            {bothContributed && <span><UsersRound size={14} />Both agents on record</span>}
          </div>
          <div className="completion-contribution">
            <span><b>Claude</b>{claude.turns} turns · {claude.edits} edit events · {claude.messages} messages</span>
            <i />
            <span><b>Codex</b>{codex.turns} turns · {codex.edits} edit events · {codex.messages} messages</span>
          </div>
          {run.agentUsage && (
            <div className="completion-usage" aria-label="Provider-reported run usage">
              <span><b>Claude usage</b>{usageLine(run, 'claude')}</span>
              <span><b>Codex usage</b>{usageLine(run, 'codex')}</span>
            </div>
          )}
          <button className="completion-reveal" type="button" disabled={busy} onClick={onReveal}><Eye size={18} /> {action}</button>
        </div>
      </div>
    </section>
  )
}
