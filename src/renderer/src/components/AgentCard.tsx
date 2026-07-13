import { Bot, BrainCircuit, Code2, Gauge, Sparkles } from 'lucide-react'
import type { AgentId, CustomizationProfile, RunSnapshot } from '@shared/types'
import { deriveAgentContribution } from '@renderer/lib/contributions'
import { formatModelLabel, formatRuntimeProfile } from '@renderer/lib/runtime-label'

interface AgentCardProps {
  agent: Extract<AgentId, 'claude' | 'codex'>
  run: RunSnapshot
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function formatTokens(value: number): string {
  return compactNumber.format(Math.max(0, value))
}

function activityLabel(activity: RunSnapshot['events'][number] | undefined): string {
  if (!activity) return 'Working'
  if (activity.category === 'reasoning') return 'Deep reasoning'
  if (activity.category === 'file') return 'Editing workspace'
  if (activity.category === 'error') return 'Resolving failure'
  if (activity.category === 'command') {
    const signal = `${activity.topic ?? ''} ${activity.publicText}`.toLowerCase()
    return /verif|test|check/.test(signal) ? 'Verifying' : 'Running command'
  }
  return 'Working'
}

function effortLabel(effort: string | undefined): string | undefined {
  if (!effort || effort === 'default') return undefined
  if (effort === 'xhigh') return 'Extra High'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

function toolbeltLabel(profile: CustomizationProfile | undefined): string {
  if (profile === 'full-local') return 'Broad · all user skills'
  if (profile === 'smart') return 'Smart · Duo + connected tools'
  return 'Core · no user capabilities'
}

export function AgentCard({ agent, run }: AgentCardProps): React.JSX.Element {
  const agentVoices = run.events.filter((event) => (event.type === 'opinion' || event.type === 'agent.dispatch') && event.agent === agent)
  const latest = agentVoices.at(-1)
  const latestActivity = run.events.filter((event) => event.type === 'agent.activity' && event.agent === agent).at(-1)
  const task = run.tasks.find((item) => item.claimedBy === agent && item.status !== 'done') ?? run.tasks.find((item) => item.claimedBy === agent)
  const mission = run.broadcast?.missions.find((item) => item.agent === agent && item.status === 'active')
    ?? run.broadcast?.missions.find((item) => item.agent === agent && (item.status === 'queued' || item.status === 'drafting'))
  const confidence = latest?.confidence === undefined ? undefined : Math.round(latest.confidence * 100)
  const turnStage = run.turnStage
  const isActive = run.status === 'running' && run.activeAgent === agent
  const timeboxed = turnStage?.agent === agent && turnStage.status === 'timeboxed'
  const name = agent === 'claude' ? 'Claude' : 'Codex'
  const stateLabel = timeboxed
    ? 'Timeboxed'
    : isActive
      ? activityLabel(latestActivity)
      : run.status === 'running'
        ? turnStage?.nextAgent === agent ? 'On deck · next' : 'On deck'
        : 'Standing by'
  const contribution = deriveAgentContribution(run, agent)
  const usage = run.agentUsage?.[agent]
  const runtime = run.agentRuntimes?.[agent]
  const activeRuntime = turnStage?.agent === agent
  const currentEffort = activeRuntime ? effortLabel(turnStage.effort) : undefined
  const qualityCeiling = activeRuntime
    ? effortLabel(turnStage.qualityCeiling ?? runtime?.qualityCeiling)
    : undefined
  const runtimeText = currentEffort
    ? `${formatModelLabel(runtime?.model ?? '')} · ${currentEffort} now${qualityCeiling ? ` · ${qualityCeiling} ceiling` : ''}`
    : formatRuntimeProfile(runtime)
  const customizationProfile = activeRuntime
    ? turnStage.customizationProfile ?? runtime?.customizationProfile
    : runtime?.customizationProfile

  return (
    <article className={`glass-panel agent-card agent-${agent} ${isActive ? 'active' : ''}`} aria-label={`${name} agent`}>
      <div className="agent-head">
        <div className="agent-identity">
          <span className="agent-glyph">{agent === 'claude' ? <Sparkles size={20} /> : <Bot size={20} />}</span>
          <div><span className="eyebrow">Equal agent</span><h2>{name}</h2></div>
        </div>
        <div className="agent-status-stack">
          <span className="agent-runtime" title={runtimeText}>{runtimeText}</span>
          <span className="agent-toolbelt">{toolbeltLabel(customizationProfile)}</span>
          <span className={`agent-state ${isActive ? 'working' : timeboxed ? 'timeboxed' : 'on-deck'}`}><i />{stateLabel}</span>
        </div>
      </div>

      <div className="agent-metrics">
        <div><BrainCircuit size={14} /><span>Tone</span><strong>{latest?.tone?.replace('-', ' ') ?? latest?.dispatchKind?.replace('-', ' ') ?? stateLabel.toLowerCase()}</strong></div>
        <div><Gauge size={14} /><span>Confidence</span><strong>{confidence === undefined ? 'Pending' : `${String(confidence)}%`}</strong></div>
        <div><Code2 size={14} /><span>Messages</span><strong>{contribution.messages}</strong></div>
      </div>
      <div className="confidence-track"><i style={{ width: `${String(confidence ?? 0)}%` }} /></div>

      <div className="agent-stance">
        <span>Current stance</span>
        <p>{latest?.publicText ?? latestActivity?.publicText ?? `${name} has not filed a public position yet.`}</p>
      </div>
      <div className="agent-task"><span>{task ? 'Claim' : 'Next mission'}</span><strong>{task?.publicTitle ?? mission?.label ?? 'Awaiting the next scheduled turn'}</strong></div>
      <div className="agent-contribution" aria-label={`${name} recorded contribution`}>
        <span><b>{contribution.turns}</b> turns</span>
        <span><b>{contribution.messages}</b> messages</span>
        <span><b>{contribution.edits}</b> edit events</span>
        <span><b>{contribution.tasksDone}</b> tasks</span>
      </div>
      <div className="agent-usage" aria-label={`${name} provider-reported token usage`}>
        <span>Provider usage</span>
        {usage && usage.calls > 0 ? (
          <p>
            <b>{formatTokens(usage.processedInputTokens)}</b> processed
            <i>·</i><b>{formatTokens(usage.cachedInputTokens)}</b> cached
            <i>·</i><b>{formatTokens(usage.outputTokens)}</b> output
            <i>·</i><b>{usage.calls}</b> calls
            {usage.reportedCostUsd !== undefined && <><i>·</i><b>${usage.reportedCostUsd.toFixed(2)}</b> reported</>}
          </p>
        ) : <p>Awaiting the first provider report.</p>}
      </div>
    </article>
  )
}
