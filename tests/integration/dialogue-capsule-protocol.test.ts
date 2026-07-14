import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIALOGUE_CAPSULE_JSON_SCHEMA,
  dialogueCapsuleJsonSchemaForTurn,
  extractDialogueCapsuleFromCliLine,
  parseDialogueCapsule,
  validateDialogueCapsuleForTurn,
  writeDialogueCapsuleProtocol
} from '../../src/main/orchestrator/dialogue-capsule'
import { writeSeriousMissionContract } from '../../src/main/workspace/serious-mission-contract'

async function protocolWorkspace(prefix: string): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), prefix))
  await Promise.all(['public', 'private', 'sealed'].map((directory) =>
    mkdir(join(workspacePath, '.duo', directory), { recursive: true })
  ))
  return workspacePath
}

const capsule = {
  opening: {
    publicText: 'I think the [FEATURE] should stay focused because the interaction must read immediately.',
    privateText: 'I think the orbit-grid mechanic should stay focused because the interaction must read immediately.'
  },
  counter: {
    publicText: 'I agree on focus, but the [FEATURE] also needs a clear keyboard path.',
    privateText: 'I agree on focus, but the orbit-grid mechanic also needs a clear keyboard path.'
  },
  verdict: {
    publicText: 'We will ship the focused [FEATURE] with pointer and keyboard input.',
    privateText: 'We will ship the focused orbit-grid mechanic with pointer and keyboard input.'
  },
  opinion: {
    publicText: 'The smaller [FEATURE] is stronger because its completion state is testable.',
    privateText: 'The smaller orbit-grid mechanic is stronger because its completion state is testable.',
    tone: 'confident'
  },
  tasks: [
    {
      id: 'task-orbit-input',
      publicTitle: 'Build the core [FEATURE]',
      privateTitle: 'Build the orbit-grid input loop',
      publicDescription: 'Implement the primary interaction and accessible alternate input.',
      privateDescription: 'Implement drag placement and keyboard orbit selection.',
      kind: 'implementation',
      impact: 'core',
      expectedOutcome: 'A complete pointer and keyboard interaction that reaches the same deterministic completion state.',
      acceptanceChecks: [
        'Pointer input reaches the completed interaction state.',
        'Keyboard input reaches the same completed interaction state.'
      ],
      risk: 'medium',
      claimedBy: 'claude',
      files: ['app/src/**', 'app/tests/**']
    }
  ],
  pitches: [],
  consensus: null,
  redactions: [{ value: 'orbit-grid', label: 'FEATURE' }]
} as const

