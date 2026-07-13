import { CheckCircle2, GitCommitHorizontal, Hammer, MessageSquareReply, ShieldCheck, Wrench } from 'lucide-react'
import type { RunSnapshot } from '@shared/types'
import { deriveEvidenceMomentum, type AgentEvidenceMomentum } from '@renderer/lib/contributions'
import './EvidenceMomentum.css'

interface EvidenceMomentumProps {
  run: RunSnapshot
  variant?: 'live' | 'receipt'
}

function quantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${String(value)} ${value === 1 ? singular : plural}`
}

function AgentLane({ agent, evidence }: { agent: 'claude' | 'codex'; evidence: AgentEvidenceMomentum }): React.JSX.Element {
  const name = agent === 'claude' ? 'Claude' : 'Codex'
  return (
    <article className={`momentum-agent momentum-${agent}`} data-testid={`momentum-${agent}`}>
      <div className="momentum-agent-head"><i aria-hidden="true" /><strong>{name}</strong><span>Recorded</span></div>
      <div className="momentum-metrics" aria-label={`${name} recorded evidence`}>
        <span><MessageSquareReply size={12} />{quantity(evidence.challenges, 'challenge')}</span>
        <span aria-label={quantity(evidence.acceptedCalls, 'accepted call')}><ShieldCheck size={12} />{evidence.acceptedCalls} <span className="metric-label-full">accepted {evidence.acceptedCalls === 1 ? 'call' : 'calls'}</span><span className="metric-label-compact">calls</span></span>
        <span><Hammer size={12} />{quantity(evidence.edits, 'edit')}</span>
        <span><CheckCircle2 size={12} />{quantity(evidence.tasksDone, 'task')}</span>
        <span aria-label={quantity(evidence.repairSaves, 'repair save')}><Wrench size={12} />{evidence.repairSaves} <span className="metric-label-full">repair {evidence.repairSaves === 1 ? 'save' : 'saves'}</span><span className="metric-label-compact">saves</span></span>
      </div>
      <p>{evidence.latestMove ?? `${name} has no public move on record yet.`}</p>
    </article>
  )
}

export function EvidenceMomentum({ run, variant = 'live' }: EvidenceMomentumProps): React.JSX.Element {
  const evidence = deriveEvidenceMomentum(run)
  const receipt = variant === 'receipt'
  const heading = receipt ? 'Battle receipt' : 'Evidence momentum'

  return (
    <section className={`glass-panel evidence-momentum evidence-${variant}`} role="region" aria-label={heading}>
      <div className="evidence-heading">
        <div><span className="eyebrow"><GitCommitHorizontal size={13} /> {receipt ? 'Evidence ledger' : 'Live proof'}</span><h2>{heading}</h2></div>
        <span className="evidence-rule">Recorded proof only</span>
      </div>

      <div className="momentum-agents">
        <AgentLane agent="claude" evidence={evidence.agents.claude} />
        <AgentLane agent="codex" evidence={evidence.agents.codex} />
      </div>

      <div className="shared-proof" aria-label="Shared workspace proof">
        <span><b>{evidence.shared.tasksDone}/{evidence.shared.tasksTotal}</b> tasks</span>
        <span><b>{evidence.shared.buildPasses}</b> passed</span>
        <span><b>{evidence.shared.buildFailures}</b> failed</span>
        <span><b>{evidence.shared.checkpoints}</b> {evidence.shared.checkpoints === 1 ? 'checkpoint' : 'checkpoints'}</span>
      </div>
    </section>
  )
}
