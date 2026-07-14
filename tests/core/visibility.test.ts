import { describe, expect, it } from 'vitest'
import { buildRedactionTerms } from '../../src/main/security/redaction'
import { projectEventForRenderer, projectTaskForRenderer } from '../../src/main/security/visibility'
import type { DuoEvent } from '../../src/shared/types'

const opinion: DuoEvent = {
  id: 'op-1',
  type: 'opinion',
  runId: 'run-1',
  round: 2,
  timestamp: '2026-07-09T12:00:00.000Z',
  agent: 'claude',
  targetAgent: 'codex',
  publicText: 'Claude thinks the Nebula Pantry interaction is overbuilt.',
  privateText: 'Claude dislikes the Nebula Pantry pantry duel.',
  spoilerRisk: 0.9,
  severity: 'high',
  metadata: { raw: 'Nebula Pantry should never cross IPC.' }
}

describe('renderer visibility projection', () => {
  const terms = buildRedactionTerms([{ value: 'Nebula Pantry', label: 'APP_NAME' }])

  it('reduces Blind mode to generic progress and strips private fields', () => {
    const projected = projectEventForRenderer(opinion, 'blind', false, terms)
    expect(projected.publicText).toBe('Claude registered a high-heat opinion.')
    expect(projected.privateText).toBeUndefined()
    expect(projected.metadata).toBeUndefined()
  })

  it('redacts Spoiler Shield text and strips private data before reveal', () => {
    const projected = projectEventForRenderer(opinion, 'spoiler-shield', false, terms)
    expect(projected.publicText).toBe('Claude thinks the [APP_NAME] interaction is overbuilt.')
    expect(JSON.stringify(projected)).not.toContain('pantry duel')
    expect(projected.rawAvailable).toBe(true)
  })

  it('redacts punctuation variants and short titles before an event reaches the renderer', () => {
    const variantTerms = buildRedactionTerms([
      { value: 'Signal Garden', label: 'APP_NAME' },
      { value: 'XY', label: 'APP_NAME' }
    ])
    const projected = projectEventForRenderer({
      ...opinion,
      publicText: 'Signal.Garden challenged Signal/Garden before Signal—Garden yielded to XY.',
      spoilerRisk: 0.2
    }, 'spoiler-shield', false, variantTerms)

    expect(projected.publicText).toBe(
      '[APP_NAME] challenged [APP_NAME] before [APP_NAME] yielded to [APP_NAME].'
    )
  })

  it('keeps a public agent dispatch exact while sealing its private counterpart', () => {
    const projected = projectEventForRenderer({
      ...opinion,
      id: 'dispatch-1',
      type: 'agent.dispatch',
      dispatchKind: 'challenge',
      claimKey: 'scope',
      publicText: 'Claude says the [FEATURE] is carrying too much scope.',
      privateText: 'Claude says the Nebula Pantry duel is carrying too much scope.',
      spoilerRisk: 0.05
    }, 'spoiler-shield', false, terms)

    expect(projected.publicText).toBe('Claude says the [FEATURE] is carrying too much scope.')
    expect(projected.privateText).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain('Nebula Pantry duel')
  })

  it('quarantines concrete agent-authored protocol speech even when the agent claims zero spoiler risk', () => {
    const projected = projectEventForRenderer({
      ...opinion,
      id: 'staged-dispatch-leak',
      type: 'agent.dispatch',
      agent: 'codex',
      targetAgent: 'claude',
      dispatchKind: 'evidence',
      publicText: 'The blue emoji button unlocks after exactly seven clicks.',
      privateText: 'The blue emoji button unlocks after exactly seven clicks.',
      spoilerRisk: 0,
      metadata: {
        protocolOrigin: 'workspace-public-protocol',
        protocolSourceKey: 'public/dispatches.jsonl'
      }
    }, 'spoiler-shield', false, terms)

    expect(projected.publicText).toBe('Codex handed Claude spoiler-sealed build evidence.')
    expect(projected.publicText).not.toMatch(/blue|emoji|button|seven|click/iu)
    expect(projected.privateText).toBeUndefined()
    expect(projected.metadata).toBeUndefined()
  })

  it('keeps masked and genuinely dictionary-redacted agent protocol arguments visible', () => {
    const protocolMetadata = {
      protocolOrigin: 'workspace-public-protocol',
      protocolSourceKey: 'public/opinions.jsonl'
    }
    const masked = projectEventForRenderer({
      ...opinion,
      id: 'masked-protocol-opinion',
      publicText: 'Claude thinks the [FEATURE] needs a clearer completion state.',
      spoilerRisk: 0,
      metadata: protocolMetadata
    }, 'spoiler-shield', false, terms)
    const dictionaryRedacted = projectEventForRenderer({
      ...opinion,
      id: 'dictionary-protocol-opinion',
      publicText: 'Claude thinks Nebula Pantry needs a clearer completion state.',
      spoilerRisk: 0,
      metadata: protocolMetadata
    }, 'spoiler-shield', false, terms)

    expect(masked.publicText).toBe('Claude thinks the [FEATURE] needs a clearer completion state.')
    expect(dictionaryRedacted.publicText).toBe('Claude thinks [APP_NAME] needs a clearer completion state.')
  })

  it('keeps public protocol speech in Full Chaos and after reveal without forwarding provider-private fields', () => {
    const staged = {
      ...opinion,
      id: 'staged-full-chaos',
      type: 'agent.dispatch' as const,
      dispatchKind: 'counter' as const,
      publicText: 'The emoji button responds after seven clicks.',
      privateText: 'The private emoji button responds after seven clicks.',
      spoilerRisk: 0,
      metadata: {
        protocolOrigin: 'workspace-public-protocol',
        protocolSourceKey: 'public/dispatches.jsonl'
      }
    }

    expect(projectEventForRenderer(staged, 'full-chaos', false, terms).publicText)
      .toBe('The emoji button responds after seven clicks.')
    expect(projectEventForRenderer(staged, 'spoiler-shield', true, terms).publicText)
      .toBe('The emoji button responds after seven clicks.')
    expect(projectEventForRenderer(staged, 'full-chaos', false, terms).privateText).toBeUndefined()
    expect(projectEventForRenderer(staged, 'spoiler-shield', true, terms).metadata).toBeUndefined()
  })

  it('never forwards provider-private details after reveal', () => {
    const projected = projectEventForRenderer(opinion, 'spoiler-shield', true, terms)
    expect(projected.privateText).toBeUndefined()
    expect(projected.metadata).toBeUndefined()
    expect(projected.revealPacket).toBeUndefined()
  })

  it('forwards only supervisor-authored bounded quality proof across IPC', () => {
    const supervisor = projectEventForRenderer({
      ...opinion,
      id: 'quality-proof',
      type: 'decision',
      agent: 'director',
      topic: 'quality-evidence-state',
      publicText: 'Current-revision quality proof refreshed.',
      proof: {
        kind: 'quality-state', revision: 2,
        acceptedContributionAgents: ['claude', 'codex'], acceptedReviewAgents: ['claude']
      }
    }, 'spoiler-shield', false, terms)
    const forged = projectEventForRenderer({
      ...opinion,
      id: 'forged-quality-proof',
      topic: 'quality-evidence-state',
      proof: { kind: 'quality-state', revision: 99, acceptedContributionAgents: ['claude'] },
      metadata: { protocolOrigin: 'workspace-public-protocol' }
    }, 'spoiler-shield', false, terms)

    expect(supervisor.proof).toMatchObject({ kind: 'quality-state', revision: 2 })
    expect(forged.proof).toBeUndefined()
  })

  it('uses spoiler-full public speech rather than raw provider detail in Full Chaos mode', () => {
    const projected = projectEventForRenderer(opinion, 'full-chaos', false, terms)
    expect(projected.publicText).toBe('Claude thinks the Nebula Pantry interaction is overbuilt.')
    expect(projected.privateText).toBeUndefined()
    expect(projected.metadata).toBeUndefined()
    expect(projected.privateTopic).toBeUndefined()
  })

  it('keeps arbitrary MCP/plugin payload secrets and capability inventory out of renderer IPC', () => {
    const sensitive = {
      ...opinion,
      id: 'provider-payload',
      type: 'cli.log' as const,
      publicText: 'Claude completed a private capability call.',
      privateText: JSON.stringify({
        server: 'private-company-mcp',
        tool: 'read_customer_records',
        input: { apiKey: 'not-a-real-key', cookie: 'session=secret' },
        result: { accessToken: 'not-a-real-token', signedUrl: 'https://example.invalid/?sig=secret' }
      }),
      metadata: {
        plugin: 'private-company-plugin',
        toolInput: { password: 'not-a-real-password' },
        toolResult: { jwt: 'not-a-real-jwt' }
      }
    }

    for (const mode of ['blind', 'spoiler-shield', 'full-chaos'] as const) {
      for (const revealed of [false, true]) {
        const projected = projectEventForRenderer(sensitive, mode, revealed, [])
        const serialized = JSON.stringify(projected)
        expect(projected.privateText).toBeUndefined()
        expect(projected.metadata).toBeUndefined()
        expect(serialized).not.toMatch(/private-company|apiKey|cookie|accessToken|signedUrl|password|jwt|secret/iu)
      }
    }
  })

  it('never exposes a reveal packet or private task structure through Full Chaos before reveal', () => {
    const projected = projectEventForRenderer({
      ...opinion,
      type: 'reveal.ready',
      privateTopic: 'sealed-topic',
      task: {
        id: 'task-private', publicTitle: 'Build the [FEATURE]', privateTitle: 'Build the pantry duel',
        publicDescription: 'A spoiler-safe task.', privateDescription: 'Secret implementation details.',
        privateExpectedOutcome: 'The pantry duel reaches its hidden completion state.',
        privateAcceptanceChecks: ['The blue pantry button reaches the seven-click ending.'],
        impact: 'core',
        status: 'done', risk: 'medium', files: ['app/index.html'], privateFiles: ['app/secret-pantry.ts']
      },
      revealPacket: {
        appName: 'Nebula Pantry', idea: 'A pantry duel app', summary: 'Hidden', features: [],
        runCommand: 'npm run dev', appPath: 'app', status: 'ready', whatWorked: [], knownIssues: [],
        agentDramaSummary: [], gitCheckpoints: [], agentQuotes: { claude: '', codex: '' }
      }
    }, 'full-chaos', false, terms)

    expect(projected.publicText).toBe(opinion.publicText)
    expect(projected.revealPacket).toBeUndefined()
    expect(projected.privateText).toBeUndefined()
    expect(projected.privateTopic).toBeUndefined()
    expect(projected.task?.privateTitle).toBeUndefined()
    expect(projected.task?.privateDescription).toBeUndefined()
    expect(projected.task?.privateFiles).toBeUndefined()
    expect(projected.task?.privateExpectedOutcome).toBeUndefined()
    expect(projected.task?.privateAcceptanceChecks).toBeUndefined()
    expect(JSON.stringify(projected)).not.toMatch(/seven-click|completion state/iu)
  })

  it('removes reveal packets and private task titles before reveal', () => {
    const projected = projectEventForRenderer(
      {
        ...opinion,
        type: 'reveal.ready',
        task: {
          id: 'task-1',
          publicTitle: 'Build the [FEATURE]',
          privateTitle: 'Build the pantry duel',
          status: 'done',
          risk: 'medium',
          files: []
        },
        revealPacket: {
          appName: 'Nebula Pantry',
          idea: 'A pantry duel app',
          summary: 'Hidden',
          features: [],
          runCommand: 'npm run dev',
          appPath: 'app',
          status: 'ready',
          whatWorked: [],
          knownIssues: [],
          agentDramaSummary: [],
          gitCheckpoints: [],
          agentQuotes: { claude: '', codex: '' }
        }
      },
      'spoiler-shield',
      false,
      terms
    )

    expect(projected.revealPacket).toBeUndefined()
    expect(projected.task?.privateTitle).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain('pantry duel')
  })

  it('quarantines concrete board titles and descriptions even when an agent claims zero spoiler risk', () => {
    const concreteTask = {
      id: 'task-concrete-leak',
      publicTitle: 'Build the Nebula Pantry duel',
      publicDescription: 'Add the blue pantry button and seven-click ending.',
      status: 'in-progress' as const,
      claimedBy: 'claude' as const,
      risk: 'medium' as const,
      files: ['app/nebula-pantry.ts']
    }
    const projected = projectEventForRenderer({
      ...opinion,
      id: 'task-event-concrete-leak',
      type: 'task.updated',
      publicText: 'Nebula Pantry duel moved to in-progress.',
      spoilerRisk: 0,
      task: concreteTask
    }, 'spoiler-shield', false, [])
    const projectedBoardTask = projectTaskForRenderer(concreteTask, 'spoiler-shield', false, [])

    expect(projected.publicText).toBe('A spoiler-sealed shared task changed state.')
    expect(projected.task?.publicTitle).toBe('Spoiler-sealed shared task')
    expect(projected.task?.publicDescription).toBe('Task details stay sealed until reveal.')
    expect(projected.task?.files).toEqual(['[WORKSPACE_FILE]'])
    expect(projectedBoardTask).toEqual(projected.task)
    expect(JSON.stringify({ projected, projectedBoardTask })).not.toMatch(/Nebula|Pantry|blue|seven|click/iu)
  })

  it('keeps placeholder-masked or genuinely dictionary-redacted board fields useful', () => {
    const maskedTask = {
      id: 'task-masked',
      publicTitle: 'Build the [FEATURE]',
      publicDescription: 'Verify the [CORE_MECHANIC] completion state.',
      status: 'open' as const,
      risk: 'medium' as const,
      files: ['[WORKSPACE_FILE]']
    }
    const dictionaryTask = {
      ...maskedTask,
      id: 'task-dictionary',
      publicTitle: 'Build the Nebula Pantry interaction',
      publicDescription: 'Verify the Nebula Pantry completion state.'
    }

    expect(projectTaskForRenderer(maskedTask, 'spoiler-shield', false, [])).toMatchObject({
      publicTitle: 'Build the [FEATURE]',
      publicDescription: 'Verify the [CORE_MECHANIC] completion state.'
    })
    expect(projectTaskForRenderer(dictionaryTask, 'spoiler-shield', false, terms)).toMatchObject({
      publicTitle: 'Build the [APP_NAME] interaction',
      publicDescription: 'Verify the [APP_NAME] completion state.'
    })
  })

  it('preserves exact public board text in Full Chaos and after reveal', () => {
    const task = {
      id: 'task-exact',
      publicTitle: 'Build the Nebula Pantry duel',
      publicDescription: 'Add the blue pantry button.',
      status: 'done' as const,
      risk: 'medium' as const,
      files: ['app/nebula-pantry.ts']
    }

    expect(projectTaskForRenderer(task, 'full-chaos', false, [])).toMatchObject({
      publicTitle: task.publicTitle,
      publicDescription: task.publicDescription,
      files: task.files
    })
    expect(projectTaskForRenderer(task, 'spoiler-shield', true, [])).toMatchObject({
      publicTitle: task.publicTitle,
      publicDescription: task.publicDescription,
      files: task.files
    })
  })

  it('quarantines high-risk public text until a redaction dictionary exists', () => {
    const projected = projectEventForRenderer(opinion, 'spoiler-shield', false, [])
    expect(projected.publicText).toBe('Claude registered a high-heat opinion.')
  })

  it.each([
    ['agent.dispatch', 'Claude handed Codex a spoiler-sealed build position.'],
    ['conflict', 'A conflict opened. Details stay hidden in Blind mode.'],
    ['build.failed', 'The build failed. A repair loop is starting.'],
    ['reveal.ready', 'Reveal ready. The hidden app can now be opened.'],
    ['cli.log', 'Claude is working inside the private workspace.']
  ] as const)('uses generic Blind copy for %s', (type, expected) => {
    expect(projectEventForRenderer({ ...opinion, type }, 'blind', false, terms).publicText).toBe(expected)
  })
})