describe('dialogue capsule contract', () => {
  it('exports one reusable schema and extracts only final Claude or Codex structured results', () => {
    expect(DIALOGUE_CAPSULE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: ['opening', 'counter', 'verdict', 'opinion', 'tasks', 'pitches', 'consensus', 'redactions']
    })
    const taskItems = DIALOGUE_CAPSULE_JSON_SCHEMA.properties.tasks.items
    expect(taskItems.required).toEqual(expect.arrayContaining([
      'impact', 'expectedOutcome', 'acceptanceChecks', 'risk', 'files'
    ]))
    expect(taskItems.properties.acceptanceChecks).toMatchObject({ minItems: 1, maxItems: 4 })
    expect(taskItems.properties.files).toMatchObject({ minItems: 1 })
    expect(DIALOGUE_CAPSULE_JSON_SCHEMA.$defs.speech.properties.publicText.maxLength).toBeGreaterThan(180)
    expect(DIALOGUE_CAPSULE_JSON_SCHEMA.properties.opinion.properties.publicText.maxLength).toBe(
      DIALOGUE_CAPSULE_JSON_SCHEMA.$defs.speech.properties.publicText.maxLength
    )
    const claudeLine = JSON.stringify({ type: 'result', structured_output: capsule })
    const codexLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(capsule) } })
    const nonFinalCodexLine = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', output: JSON.stringify(capsule) } })

    expect(extractDialogueCapsuleFromCliLine('claude', claudeLine)).toEqual(capsule)
    expect(extractDialogueCapsuleFromCliLine('codex', codexLine)).toEqual(capsule)
    expect(extractDialogueCapsuleFromCliLine('codex', nonFinalCodexLine)).toBeUndefined()
    expect(extractDialogueCapsuleFromCliLine('claude', 'not json')).toBeUndefined()
  })

  it('specializes the provider schema so a pitch cannot drift into consensus or tasks', () => {
    const pitchSchema = dialogueCapsuleJsonSchemaForTurn({ kind: 'pitch', phase: 'round.pitch' })
    expect(pitchSchema.properties.pitches).toMatchObject({ minItems: 2, maxItems: 2 })
    expect(pitchSchema.properties.tasks).toMatchObject({ minItems: 0, maxItems: 0 })
    expect(pitchSchema.properties.consensus).toEqual({ type: 'null' })

    const consensusSchema = dialogueCapsuleJsonSchemaForTurn({ kind: 'critique', phase: 'round.consensus' })
    expect(consensusSchema.properties.pitches).toMatchObject({ minItems: 0, maxItems: 0 })
    expect(consensusSchema.properties.tasks).toMatchObject({ minItems: 2, maxItems: 2 })
    expect(consensusSchema.properties.consensus).toMatchObject({ type: 'object' })
    expect(consensusSchema.properties.tasks.items.properties.claimedBy.enum).toEqual(['claude', 'codex'])
  })

  it('accepts one complete capsule and rejects prose wrappers or missing exchange fields', () => {
    expect(parseDialogueCapsule(JSON.stringify(capsule))).toEqual(capsule)
    expect(() => parseDialogueCapsule(`Here is the result:\n${JSON.stringify(capsule)}`)).toThrow(/single|json|capsule/i)
    const missingVerdict: Record<string, unknown> = { ...capsule }
    delete missingVerdict.verdict
    expect(() => parseDialogueCapsule(missingVerdict)).toThrow(/verdict/i)
  })

  it('accepts a longer provider statement and normalizes only the persisted broadcast copy', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-public-normalization-')
    const longPublicText = [
      'I think the [FEATURE] should remain focused',
      'because every interaction needs a clear response',
      'and the accessible path should feel equally deliberate',
      'while the final state remains easy to test and explain on camera.'
    ].join('   \n\t')
    expect(longPublicText.length).toBeGreaterThan(180)
    const longerCapsule = {
      ...capsule,
      opening: { ...capsule.opening, publicText: longPublicText },
      opinion: { ...capsule.opinion, publicText: longPublicText }
    }
    const providerLine = JSON.stringify({ type: 'result', structured_output: longerCapsule })
    const extracted = extractDialogueCapsuleFromCliLine('claude', providerLine)
    expect(extracted).toBeDefined()

    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-public-normalization',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: extracted!
    })

    const publicDispatch = JSON.parse(
      (await readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')).trim()
    ) as { publicText: string }
    const publicOpinion = JSON.parse(
      (await readFile(join(workspacePath, '.duo', 'public', 'opinions.jsonl'), 'utf8')).trim()
    ) as { publicText: string }
    const privateDispatch = JSON.parse(
      (await readFile(join(workspacePath, '.duo', 'private', 'dispatches.jsonl'), 'utf8')).trim()
    ) as { privateText: string }

    for (const publicText of [publicDispatch.publicText, publicOpinion.publicText]) {
      expect(publicText.length).toBeLessThanOrEqual(180)
      expect(publicText).not.toMatch(/[\r\n\t]|\s{2,}/u)
      expect(publicText).toMatch(/…$/u)
    }
    expect(privateDispatch.privateText).toBe(capsule.opening.privateText)
  })

  it('keeps semantic spoiler validation on the complete provider statement before clipping', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-long-leak-')
    const safePrefix = Array.from(
      { length: 8 },
      () => 'The [FEATURE] remains focused, accessible, deterministic, and easy to verify.'
    ).join(' ')
    expect(safePrefix.length).toBeGreaterThan(180)
    const unsafe = {
      ...capsule,
      opening: {
        ...capsule.opening,
        publicText: `${safePrefix} Orbit Garden should win.`
      },
      pitches: [
        { title: 'Orbit Garden', idea: 'A spatial seed ritual.', appeal: 'Tactile.', risk: 'Input parity.' },
        { title: 'Signal Room', idea: 'A disappearing message.', appeal: 'Immediate.', risk: 'Audio polish.' }
      ],
      tasks: [],
      redactions: [
        ...capsule.redactions,
        { value: 'Orbit Garden', label: 'APP_NAME' },
        { value: 'Signal Room', label: 'APP_NAME' }
      ]
    }

    await expect(writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-long-leak',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(unsafe)
    })).rejects.toThrow(/public|sealed|term/i)
  })

  it('enforces two pitches before consensus and locally balances two consensus tasks', () => {
    const onePitch = {
      ...capsule,
      tasks: [],
      pitches: [{ title: 'Orbit Garden', idea: 'A spatial seed ritual.', appeal: 'Tactile.', risk: 'Input parity.' }],
      redactions: [...capsule.redactions, { value: 'Orbit Garden', label: 'APP_NAME' }]
    }
    expect(() => validateDialogueCapsuleForTurn(parseDialogueCapsule(onePitch), {
      kind: 'pitch',
      phase: 'round.pitch'
    })).toThrow(/two.*pitch/i)

    const unbalancedConsensus = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Orbit Garden', idea: 'A spatial seed ritual.', summary: 'A small tactile app.',
        spec: 'Implement and verify the interaction.',
        redactions: [{ value: 'Orbit Garden', label: 'APP_NAME' }]
      },
      tasks: [capsule.tasks[0], { ...capsule.tasks[0], id: 'task-two' }],
      redactions: [...capsule.redactions, { value: 'Orbit Garden', label: 'APP_NAME' }]
    }
    const balanced = validateDialogueCapsuleForTurn(parseDialogueCapsule(unbalancedConsensus), {
      kind: 'critique',
      phase: 'round.consensus'
    })
    expect(balanced.tasks.map((task) => task.claimedBy)).toEqual(['claude', 'codex'])

    const ambiguousOwners = {
      ...unbalancedConsensus,
      tasks: [
        { ...capsule.tasks[0], claimedBy: 'both' },
        { ...capsule.tasks[0], id: 'task-two', claimedBy: 'none' }
      ]
    }
    expect(validateDialogueCapsuleForTurn(parseDialogueCapsule(ambiguousOwners), {
      kind: 'critique',
      phase: 'round.consensus'
    }).tasks.map((task) => task.claimedBy)).toEqual(['claude', 'codex'])
  })

  it('rejects a trivial task paired with a core task but accepts similarly material source contracts', () => {
    const consensus = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Orbit Garden', idea: 'A spatial seed ritual.', summary: 'A small tactile app.',
        spec: 'Implement and verify the complete interaction.',
        redactions: [{ value: 'Orbit Garden', label: 'APP_NAME' }]
      },
      redactions: [...capsule.redactions, { value: 'Orbit Garden', label: 'APP_NAME' }]
    }
    const trivialPair = {
      ...consensus,
      tasks: [
        { ...capsule.tasks[0], id: 'core-loop', claimedBy: 'claude' },
        {
          ...capsule.tasks[0],
          id: 'tiny-copy',
          claimedBy: 'codex',
          kind: 'design',
          impact: 'substantial',
          risk: 'low',
          privateTitle: 'Tiny copy-only tweak',
          privateDescription: 'Change one optional label after the core experience is complete.',
          expectedOutcome: 'One optional label is adjusted without changing product behavior.',
          acceptanceChecks: ['The optional label uses the revised wording.'],
          files: ['app/src/copy.ts']
        }
      ]
    }
    expect(() => validateDialogueCapsuleForTurn(parseDialogueCapsule(trivialPair), {
      kind: 'consensus',
      phase: 'round.consensus'
    })).toThrow(/material|substantive|imbalanc|trivial/i)

    const materialPair = {
      ...consensus,
      tasks: [
        { ...capsule.tasks[0], id: 'core-loop', claimedBy: 'claude' },
        {
          ...capsule.tasks[0],
          id: 'accessible-state',
          claimedBy: 'codex',
          impact: 'core',
          privateTitle: 'Build accessible state and recovery behavior',
          privateDescription: 'Implement focus-safe keyboard state, reset behavior, and automated interaction coverage.',
          expectedOutcome: 'Keyboard and pointer users can finish, reset, and replay the complete interaction without losing state.',
          acceptanceChecks: [
            'Keyboard-only completion and reset pass automated coverage.',
            'Focus remains visible and stable after every state transition.'
          ],
          files: ['app/src/accessibility/**', 'app/tests/accessibility/**']
        }
      ]
    }
    expect(() => validateDialogueCapsuleForTurn(parseDialogueCapsule(materialPair), {
      kind: 'consensus',
      phase: 'round.consensus'
    })).not.toThrow()
  })

  it('honors ownership named in task copy and rejects a semantically impossible split', () => {
    const baseConsensus = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Orbit Garden', idea: 'A spatial seed ritual.', summary: 'A small tactile app.',
        spec: 'Implement and verify the interaction.',
        redactions: [{ value: 'Orbit Garden', label: 'APP_NAME' }]
      },
      redactions: [...capsule.redactions, { value: 'Orbit Garden', label: 'APP_NAME' }]
    }
    const semanticTasks = {
      ...baseConsensus,
      tasks: [
        { ...capsule.tasks[0], publicTitle: 'Claude builds the [FEATURE]', privateTitle: 'Claude builds the interaction', claimedBy: 'both' },
        { ...capsule.tasks[0], id: 'task-two', publicTitle: 'Codex verifies the [FEATURE]', privateTitle: 'Codex verifies the interaction', claimedBy: 'none' }
      ]
    }
    expect(validateDialogueCapsuleForTurn(parseDialogueCapsule(semanticTasks), {
      kind: 'critique',
      phase: 'round.consensus'
    }).tasks.map((task) => task.claimedBy)).toEqual(['claude', 'codex'])

    const impossible = {
      ...semanticTasks,
      tasks: semanticTasks.tasks.map((task, index) => ({
        ...task,
        id: `claude-only-${String(index)}`,
        publicTitle: 'Claude owns this [FEATURE] task',
        privateTitle: 'Claude owns this implementation task'
      }))
    }
    expect(() => validateDialogueCapsuleForTurn(parseDialogueCapsule(impossible), {
      kind: 'critique',
      phase: 'round.consensus'
    })).toThrow(/ownership|balanced/i)
  })

  it('keeps valid sole owners even when their task copy mentions the other agent', () => {
    const explicitOwners = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Orbit Garden', idea: 'A spatial seed ritual.', summary: 'A small tactile app.',
        spec: 'Implement and verify the interaction.',
        redactions: [{ value: 'Orbit Garden', label: 'APP_NAME' }]
      },
      redactions: [...capsule.redactions, { value: 'Orbit Garden', label: 'APP_NAME' }],
      tasks: [
        {
          ...capsule.tasks[0],
          id: 'claude-polish',
          publicTitle: "Polish Codex's [FEATURE] scaffold",
          privateTitle: "Polish Codex's orbit-grid scaffold",
          claimedBy: 'claude'
        },
        {
          ...capsule.tasks[0],
          id: 'codex-verify',
          publicTitle: "Verify Claude's [FEATURE] animation",
          privateTitle: "Verify Claude's orbit-grid animation",
          claimedBy: 'codex'
        }
      ]
    }

    expect(validateDialogueCapsuleForTurn(parseDialogueCapsule(explicitOwners), {
      kind: 'critique',
      phase: 'round.consensus'
    }).tasks.map((task) => task.claimedBy)).toEqual(['claude', 'codex'])
  })

  it('accepts decorative pitch titles when a spoiler-catching base name is redacted', () => {
    const extendedTitles = {
      ...capsule,
      tasks: [],
      pitches: [
        { title: 'Rope Snap (elastic slingshot toy)', idea: 'A tiny tactile toy.', appeal: 'Immediate.', risk: 'Tuning.' },
        { title: 'Knot — drag-to-untangle puzzle', idea: 'A tiny spatial puzzle.', appeal: 'Clear.', risk: 'Touch targets.' }
      ],
      redactions: [
        ...capsule.redactions,
        { value: 'Rope Snap', label: 'APP_NAME' },
        { value: 'Knot', label: 'APP_NAME' }
      ]
    }

    expect(() => validateDialogueCapsuleForTurn(parseDialogueCapsule(extendedTitles), {
      kind: 'pitch',
      phase: 'round.pitch'
    })).not.toThrow()
  })

  it('repairs missing pitch-title redactions locally without changing the agent statement', () => {
    const missingTitleRedactions = {
      ...capsule,
      tasks: [],
      pitches: [
        { title: 'Pocket Surprise', idea: 'A tiny rule-changing toy.', appeal: 'Memorable.', risk: 'Clarity.' },
        { title: 'Signal Garden', idea: 'A reactive visual pattern.', appeal: 'Tactile.', risk: 'Restraint.' }
      ],
      redactions: [{ value: 'hidden mechanic', label: 'FEATURE' }]
    }

    const validated = validateDialogueCapsuleForTurn(parseDialogueCapsule(missingTitleRedactions), {
      kind: 'pitch',
      phase: 'round.pitch'
    })

    expect(validated.opening).toEqual(missingTitleRedactions.opening)
    expect(validated.redactions).toEqual(expect.arrayContaining([
      { value: 'Pocket Surprise', label: 'pitch title' },
      { value: 'Signal Garden', label: 'pitch title' }
    ]))
  })

  it('does not mistake one descriptive word for coverage of a sealed product title', () => {
    const weakCoverage = {
      ...capsule,
      tasks: [],
      pitches: [
        { title: 'Rope Snap (elastic slingshot toy)', idea: 'A tiny tactile toy.', appeal: 'Immediate.', risk: 'Tuning.' },
        { title: 'Signal Garden', idea: 'A reactive visual pattern.', appeal: 'Tactile.', risk: 'Restraint.' }
      ],
      redactions: [
        { value: 'toy', label: 'FEATURE' },
        { value: 'Signal Garden', label: 'APP_NAME' }
      ]
    }

    const validated = validateDialogueCapsuleForTurn(parseDialogueCapsule(weakCoverage), {
      kind: 'pitch',
      phase: 'round.pitch'
    })
    expect(validated.redactions).toContainEqual({ value: 'Rope Snap', label: 'pitch title' })
  })

  it('keeps mandatory title redactions inside the provider limit', () => {
    const saturated = {
      ...capsule,
      tasks: [],
      pitches: [
        { title: 'Pocket Surprise', idea: 'A tiny rule-changing toy.', appeal: 'Memorable.', risk: 'Clarity.' },
        { title: 'Signal Garden', idea: 'A reactive visual pattern.', appeal: 'Tactile.', risk: 'Restraint.' }
      ],
      redactions: Array.from({ length: 24 }, (_, index) => ({ value: `private-term-${String(index)}`, label: 'FEATURE' }))
    }

    const validated = validateDialogueCapsuleForTurn(parseDialogueCapsule(saturated), {
      kind: 'pitch',
      phase: 'round.pitch'
    })
    expect(validated.redactions).toHaveLength(24)
    expect(validated.redactions).toEqual(expect.arrayContaining([
      { value: 'Pocket Surprise', label: 'pitch title' },
      { value: 'Signal Garden', label: 'pitch title' }
    ]))
  })

  it('reserves the sealed consensus app name in both saturated 24-term dictionaries', () => {
    const saturatedTerms = Array.from({ length: 24 }, (_, index) => ({
      value: `private-term-${String(index)}`,
      label: 'FEATURE'
    }))
    const saturatedConsensus = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Signal Garden',
        idea: 'A reactive visual pattern.',
        summary: 'A tactile local experience.',
        spec: 'Build and verify the shared interaction.',
        redactions: saturatedTerms
      },
      tasks: [
        { ...capsule.tasks[0], id: 'claude-build', claimedBy: 'claude' },
        { ...capsule.tasks[0], id: 'codex-verify', claimedBy: 'codex' }
      ],
      redactions: saturatedTerms
    }

    const validated = validateDialogueCapsuleForTurn(parseDialogueCapsule(saturatedConsensus), {
      kind: 'consensus',
      phase: 'round.consensus'
    })

    expect(validated.redactions).toHaveLength(24)
    expect(validated.redactions).toContainEqual({ value: 'Signal Garden', label: 'app name' })
    expect(validated.consensus?.redactions).toHaveLength(24)
    expect(validated.consensus?.redactions).toContainEqual({ value: 'Signal Garden', label: 'app name' })
  })

  it('writes the public and private protocol itself with stable reply links and no private text in public files', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-capsule-')
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-contract',
      round: 3,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(capsule)
    })

    const publicDispatchText = await readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')
    const privateDispatchText = await readFile(join(workspacePath, '.duo', 'private', 'dispatches.jsonl'), 'utf8')
    const publicOpinionText = await readFile(join(workspacePath, '.duo', 'public', 'opinions.jsonl'), 'utf8')
    const privateOpinionText = await readFile(join(workspacePath, '.duo', 'private', 'opinions.jsonl'), 'utf8')
    const board = JSON.parse(await readFile(join(workspacePath, '.duo', 'board.json'), 'utf8')) as { tasks: Array<Record<string, unknown>> }

    const publicDispatches = publicDispatchText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>)
    const privateDispatches = privateDispatchText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(publicDispatches).toHaveLength(1)
    expect(publicDispatches[0]).toMatchObject({
      agent: 'claude',
      targetAgent: 'codex',
      dispatchKind: 'opening',
      publicText: capsule.opening.publicText
    })
    expect(publicDispatches[0]).not.toHaveProperty('replyTo')
    expect(publicDispatchText).not.toContain('orbit-grid')
    expect(publicOpinionText).not.toContain('orbit-grid')
    expect(privateDispatchText).toContain('orbit-grid')
    expect(privateOpinionText).toContain('orbit-grid')
    expect(privateDispatches.map((event) => event.id)).toEqual(publicDispatches.map((event) => event.id))
    expect(board.tasks).toContainEqual(expect.objectContaining({
      id: 'task-orbit-input',
      publicTitle: 'Build the core [FEATURE]',
      privateTitle: 'Build the orbit-grid input loop',
      kind: 'implementation',
      status: 'open',
      claimedBy: 'claude'
    }))
  })

  it('records one real cross-agent reply per turn instead of a same-agent mini conversation', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-reply-chain-')
    const runId = 'duo-run-dialogue-reply-chain'
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId,
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(capsule)
    })
    const openingText = await readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')
    const opening = JSON.parse(openingText.trim()) as Record<string, unknown>

    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId,
      round: 2,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      replyTo: String(opening.id),
      capsule: parseDialogueCapsule(capsule)
    })

    const publicDispatchText = await readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')
    const publicDispatches = publicDispatchText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(publicDispatches).toHaveLength(2)
    expect(publicDispatches[1]).toMatchObject({
      agent: 'codex',
      targetAgent: 'claude',
      dispatchKind: 'counter',
      replyTo: opening.id,
      publicText: capsule.counter.publicText
    })
    expect(publicDispatches[1]?.id).not.toBe(opening.id)
  })

  it('preserves private pitches and the sealed consensus spec without exposing hidden nouns publicly', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-consensus-')
    const consensusCapsule = {
      ...capsule,
      pitches: [
        {
          title: 'Orbit Garden',
          idea: 'A tactile orbit-grid garden that blooms through spatial placement.',
          appeal: 'One memorable interaction with a strong visual payoff.',
          risk: 'Pointer behavior must have an accessible keyboard path.'
        }
      ],
      consensus: {
        appName: 'Orbit Garden',
        idea: 'A tactile orbit-grid garden.',
        summary: 'Place seeds in a spatial orbit and grow a tiny animated garden.',
        spec: 'Build a local single-page app with pointer and keyboard placement, deterministic state, and a replayable ending.',
        redactions: [
          { value: 'Orbit Garden', label: 'APP_NAME' },
          { value: 'orbit-grid', label: 'FEATURE' }
        ]
      },
      redactions: [
        { value: 'Orbit Garden', label: 'APP_NAME' },
        { value: 'orbit-grid', label: 'FEATURE' }
      ],
      tasks: [
        capsule.tasks[0],
        {
          id: 'task-orbit-polish',
          publicTitle: 'Polish and verify the [FEATURE]',
          privateTitle: 'Polish and verify Orbit Garden',
          publicDescription: 'Complete motion, copy, and verification for the shared interaction.',
          privateDescription: 'Polish the garden motion and verify pointer plus keyboard behavior.',
          kind: 'design',
          impact: 'core',
          expectedOutcome: 'The complete garden interaction is polished, accessible, and verified across pointer and keyboard input.',
          acceptanceChecks: [
            'Motion remains clear and stable throughout the complete interaction.',
            'Pointer and keyboard completion pass the interaction checks.'
          ],
          risk: 'medium',
          claimedBy: 'codex',
          files: ['app/src/motion/**', 'app/tests/input/**']
        }
      ]
    }

    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-consensus',
      round: 4,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'consensus', phase: 'round.consensus' },
      replyTo: 'dialogue-accepted-claude-position',
      capsule: parseDialogueCapsule(consensusCapsule)
    })

    await expect(readFile(join(workspacePath, '.duo', 'private', 'pitches.jsonl'), 'utf8')).resolves.toContain('Orbit Garden')
    await expect(readFile(join(workspacePath, '.duo', 'sealed', 'idea.md'), 'utf8')).resolves.toContain('Orbit Garden')
    await expect(readFile(join(workspacePath, '.duo', 'sealed', 'spec.md'), 'utf8')).resolves.toContain('deterministic state')
    await expect(readFile(join(workspacePath, '.duo', 'sealed', 'redactions.json'), 'utf8')).resolves.toContain('APP_NAME')
    const board = JSON.parse(await readFile(join(workspacePath, '.duo', 'board.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(board.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'task-orbit-input', impact: 'core',
        expectedOutcome: capsule.tasks[0].expectedOutcome,
        acceptanceChecks: capsule.tasks[0].acceptanceChecks,
        files: capsule.tasks[0].files
      }),
      expect.objectContaining({ id: 'task-orbit-polish', impact: 'core' })
    ]))
    const publicProtocol = await Promise.all([
      readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8'),
      readFile(join(workspacePath, '.duo', 'public', 'opinions.jsonl'), 'utf8')
    ])
    expect(publicProtocol.join('\n')).not.toContain('Orbit Garden')
    expect(publicProtocol.join('\n')).not.toContain('orbit-grid')
    const consensusDispatch = JSON.parse(publicProtocol[0].trim()) as Record<string, unknown>
    expect(consensusDispatch).toMatchObject({
      dispatchKind: 'verdict',
      replyTo: 'dialogue-accepted-claude-position',
      publicText: consensusCapsule.verdict.publicText
    })
  })

  it('binds a serious human brief into the sealed consensus specification', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-serious-consensus-')
    const humanBrief = 'Build an accessible invoice dashboard with offline CSV review.'
    await writeSeriousMissionContract(join(workspacePath, '.duo', 'sealed'), humanBrief, '2026-07-12T00:00:00.000Z')
    const seriousPitch = {
      ...capsule,
      tasks: [],
      pitches: [
        {
          title: 'Ledger Lantern',
          idea: 'An accessible invoice dashboard with offline CSV review.',
          appeal: 'A focused workflow for reviewing invoices without a network dependency.',
          risk: 'CSV edge cases and keyboard behavior need explicit tests.'
        },
        {
          title: 'Receipt Room',
          idea: 'A local receipt triage workspace.',
          appeal: 'Fast batch review.',
          risk: 'The broader invoice workflow may be underspecified.'
        }
      ],
      redactions: [
        { value: 'Ledger Lantern', label: 'APP_NAME' },
        { value: 'Receipt Room', label: 'APP_NAME' }
      ]
    }
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-serious-consensus',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      missionProfile: 'serious',
      humanBrief,
      capsule: parseDialogueCapsule(seriousPitch)
    })
    const seriousConsensus = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Ledger Lantern',
        idea: 'A focused invoice review workspace.',
        summary: 'The requested dashboard with an offline review queue.',
        spec: 'Implement the requested accessible invoice dashboard with a deterministic CSV parser, a keyboard-safe review queue, and durable local offline state.\n\nAcceptance checks\n- Import a representative CSV invoice file while offline.\n- Review every invoice action using only the keyboard.\n- Preserve the review queue across a full app restart.',
        redactions: [{ value: 'Ledger Lantern', label: 'APP_NAME' }]
      },
      redactions: [{ value: 'Ledger Lantern', label: 'APP_NAME' }],
      tasks: [
        { ...capsule.tasks[0], id: 'serious-claude', claimedBy: 'claude' },
        { ...capsule.tasks[0], id: 'serious-codex', claimedBy: 'codex' }
      ]
    }

    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-serious-consensus',
      round: 4,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'consensus', phase: 'round.consensus' },
      missionProfile: 'serious',
      humanBrief,
      capsule: parseDialogueCapsule(seriousConsensus)
    })

    const specification = await readFile(join(workspacePath, '.duo', 'sealed', 'spec.md'), 'utf8')
    expect(specification).toContain(humanBrief)
    expect(specification).toMatch(/brief fingerprint/i)
    expect(specification).toContain('Acceptance checks')
  })

  it('rejects an unpitched consensus and records stable private provenance for a pitched winner', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-provenance-')
    const humanBrief = 'Build a useful local app for content creators.'
    const pitchCapsule = {
      ...capsule,
      tasks: [],
      pitches: [
        {
          title: 'Cutlight',
          idea: 'A useful local shot planner for content creators.',
          appeal: 'Turns a rough creator idea into a concrete sequence.',
          risk: 'The workflow needs one fast path.'
        },
        {
          title: 'Takeboard',
          idea: 'A local take-review board for content creators.',
          appeal: 'Fast comparison and clear next actions.',
          risk: 'Media handling should stay deliberately small.'
        }
      ],
      redactions: [
        { value: 'Cutlight', label: 'APP_NAME' },
        { value: 'Takeboard', label: 'APP_NAME' }
      ]
    }
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-provenance',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      humanBrief,
      capsule: parseDialogueCapsule(pitchCapsule)
    })

    const consensusCapsule = {
      ...capsule,
      pitches: [],
      consensus: {
        appName: 'Museum of Almost',
        idea: 'A useful local shot planner for content creators.',
        summary: 'Turn a creator brief into a cinematic shot plan.',
        spec: 'Build a useful local content-creator workflow, store projects locally, and verify a complete shot-planning journey.',
        redactions: [{ value: 'Museum of Almost', label: 'APP_NAME' }]
      },
      tasks: [
        { ...capsule.tasks[0], id: 'claude-build', claimedBy: 'claude' },
        { ...capsule.tasks[0], id: 'codex-build', claimedBy: 'codex' }
      ],
      redactions: [{ value: 'Museum of Almost', label: 'APP_NAME' }]
    }
    await expect(writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-provenance',
      round: 4,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'consensus', phase: 'round.consensus' },
      humanBrief,
      capsule: parseDialogueCapsule(consensusCapsule)
    })).rejects.toThrow(/pitched|provenance|candidate/i)

    const alignedConsensus = {
      ...consensusCapsule,
      consensus: {
        appName: 'Cutlight',
        idea: 'A useful local shot planner for content creators.',
        summary: 'Turn a creator brief into a cinematic shot plan.',
        spec: 'Build a useful local content-creator workflow, store projects locally, and verify a complete shot-planning journey.',
        redactions: [{ value: 'Cutlight', label: 'APP_NAME' }]
      },
      redactions: [{ value: 'Cutlight', label: 'APP_NAME' }]
    }
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-provenance',
      round: 4,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'consensus', phase: 'round.consensus' },
      humanBrief,
      capsule: parseDialogueCapsule(alignedConsensus)
    })

    const provenance = JSON.parse(
      await readFile(join(workspacePath, '.duo', 'sealed', 'consensus_provenance.json'), 'utf8')
    ) as { sourcePitchIds: string[]; qualityBriefFingerprint: string }
    expect(provenance.sourcePitchIds).toHaveLength(1)
    expect(provenance.sourcePitchIds[0]).toMatch(/^pitch-[a-f0-9]{24}$/u)
    expect(provenance.qualityBriefFingerprint).toMatch(/^[a-f0-9]{64}$/u)

    const publicProtocol = await Promise.all([
      readFile(join(workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8'),
      readFile(join(workspacePath, '.duo', 'public', 'opinions.jsonl'), 'utf8')
    ])
    expect(publicProtocol.join('\n')).not.toContain('Cutlight')
    expect(publicProtocol.join('\n')).not.toContain(provenance.sourcePitchIds[0])
  })

  it('rejects pre-consensus public text that contains an explicitly sealed pitch term', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-leak-')
    const unsafe = {
      ...capsule,
      opening: {
        publicText: 'I think Orbit Garden should win because its interaction reads immediately.',
        privateText: capsule.opening.privateText
      },
      pitches: [
        { title: 'Orbit Garden', idea: 'A spatial seed ritual.', appeal: 'Tactile and memorable.', risk: 'Input parity.' },
        { title: 'Signal Room', idea: 'A disappearing radio message.', appeal: 'Immediate tension.', risk: 'Audio polish.' }
      ],
      tasks: [],
      redactions: [
        { value: 'Orbit Garden', label: 'APP_NAME' },
        { value: 'Signal Room', label: 'APP_NAME' },
        { value: 'orbit-grid', label: 'FEATURE' }
      ]
    }

    await expect(writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-leak',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(unsafe)
    })).rejects.toThrow(/public|sealed|term/i)
  })

  it('rejects punctuation variants of sealed terms in public dialogue', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-normalized-leak-')
    const unsafe = {
      ...capsule,
      opening: {
        publicText: 'Signal Garden should win because the interaction reads immediately.',
        privateText: capsule.opening.privateText
      },
      tasks: [],
      pitches: [
        { title: 'Signal-Garden', idea: 'A spatial signal ritual.', appeal: 'Tactile.', risk: 'Input parity.' },
        { title: 'Pocket Echo', idea: 'A disappearing message.', appeal: 'Immediate tension.', risk: 'Audio polish.' }
      ],
      redactions: [
        { value: 'Signal-Garden', label: 'APP_NAME' },
        { value: 'Pocket Echo', label: 'APP_NAME' }
      ]
    }

    await expect(writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-normalized-leak',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(unsafe)
    })).rejects.toThrow(/public|sealed|term/i)
  })

  it('rejects a later turn that omits and leaks a title sealed by an earlier turn', async () => {
    const workspacePath = await protocolWorkspace('duo-dialogue-cross-turn-leak-')
    const opening = {
      ...capsule,
      tasks: [],
      pitches: [
        { title: 'Signal Garden', idea: 'A spatial signal ritual.', appeal: 'Tactile.', risk: 'Input parity.' },
        { title: 'Pocket Echo', idea: 'A disappearing message.', appeal: 'Immediate tension.', risk: 'Audio polish.' }
      ],
      redactions: [
        { value: 'Signal Garden', label: 'APP_NAME' },
        { value: 'Pocket Echo', label: 'APP_NAME' }
      ]
    }
    await writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-cross-turn-leak',
      round: 1,
      agent: 'claude',
      targetAgent: 'codex',
      claimKey: 'shared-direction',
      contract: { kind: 'pitch', phase: 'round.pitch' },
      capsule: parseDialogueCapsule(opening)
    })

    const laterLeak = {
      ...capsule,
      opening: {
        publicText: 'Signal/Garden should survive because its interaction is clearer.',
        privateText: 'Signal Garden should survive because its interaction is clearer.'
      },
      tasks: [],
      pitches: [],
      consensus: null,
      redactions: [{ value: 'different hidden mechanic', label: 'FEATURE' }]
    }

    await expect(writeDialogueCapsuleProtocol({
      workspacePath,
      runId: 'duo-run-dialogue-cross-turn-leak',
      round: 2,
      agent: 'codex',
      targetAgent: 'claude',
      claimKey: 'shared-direction',
      contract: { kind: 'critique', phase: 'round.conflict' },
      replyTo: 'dialogue-prior',
      capsule: parseDialogueCapsule(laterLeak)
    })).rejects.toThrow(/public|sealed|term/i)
  })
})
