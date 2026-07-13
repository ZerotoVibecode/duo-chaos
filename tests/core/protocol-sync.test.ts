import { describe, expect, it } from 'vitest'
import { normalizeBoard, parseProtocolJsonl } from '../../src/main/orchestrator/protocol-sync'

describe('real workspace protocol synchronization', () => {
  it('parses real-run opinion aliases with stable ids across repeated polls', () => {
    const content = [
      JSON.stringify({ agent: 'codex', round: 2, type: 'product-opinion', publicText: 'Codex backs the smaller [FEATURE].' }),
      JSON.stringify({ agent: 'claude', round: 8, type: 'implementation-opinion', publicText: 'Claude wants another verification pass.' })
    ].join('\n')
    const context = { runId: 'run-replay', round: 8, sourceKey: 'public/opinions.jsonl' }

    const first = parseProtocolJsonl(content, context)
    const second = parseProtocolJsonl(content, context)

    expect(first.map((event) => event.type)).toEqual(['opinion', 'opinion'])
    expect(first.map((event) => event.id)).toEqual(second.map((event) => event.id))
    expect(new Set(first.map((event) => event.id)).size).toBe(2)
    expect(first.every((event) => event.metadata?.protocolOrigin === 'workspace-public-protocol')).toBe(true)
    expect(first.every((event) => event.metadata?.protocolSourceKey === 'public/opinions.jsonl')).toBe(true)
  })

  it('owns the protocol provenance marker even when an agent tries to override it', () => {
    const [event] = parseProtocolJsonl(JSON.stringify({
      type: 'agent.dispatch',
      agent: 'codex',
      publicText: 'Codex filed a public handoff.',
      protocolOrigin: 'trusted-supervisor'
    }), { runId: 'run-origin', round: 3, sourceKey: 'public/dispatches.jsonl' })

    expect(event?.metadata).toMatchObject({
      protocolOrigin: 'workspace-public-protocol',
      protocolSourceKey: 'public/dispatches.jsonl'
    })
  })

  it('normalizes the loose board produced by the completed run without leaking private task nouns', () => {
    const tasks = normalizeBoard({
      tasks: [
        {
          id: 'repair-1',
          type: 'repair',
          title: 'Fix the secret orb overshoot',
          description: 'Inspect app/secret-orb.html.',
          file: 'app/secret-orb.html',
          status: 'closed-no-defect',
          claimedBy: 'claude'
        },
        {
          id: 'verify-1',
          type: 'verification',
          title: 'Keyboard pass',
          status: 'in_progress',
          claimedBy: 'codex'
        }
      ]
    })

    expect(tasks).toEqual([
      expect.objectContaining({
        id: 'repair-1',
        publicTitle: 'Repair investigation',
        privateTitle: 'Fix the secret orb overshoot',
        status: 'done',
        claimedBy: 'claude',
        files: ['[WORKSPACE_FILE]'],
        privateFiles: ['app/secret-orb.html']
      }),
      expect.objectContaining({
        id: 'verify-1',
        publicTitle: 'Verification pass',
        status: 'in-progress',
        claimedBy: 'codex'
      })
    ])
    const publicTasks = tasks.map((task) => ({
      id: task.id,
      publicTitle: task.publicTitle,
      publicDescription: task.publicDescription,
      status: task.status,
      claimedBy: task.claimedBy,
      risk: task.risk,
      files: task.files
    }))
    expect(JSON.stringify(publicTasks)).not.toContain('secret')
  })

  it('recognizes owner and summary aliases from compact agent boards', () => {
    const tasks = normalizeBoard({ tasks: [
      { id: 'claude-atmosphere', owner: 'claude', status: 'done', sourceScope: 'app/index.html', summary: 'Added a twinkling starfield.' },
      { id: 'codex-controls', owner: 'codex', status: 'done', sourceScope: 'app/index.html', summary: 'Added reset controls.' }
    ] })

    expect(tasks).toEqual([
      expect.objectContaining({ id: 'claude-atmosphere', claimedBy: 'claude', privateDescription: 'Added a twinkling starfield.', privateFiles: ['app/index.html'] }),
      expect.objectContaining({ id: 'codex-controls', claimedBy: 'codex', privateDescription: 'Added reset controls.', privateFiles: ['app/index.html'] })
    ])
  })

  it('tolerates partial JSONL and normalizes the supported loose-board variants', () => {
    const parsed = parseProtocolJsonl([
      '{"incomplete":',
      '42',
      JSON.stringify({ id: 'kept-id', type: 'critique', agent: 'claude', publicText: 'Claude filed a challenge.' })
    ].join('\n'), { runId: 'run-edge', round: 4, sourceKey: 'public/opinions.jsonl' })

    expect(parsed).toHaveLength(2)
    expect(parsed.at(-1)?.id).toBe('kept-id')
    expect(normalizeBoard(null)).toEqual([])

    const tasks = normalizeBoard({
      tasks: [
        null,
        { title: 'Fix a hidden issue', status: 'working', claimedBy: null, files: ['a.ts', '', 3], risk: 'low' },
        { publicTitle: 'Public verification', privateTitle: 'Verify the hidden loop', publicDescription: 'Safe check', privateDescription: 'Private check', title: 'Check the build', status: 'claimed', claimedBy: 'both', risk: 'medium' },
        { title: 'Copy and UX pass', status: 'review', claimedBy: 'director', risk: 'high' },
        { title: 'Ordinary work', status: 'blocked', claimedBy: 'none' },
        { type: 'implementation', status: 'open', claimedBy: 'invalid' },
        { type: 'design', status: 'unknown', claimedBy: 'claude' }
      ]
    })

    expect(tasks).toHaveLength(7)
    expect(tasks.map((task) => task.status)).toEqual(['open', 'in-progress', 'claimed', 'review', 'blocked', 'open', 'open'])
    expect(tasks.map((task) => task.publicTitle)).toEqual([
      '[FEATURE] implementation',
      'Repair investigation',
      'Public verification',
      'Design challenge',
      '[FEATURE] implementation',
      '[FEATURE] implementation',
      'Design challenge'
    ])
    expect(tasks[0]?.id).toBe('task-1')
    expect(tasks[1]).toMatchObject({ claimedBy: 'none', privateFiles: ['a.ts'], files: ['[WORKSPACE_FILE]'], risk: 'low' })
    expect(tasks[2]).toMatchObject({ publicDescription: 'Safe check', privateDescription: 'Private check', claimedBy: 'both' })
    expect(tasks[3]?.claimedBy).toBe('director')
    expect(tasks[4]?.claimedBy).toBe('none')
    expect(tasks[5]?.claimedBy).toBeUndefined()
  })
})
