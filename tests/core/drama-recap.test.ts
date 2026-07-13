import { describe, expect, it } from 'vitest'
import { enrichRevealPacket } from '../../src/shared/drama'
import type { DuoEvent, DuoTask, RevealPacket } from '../../src/shared/types'

function opinion(id: string, agent: 'claude' | 'codex', round: number, text: string, topic: string): DuoEvent {
  return {
    id,
    type: 'opinion',
    runId: 'run-drama',
    round,
    timestamp: `2026-07-09T23:${String(round).padStart(2, '0')}:00.000Z`,
    agent,
    publicText: text,
    spoilerRisk: 0.05,
    severity: 'medium',
    topic,
    confidence: 0.8,
    heat: 0.7
  }
}

function dispatch(id: string, agent: 'claude' | 'codex', round: number, text: string, kind: 'challenge' | 'counter' | 'verdict'): DuoEvent {
  return {
    ...opinion(id, agent, round, text, 'recorded-exchange'),
    type: 'agent.dispatch',
    dispatchKind: kind,
    targetAgent: agent === 'claude' ? 'codex' : 'claude'
  }
}

describe('reveal drama enrichment', () => {
  it('builds a truthful recap and quotes when the agents leave those fields empty or generic', () => {
    const packet: RevealPacket = {
      appName: 'Revealed App',
      idea: 'A revealed idea.',
      summary: 'A finished result.',
      features: ['One interaction'],
      runCommand: 'npm run dev',
      appPath: 'app',
      status: 'ready',
      whatWorked: [],
      knownIssues: [],
      agentDramaSummary: [],
      gitCheckpoints: ['abc1234 checkpoint'],
      agentQuotes: {
        claude: 'Claude completed the final turn.',
        codex: 'Codex completed the final turn.'
      }
    }
    const events = [
      opinion('c1', 'codex', 3, 'Codex challenged the missing alternative before consensus.', 'critique'),
      opinion('a1', 'claude', 9, 'Claude rejected the suspected defect and found a confirmed contrast failure.', 'review'),
      opinion('c2', 'codex', 11, 'Codex found the keyboard shortcut was blocking a focused control.', 'verification-opinion')
    ]
    const tasks: DuoTask[] = [
      { id: 't1', publicTitle: 'Repair investigation', status: 'done', claimedBy: 'claude', risk: 'high', files: [] },
      { id: 't2', publicTitle: 'Verification pass', status: 'done', claimedBy: 'codex', risk: 'medium', files: [] }
    ]

    const enriched = enrichRevealPacket(packet, events, tasks)

    expect(enriched.agentDramaSummary.length).toBeGreaterThanOrEqual(3)
    expect(enriched.agentDramaSummary.join(' ')).toMatch(/Codex/i)
    expect(enriched.agentDramaSummary.join(' ')).toMatch(/Claude/i)
    expect(enriched.agentDramaSummary.join(' ')).toContain('2/2')
    expect(enriched.agentQuotes.claude).toContain('confirmed contrast failure')
    expect(enriched.agentQuotes.codex).toContain('keyboard shortcut')
  })

  it('replaces reveal-authored drama and quotes with recorded public agent evidence', () => {
    const longPosition = `Claude challenged ${'an overlong public position '.repeat(12)}`
    const packet: RevealPacket = {
      appName: 'Revealed App', idea: 'Revealed idea', summary: 'Done', features: [], runCommand: 'open app', appPath: 'app', status: 'ready',
      whatWorked: [], knownIssues: [], agentDramaSummary: ['Authored moment'], gitCheckpoints: [],
      agentQuotes: { claude: 'Original Claude quote.', codex: 'Original Codex quote.' }
    }
    const events: DuoEvent[] = [
      dispatch('a1', 'claude', 2, longPosition, 'challenge'),
      dispatch('c1', 'codex', 3, 'Codex answered that the smaller runnable boundary had stronger evidence.', 'counter'),
      { ...opinion('failure', 'codex', 3, 'Build pressure rose.', 'repair'), type: 'build.failed' }
    ]

    const enriched = enrichRevealPacket(packet, events, [])
    const clippedChallenge = enriched.agentDramaSummary.find((item) => item.includes('opened the first challenge'))

    expect(enriched.agentDramaSummary).not.toContain('Authored moment')
    expect(enriched.agentDramaSummary.join(' ')).toContain('smaller runnable boundary')
    expect(enriched.agentDramaSummary.join(' ')).toContain('build hit resistance')
    expect(clippedChallenge?.length).toBeLessThan(240)
    expect(enriched.agentQuotes.claude).toContain('overlong public position')
    expect(enriched.agentQuotes.codex).toContain('stronger evidence')
    expect(enriched.agentQuotes.claude).not.toBe(packet.agentQuotes.claude)
    expect(enriched.agentQuotes.codex).not.toBe(packet.agentQuotes.codex)
  })

  it('preserves authored reveal fields as fallbacks when no public agent evidence exists', () => {
    const packet: RevealPacket = {
      appName: 'Revealed App', idea: 'Revealed idea', summary: 'Done', features: [], runCommand: 'open app', appPath: 'app', status: 'ready',
      whatWorked: [], knownIssues: [], agentDramaSummary: ['Authored fallback moment'], gitCheckpoints: [],
      agentQuotes: { claude: 'Claude fallback quote.', codex: 'Codex fallback quote.' }
    }

    const enriched = enrichRevealPacket(packet, [], [])

    expect(enriched.agentDramaSummary).toEqual(['Authored fallback moment'])
    expect(enriched.agentQuotes).toEqual(packet.agentQuotes)
  })

  it('uses an honest fallback when no opinions or tasks exist', () => {
    const packet: RevealPacket = {
      appName: 'Partial App', idea: 'Partial', summary: 'Partial', features: [], runCommand: 'inspect', appPath: 'app', status: 'partial',
      whatWorked: [], knownIssues: [], agentDramaSummary: [], gitCheckpoints: [], agentQuotes: { claude: '', codex: '' }
    }

    const enriched = enrichRevealPacket(packet, [], [])

    expect(enriched.agentDramaSummary).toEqual(['The orchestrator preserved the real run record without inventing agent drama.'])
    expect(enriched.agentQuotes).toEqual({ claude: '', codex: '' })
  })
})
