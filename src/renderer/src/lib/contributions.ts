import type { AgentContributionSummary, AgentId, DuoEvent, RunSnapshot } from '@shared/types'
import { releaseVerificationPassCount, verificationFailureCount } from '@shared/verification-evidence'

type BuildAgent = Extract<AgentId, 'claude' | 'codex'>

export interface AgentEvidenceMomentum {
  challenges: number
  acceptedCalls: number
  edits: number
  tasksDone: number
  repairSaves: number
  latestMove?: string
}

export interface EvidenceMomentumSnapshot {
  agents: Record<BuildAgent, AgentEvidenceMomentum>
  shared: {
    tasksDone: number
    tasksTotal: number
    buildPasses: number
    buildFailures: number
    checkpoints: number
  }
}

function isEditEvidenceEvent(event: DuoEvent): boolean {
  return event.type === 'file.changed'
    || ((event.type === 'agent.activity' || event.type === 'cli.log') && event.category === 'file')
}

function isChallengeEvent(event: DuoEvent): boolean {
  return event.type === 'conflict'
    || event.dispatchKind === 'challenge'
    || event.dispatchKind === 'counter'
}

function deriveAgentEvidence(run: RunSnapshot, agent: BuildAgent): AgentEvidenceMomentum {
  const latestMove = run.events
    .filter((event) => event.agent === agent && event.publicText.trim().length > 0)
    .at(-1)?.publicText.trim()

  return {
    challenges: run.events.filter((event) => event.agent === agent && isChallengeEvent(event)).length,
    acceptedCalls: run.events.filter((event) => event.type === 'decision' && event.winner === agent).length,
    edits: run.events.filter((event) => event.agent === agent && isEditEvidenceEvent(event)).length,
    tasksDone: run.tasks.filter((task) => task.status === 'done' && (task.claimedBy === agent || task.claimedBy === 'both')).length,
    repairSaves: run.events.filter((event) => event.agent === agent && event.type === 'repair.completed').length,
    ...(latestMove ? { latestMove } : {})
  }
}

export function deriveEvidenceMomentum(run: RunSnapshot): EvidenceMomentumSnapshot {
  return {
    agents: {
      claude: deriveAgentEvidence(run, 'claude'),
      codex: deriveAgentEvidence(run, 'codex')
    },
    shared: {
      tasksDone: run.tasks.filter((task) => task.status === 'done').length,
      tasksTotal: run.tasks.length,
      buildPasses: releaseVerificationPassCount(run.events, run.releaseStatus),
      buildFailures: verificationFailureCount(run.events),
      checkpoints: run.events.filter((event) => event.type === 'git.checkpoint').length
    }
  }
}

export function deriveAgentContribution(
  run: RunSnapshot,
  agent: BuildAgent
): AgentContributionSummary {
  return {
    turns: run.events.filter((event) => event.agent === agent && event.type === 'agent.started').length,
    edits: run.events.filter((event) => event.agent === agent && isEditEvidenceEvent(event)).length,
    messages: run.events.filter((event) => event.agent === agent && (
      event.type === 'agent.dispatch' || event.type === 'opinion'
    )).length,
    tasksDone: run.tasks.filter((task) => task.claimedBy === agent && task.status === 'done').length
  }
}
