import { describe, expect, it } from 'vitest'
import { buildSimulationScript } from '../../src/main/orchestrator/simulation-script'

describe('simulation script', () => {
  it('contains the complete chaos arc and equal agent participation', () => {
    const script = buildSimulationScript('sim-1', 'Make something delightful')
    const eventTypes = script.map((step) => step.event.type)
    const opinionAgents = script
      .filter((step) => step.event.type === 'opinion')
      .map((step) => step.event.agent)

    expect(eventTypes).toContain('conflict')
    expect(eventTypes).toContain('build.failed')
    expect(eventTypes).toContain('repair.completed')
    expect(eventTypes.at(-1)).toBe('reveal.ready')
    expect(opinionAgents).toContain('claude')
    expect(opinionAgents).toContain('codex')
  })

  it('never leaks the sealed simulation name before reveal', () => {
    const script = buildSimulationScript('sim-2', 'Build a surprise')
    const beforeReveal = script.filter((step) => step.event.type !== 'reveal.ready')
    expect(beforeReveal.every((step) => !step.event.publicText.includes('Afterglow Atlas'))).toBe(true)
  })

  it('labels phase and agent-start events so the dashboard reports the real simulation stage', () => {
    const script = buildSimulationScript('sim-3', 'Build a surprise')
    const phaseEvents = script.filter((step) => step.event.type === 'phase.changed')
    const agentStarts = script.filter((step) => step.event.type === 'agent.started')

    expect(phaseEvents.map((step) => step.event.metadata?.phase)).toEqual([
      'round.pitch',
      'round.critique',
      'round.tasking'
    ])
    expect(agentStarts.map((step) => step.event.metadata?.phase)).toEqual([
      'round.code',
      'round.code'
    ])
  })

  it('finishes both agent tasks before the eight-turn reveal', () => {
    const script = buildSimulationScript('sim-4', 'Build a surprise')
    const completed = script
      .filter((step) => step.event.type === 'task.updated' && step.event.task?.status === 'done')
      .map((step) => step.event.task?.claimedBy)

    expect(completed).toEqual(expect.arrayContaining(['claude', 'codex']))
    expect(Math.max(...script.map((step) => step.event.round))).toBe(8)
  })

  it('labels a serious-profile rehearsal without pretending the requested product may be replaced', () => {
    const seriousScript = (buildSimulationScript as unknown as (
      runId: string,
      prompt: string,
      missionProfile: 'serious'
    ) => ReturnType<typeof buildSimulationScript>)('sim-serious', 'Build a specified accessibility checker.', 'serious')

    expect(seriousScript[0]?.event.publicText).toMatch(/serious brief|serious mission/i)
    expect(seriousScript[0]?.event.metadata).toMatchObject({ missionProfile: 'serious' })
    const reveal = seriousScript.at(-1)?.event
    expect(reveal?.revealPacket).toMatchObject({ status: 'partial' })
    expect(reveal?.revealPacket?.knownIssues.join(' ')).toMatch(/real mode.*brief/i)
  })
})
