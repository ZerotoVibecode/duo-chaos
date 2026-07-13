import type { DuoEvent, DuoTask, RevealPacket } from './types'

function agentName(agent: DuoEvent['agent']): string {
  return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Director'
}

function clip(text: string, maximum = 190): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`
}

function isRecordedAgentEvidence(event: DuoEvent): boolean {
  return (event.type === 'opinion' || event.type === 'agent.dispatch') &&
    (event.agent === 'claude' || event.agent === 'codex') &&
    Boolean(event.publicText.trim())
}

export function buildDramaRecap(events: DuoEvent[], tasks: DuoTask[]): string[] {
  const opinions = events.filter(isRecordedAgentEvidence)
  const recap: string[] = []
  const challenge = opinions.find((event) =>
    event.dispatchKind === 'challenge' ||
    event.dispatchKind === 'counter' ||
    event.topic?.includes('critique') ||
    event.tone === 'skeptical' ||
    event.tone === 'contrarian'
  )
  if (challenge) recap.push(`${agentName(challenge.agent)} opened the first challenge: ${clip(challenge.publicText)}`)

  for (const agent of ['claude', 'codex'] as const) {
    const latest = opinions.filter((event) => event.agent === agent && event.id !== challenge?.id).at(-1)
    if (latest) recap.push(`${agentName(agent)}'s final stance: ${clip(latest.publicText)}`)
  }

  const failed = events.find((event) => event.type === 'build.failed' || event.type === 'repair.started')
  if (failed) recap.push(`The build hit resistance: ${clip(failed.publicText)}`)

  if (tasks.length > 0) {
    const done = tasks.filter((task) => task.status === 'done').length
    recap.push(`The shared board closed ${String(done)}/${String(tasks.length)} tasks across implementation, design, verification, and repair.`)
  }

  if (recap.length < 3 && opinions.length > 0) {
    recap.push(`${String(opinions.length)} public positions survived Spoiler Shield and shaped the final build.`)
  }
  if (recap.length < 3) recap.push('The orchestrator preserved the real run record without inventing agent drama.')
  return [...new Set(recap)].slice(0, 5)
}

export function enrichRevealPacket(packet: RevealPacket, events: DuoEvent[], tasks: DuoTask[]): RevealPacket {
  const latest = (agent: 'claude' | 'codex'): DuoEvent | undefined =>
    events.filter((event) => isRecordedAgentEvidence(event) && event.agent === agent).at(-1)
  const recordedEvidence = events.some(isRecordedAgentEvidence)
  const generated = buildDramaRecap(events, tasks)
  const drama = recordedEvidence
    ? generated
    : packet.agentDramaSummary.length > 0 ? packet.agentDramaSummary : generated
  const claude = latest('claude')
  const codex = latest('codex')
  return {
    ...packet,
    agentDramaSummary: drama,
    agentQuotes: {
      claude: claude ? clip(claude.publicText, 220) : packet.agentQuotes.claude,
      codex: codex ? clip(codex.publicText, 220) : packet.agentQuotes.codex
    }
  }
}
