import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentId, DuoEvent, MissionProfile, RunPhase, TurnKind } from '@shared/types'
import { decodeProviderEnvelope } from '@main/process/provider-envelope'
import {
  analyzeSeriousAgentSpecification,
  sealSeriousMissionSpecification
} from '@main/workspace/serious-mission-contract'
import {
  safeAppendProtocolText,
  safeReadProtocolText,
  safeWriteProtocolText,
  UnsafeProtocolPathError
} from '@main/workspace/safe-protocol-files'

const speechSchema = z.object({
  publicText: z.string().trim().min(1).max(180),
  privateText: z.string().trim().min(1).max(1_200)
}).strict()

const opinionSchema = speechSchema.extend({
  tone: z.enum([
    'skeptical',
    'impressed',
    'annoyed',
    'confident',
    'cautious',
    'amused',
    'contrarian',
    'self-critical',
    'collaborative',
    'ruthless'
  ])
}).strict()

const taskSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  publicTitle: z.string().trim().min(1).max(120),
  privateTitle: z.string().trim().min(1).max(240),
  publicDescription: z.string().trim().min(1).max(320),
  privateDescription: z.string().trim().min(1).max(1_200),
  kind: z.enum(['implementation', 'design', 'verification', 'repair']),
  risk: z.enum(['low', 'medium', 'high']),
  claimedBy: z.enum(['claude', 'codex', 'both', 'none']),
  files: z.array(z.string().trim().min(1).max(260)).max(24)
}).strict()

const pitchSchema = z.object({
  title: z.string().trim().min(1).max(120),
  idea: z.string().trim().min(1).max(600),
  appeal: z.string().trim().min(1).max(400),
  risk: z.string().trim().min(1).max(400)
}).strict()

const redactionTermSchema = z.object({
  value: z.string().trim().min(2).max(240),
  label: z.string().trim().min(1).max(40)
}).strict()

const consensusSchema = z.object({
  appName: z.string().trim().min(1).max(120),
  idea: z.string().trim().min(1).max(800),
  summary: z.string().trim().min(1).max(1_200),
  spec: z.string().trim().min(1).max(8_000),
  redactions: z.array(redactionTermSchema).min(1).max(24)
}).strict()

const dialogueCapsuleSchema = z.object({
  opening: speechSchema,
  counter: speechSchema,
  verdict: speechSchema,
  opinion: opinionSchema,
  tasks: z.array(taskSchema).max(4),
  pitches: z.array(pitchSchema).max(2),
  consensus: consensusSchema.nullable(),
  redactions: z.array(redactionTermSchema).min(1).max(24)
}).strict()

export const DIALOGUE_CAPSULE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opening', 'counter', 'verdict', 'opinion', 'tasks', 'pitches', 'consensus', 'redactions'],
  properties: {
    opening: { $ref: '#/$defs/speech' },
    counter: { $ref: '#/$defs/speech' },
    verdict: { $ref: '#/$defs/speech' },
    opinion: {
      type: 'object',
      additionalProperties: false,
      required: ['publicText', 'privateText', 'tone'],
      properties: {
        publicText: { type: 'string', minLength: 1, maxLength: 180 },
        privateText: { type: 'string', minLength: 1, maxLength: 1_200 },
        tone: {
          type: 'string',
          enum: ['skeptical', 'impressed', 'annoyed', 'confident', 'cautious', 'amused', 'contrarian', 'self-critical', 'collaborative', 'ruthless']
        }
      }
    },
    tasks: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'publicTitle', 'privateTitle', 'publicDescription', 'privateDescription', 'kind', 'risk', 'claimedBy', 'files'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' },
          publicTitle: { type: 'string', minLength: 1, maxLength: 120 },
          privateTitle: { type: 'string', minLength: 1, maxLength: 240 },
          publicDescription: { type: 'string', minLength: 1, maxLength: 320 },
          privateDescription: { type: 'string', minLength: 1, maxLength: 1_200 },
          kind: { type: 'string', enum: ['implementation', 'design', 'verification', 'repair'] },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          claimedBy: { type: 'string', enum: ['claude', 'codex', 'both', 'none'] },
          files: { type: 'array', maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 260 } }
        }
      }
    },
    pitches: {
      type: 'array',
      minItems: 0,
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'idea', 'appeal', 'risk'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          idea: { type: 'string', minLength: 1, maxLength: 600 },
          appeal: { type: 'string', minLength: 1, maxLength: 400 },
          risk: { type: 'string', minLength: 1, maxLength: 400 }
        }
      }
    },
    consensus: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['appName', 'idea', 'summary', 'spec', 'redactions'],
          properties: {
            appName: { type: 'string', minLength: 1, maxLength: 120 },
            idea: { type: 'string', minLength: 1, maxLength: 800 },
            summary: { type: 'string', minLength: 1, maxLength: 1_200 },
            spec: { type: 'string', minLength: 1, maxLength: 8_000 },
            redactions: {
              type: 'array',
              minItems: 1,
              maxItems: 24,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'label'],
                properties: {
                  value: { type: 'string', minLength: 2, maxLength: 240 },
                  label: { type: 'string', minLength: 1, maxLength: 40 }
                }
              }
            }
          }
        },
        { type: 'null' }
      ]
    },
    redactions: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'label'],
        properties: {
          value: { type: 'string', minLength: 2, maxLength: 240 },
          label: { type: 'string', minLength: 1, maxLength: 40 }
        }
      }
    }
  },
  $defs: {
    speech: {
      type: 'object',
      additionalProperties: false,
      required: ['publicText', 'privateText'],
      properties: {
        publicText: { type: 'string', minLength: 1, maxLength: 180 },
        privateText: { type: 'string', minLength: 1, maxLength: 1_200 }
      }
    }
  }
} as const

/** Backward-compatible short name for command-policy callers. */
export const DIALOGUE_CAPSULE_SCHEMA = DIALOGUE_CAPSULE_JSON_SCHEMA

export type DialogueCapsule = z.infer<typeof dialogueCapsuleSchema>

export class DialogueCapsuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DialogueCapsuleError'
  }
}

export function parseDialogueCapsule(value: unknown): DialogueCapsule {
  let candidate = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{') || !text.endsWith('}')) {
      throw new DialogueCapsuleError('Dialogue capsule must be a single JSON object without a prose wrapper.')
    }
    try {
      candidate = JSON.parse(text) as unknown
    } catch {
      throw new DialogueCapsuleError('Dialogue capsule must contain valid JSON.')
    }
  }
  const result = dialogueCapsuleSchema.safeParse(candidate)
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || 'capsule'}: ${issue.message}`)
      .join('; ')
    throw new DialogueCapsuleError(`Invalid dialogue capsule: ${details}`)
  }
  return result.data
}

export interface DialogueTurnContract {
  kind: TurnKind
  phase: RunPhase
}

type MutableDialogueCapsuleJsonSchema = Record<string, unknown> & {
  properties: {
    tasks: Record<string, unknown> & {
      items: {
        properties: {
          claimedBy: Record<string, unknown>
        }
      }
    }
    pitches: Record<string, unknown>
    consensus: Record<string, unknown>
  }
}

/**
 * Provider-side JSON Schema cannot express every semantic turn rule, but it
 * can prevent the expensive, common drift where a pitch response creates
 * tasks or consensus. The stricter runtime validator remains authoritative.
 */
export function dialogueCapsuleJsonSchemaForTurn(contract: DialogueTurnContract): MutableDialogueCapsuleJsonSchema {
  const schema = structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA) as unknown as MutableDialogueCapsuleJsonSchema
  if (contract.kind === 'pitch') {
    schema.properties.pitches.minItems = 2
    schema.properties.pitches.maxItems = 2
    schema.properties.tasks.minItems = 0
    schema.properties.tasks.maxItems = 0
    schema.properties.consensus = { type: 'null' }
    return schema
  }
  if (contract.phase === 'round.consensus') {
    schema.properties.pitches.minItems = 0
    schema.properties.pitches.maxItems = 0
    schema.properties.tasks.minItems = 2
    schema.properties.tasks.maxItems = 2
    schema.properties.tasks.items.properties.claimedBy = {
      type: 'string',
      enum: ['claude', 'codex']
    }
    schema.properties.consensus = structuredClone(
      DIALOGUE_CAPSULE_JSON_SCHEMA.properties.consensus.anyOf[0]
    )
    return schema
  }
  schema.properties.tasks.minItems = 0
  schema.properties.tasks.maxItems = 0
  schema.properties.consensus = { type: 'null' }
  return schema
}

function normalizedSecretTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function canonicalSecretTitle(value: string): string {
  const trimmed = value.trim()
  const decorated = trimmed.match(/^(.*?)(?:\s*[([{]|\s+(?:—|–|-|\||·)\s+|:\s+)/u)?.[1]?.trim()
  return decorated || trimmed
}

function isCoveredByRedaction(value: string, redactions: ReadonlySet<string>): boolean {
  const normalizedValue = normalizedSecretTerm(value)
  const normalizedBase = normalizedSecretTerm(canonicalSecretTitle(value))
  if (!normalizedValue) return false
  return [...redactions].some((term) => {
    const normalizedTerm = normalizedSecretTerm(term)
    return Boolean(normalizedTerm) && (normalizedValue === normalizedTerm || normalizedBase === normalizedTerm)
  })
}

interface RequiredRedactionTerm {
  source: string
  value: string
  label: string
}

function reserveRequiredRedactions(
  redactions: DialogueCapsule['redactions'],
  required: RequiredRedactionTerm[]
): DialogueCapsule['redactions'] {
  const result: DialogueCapsule['redactions'] = []
  const seen = new Set<string>()
  for (const term of redactions) {
    const key = normalizedSecretTerm(term.value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(term)
  }

  const requiredKeys = new Set(required.map((term) => normalizedSecretTerm(term.value)))

  for (const term of required) {
    if (isCoveredByRedaction(term.source, new Set(result.map((candidate) => candidate.value)))) continue
    if (result.length >= 24) {
      let replaceIndex = -1
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const candidate = result[index]
        if (candidate && !requiredKeys.has(normalizedSecretTerm(candidate.value))) {
          replaceIndex = index
          break
        }
      }
      if (replaceIndex >= 0) {
        seen.delete(normalizedSecretTerm(result[replaceIndex]?.value ?? ''))
        result.splice(replaceIndex, 1)
      }
    }
    const key = normalizedSecretTerm(term.value)
    if (key && !seen.has(key) && result.length < 24) {
      result.push({ value: term.value, label: term.label })
      seen.add(key)
    }
  }
  return result
}

function repairedTitleRedactions(capsule: DialogueCapsule): DialogueCapsule['redactions'] {
  return reserveRequiredRedactions(capsule.redactions, [
    ...capsule.pitches.map((pitch) => ({ source: pitch.title, value: canonicalSecretTitle(pitch.title), label: 'pitch title' })),
    ...(capsule.consensus
      ? [{ source: capsule.consensus.appName, value: canonicalSecretTitle(capsule.consensus.appName), label: 'app name' }]
      : [])
  ])
}

function balancedConsensusTasks(tasks: DialogueCapsule['tasks']): DialogueCapsule['tasks'] {
  type SoleOwner = 'claude' | 'codex'
  const semanticOwners = tasks.map((task): SoleOwner | undefined => {
    const text = [task.publicTitle, task.privateTitle, task.publicDescription, task.privateDescription].join(' ')
    const namesClaude = /\bclaude\b/iu.test(text)
    const namesCodex = /\bcodex\b/iu.test(text)
    if (namesClaude === namesCodex) return undefined
    return namesClaude ? 'claude' : 'codex'
  })
  const owners = tasks.map((task, index): SoleOwner | undefined =>
    task.claimedBy === 'claude' || task.claimedBy === 'codex'
      ? task.claimedBy
      : semanticOwners[index]
  )

  const claudeIndex = owners.indexOf('claude')
  const codexIndex = owners.indexOf('codex')
  if (claudeIndex < 0 && codexIndex < 0) {
    owners[0] = 'claude'
    owners[1] = 'codex'
  } else if (claudeIndex < 0) {
    const candidate = owners.findIndex((owner, index) =>
      index !== codexIndex && (owner === undefined || semanticOwners[index] === undefined)
    )
    if (candidate >= 0) owners[candidate] = 'claude'
  } else if (codexIndex < 0) {
    const candidate = owners.findIndex((owner, index) =>
      index !== claudeIndex && (owner === undefined || semanticOwners[index] === undefined)
    )
    if (candidate >= 0) owners[candidate] = 'codex'
  }

  if (new Set(owners).size !== 2 || !owners.includes('claude') || !owners.includes('codex')) {
    throw new DialogueCapsuleError('Consensus task ownership cannot be balanced without contradicting agent-specific task copy.')
  }
  return tasks.map((task, index) => ({ ...task, claimedBy: owners[index] as SoleOwner }))
}

export function validateDialogueCapsuleForTurn(
  capsule: DialogueCapsule,
  contract: DialogueTurnContract
): DialogueCapsule {
  const repairedRedactions = repairedTitleRedactions(capsule)
  const repairedConsensusRedactions = capsule.consensus
    ? reserveRequiredRedactions(capsule.consensus.redactions, [{
        source: capsule.consensus.appName,
        value: canonicalSecretTitle(capsule.consensus.appName),
        label: 'app name'
      }])
    : undefined
  const safeCapsule = dialogueCapsuleSchema.parse({
    ...capsule,
    redactions: repairedRedactions,
    ...(capsule.consensus && repairedConsensusRedactions
      ? { consensus: { ...capsule.consensus, redactions: repairedConsensusRedactions } }
      : {})
  })

  if (contract.kind === 'pitch') {
    if (capsule.pitches.length !== 2) throw new DialogueCapsuleError('Pitch turns require exactly two private pitches.')
    if (capsule.tasks.length !== 0 || capsule.consensus !== null) {
      throw new DialogueCapsuleError('Pitch turns cannot create tasks or seal consensus.')
    }
    return safeCapsule
  }

  if (contract.phase === 'round.consensus') {
    if (!capsule.consensus) throw new DialogueCapsuleError('The consensus turn must include a sealed consensus.')
    if (capsule.pitches.length !== 0) throw new DialogueCapsuleError('The consensus turn cannot introduce fresh pitches.')
    if (capsule.tasks.length !== 2) throw new DialogueCapsuleError('The consensus turn requires exactly two balanced tasks.')
    if (new Set(capsule.tasks.map((task) => task.id)).size !== capsule.tasks.length) {
      throw new DialogueCapsuleError('Consensus task identifiers must be unique.')
    }
    const tasks = balancedConsensusTasks(safeCapsule.tasks)
    return tasks === safeCapsule.tasks ? safeCapsule : { ...safeCapsule, tasks }
  }

  if (capsule.consensus !== null || capsule.tasks.length !== 0) {
    throw new DialogueCapsuleError('Pre-consensus critique turns cannot create tasks or seal consensus.')
  }
  return safeCapsule
}

function capsulePrivateRedactions(capsule: DialogueCapsule): DialogueCapsule['redactions'] {
  const terms = [
    ...capsule.redactions,
    ...capsule.pitches.map((pitch) => ({ value: canonicalSecretTitle(pitch.title), label: 'pitch title' })),
    ...(capsule.consensus
      ? [
          { value: canonicalSecretTitle(capsule.consensus.appName), label: 'app name' },
          ...capsule.consensus.redactions
        ]
      : [])
  ]
  const seen = new Set<string>()
  return terms.filter((term) => {
    const key = normalizedSecretTerm(term.value)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assertPublicTextIsSpoilerSafe(
  capsule: DialogueCapsule,
  accumulatedRedactions: DialogueCapsule['redactions'] = []
): void {
  const publicText = [
    capsule.opening.publicText,
    capsule.counter.publicText,
    capsule.verdict.publicText,
    capsule.opinion.publicText,
    ...capsule.tasks.flatMap((task) => [task.publicTitle, task.publicDescription])
  ].join('\n')
  const normalizedPublicText = ` ${normalizedSecretTerm(publicText)} `
  const privateTerms = [
    ...accumulatedRedactions.map((term) => term.value),
    ...capsulePrivateRedactions(capsule).map((term) => term.value)
  ]
  for (const term of privateTerms) {
    const normalizedTerm = normalizedSecretTerm(term)
    if (normalizedTerm.length >= 2 && normalizedPublicText.includes(` ${normalizedTerm} `)) {
      throw new DialogueCapsuleError(`Public dialogue contains sealed term "${term}".`)
    }
  }
}

const ACCUMULATED_REDACTION_LIMIT = 512

async function readAccumulatedRedactions(workspacePath: string): Promise<DialogueCapsule['redactions']> {
  const path = join(workspacePath, '.duo', 'private', 'redactions.json')
  const root = join(workspacePath, '.duo')
  try {
    const content = await safeReadProtocolText(root, path)
    if (content === undefined) return []
    const parsed = z.object({
      terms: z.array(redactionTermSchema).max(ACCUMULATED_REDACTION_LIMIT)
    }).strict().parse(JSON.parse(content) as unknown)
    return parsed.terms
  } catch (error) {
    if (error instanceof UnsafeProtocolPathError) throw error
    throw new DialogueCapsuleError('The accumulated private redaction dictionary is invalid.')
  }
}

async function persistAccumulatedRedactions(
  workspacePath: string,
  previous: DialogueCapsule['redactions'],
  capsule: DialogueCapsule
): Promise<void> {
  const terms = new Map<string, DialogueCapsule['redactions'][number]>()
  for (const term of [...previous, ...capsulePrivateRedactions(capsule)]) {
    const key = normalizedSecretTerm(term.value)
    if (key && !terms.has(key)) terms.set(key, term)
  }
  if (terms.size > ACCUMULATED_REDACTION_LIMIT) {
    throw new DialogueCapsuleError('The accumulated private redaction dictionary exceeded its safe capacity.')
  }
  const path = join(workspacePath, '.duo', 'private', 'redactions.json')
  await safeWriteProtocolText(
    join(workspacePath, '.duo'),
    path,
    `${JSON.stringify({ terms: [...terms.values()] }, null, 2)}\n`
  )
}

/** Extracts only a provider's final structured response, never command or tool output. */
export function extractDialogueCapsuleFromCliLine(
  agent: 'claude' | 'codex',
  line: string
): DialogueCapsule | undefined {
  let capsule: DialogueCapsule | undefined
  for (const input of decodeProviderEnvelope(line)) {
    let candidate: unknown
    if (agent === 'claude' && input.type === 'result') {
      candidate = input.structured_output ?? input.structuredOutput ?? input.result
    } else if (agent === 'codex' && input.type === 'item.completed') {
      const item = record(input.item)
      if (item.type !== 'agent_message') continue
      candidate = item.text ?? item.content
    } else {
      continue
    }
    try {
      capsule = parseDialogueCapsule(candidate)
    } catch {
      // A malformed candidate cannot erase an earlier valid final record.
    }
  }
  return capsule
}

interface DialogueCapsuleProtocolInput {
  workspacePath: string
  runId: string
  round: number
  agent: Extract<AgentId, 'claude' | 'codex'>
  targetAgent: Extract<AgentId, 'claude' | 'codex'>
  claimKey: string
  contract: DialogueTurnContract
  missionProfile?: MissionProfile
  humanBrief?: string
  replyTo?: string
  capsule: DialogueCapsule
}

export interface DialogueStatementSelection {
  kind: 'opening' | 'counter' | 'verdict'
  speech: DialogueCapsule['opening']
}

export function selectDialogueStatementForTurn(
  capsule: DialogueCapsule,
  contract: DialogueTurnContract,
  replyTo?: string
): DialogueStatementSelection {
  if (contract.kind === 'consensus' || contract.phase === 'round.consensus') {
    return { kind: 'verdict', speech: capsule.verdict }
  }
  if (replyTo) return { kind: 'counter', speech: capsule.counter }
  return { kind: 'opening', speech: capsule.opening }
}

function stableId(input: DialogueCapsuleProtocolInput, kind: string): string {
  const seed = `${input.runId}\0${String(input.round)}\0${input.agent}\0${input.claimKey}\0${kind}`
  return `dialogue-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

async function appendEventPair(protocolRoot: string, publicPath: string, privatePath: string, event: DuoEvent): Promise<void> {
  const publicEvent = { ...event }
  delete publicEvent.privateText
  delete publicEvent.metadata
  await Promise.all([
    safeAppendProtocolText(protocolRoot, publicPath, `${JSON.stringify(publicEvent)}\n`),
    safeAppendProtocolText(protocolRoot, privatePath, `${JSON.stringify(event)}\n`)
  ])
}

function dispatchEvent(
  input: DialogueCapsuleProtocolInput,
  kind: 'opening' | 'counter' | 'verdict',
  speech: DialogueCapsule['opening'],
  timestamp: string,
  replyTo?: string
): DuoEvent {
  return {
    id: stableId(input, kind),
    type: 'agent.dispatch',
    runId: input.runId,
    round: input.round,
    timestamp,
    agent: input.agent,
    targetAgent: input.targetAgent,
    dispatchKind: kind,
    claimKey: input.claimKey,
    ...(replyTo ? { replyTo } : {}),
    topic: 'product-debate',
    publicText: speech.publicText,
    privateText: speech.privateText,
    spoilerRisk: 0.05,
    severity: kind === 'verdict' ? 'high' : 'medium'
  }
}

function opinionEvent(input: DialogueCapsuleProtocolInput, timestamp: string): DuoEvent {
  return {
    id: stableId(input, 'opinion'),
    type: 'opinion',
    runId: input.runId,
    round: input.round,
    timestamp,
    agent: input.agent,
    targetAgent: input.targetAgent,
    claimKey: input.claimKey,
    topic: 'product-opinion',
    tone: input.capsule.opinion.tone,
    publicText: input.capsule.opinion.publicText,
    privateText: input.capsule.opinion.privateText,
    spoilerRisk: 0.05,
    severity: 'medium'
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

async function mergeBoard(input: DialogueCapsuleProtocolInput): Promise<void> {
  const boardPath = join(input.workspacePath, '.duo', 'board.json')
  const root = join(input.workspacePath, '.duo')
  let board: Record<string, unknown> = {}
  try {
    const content = await safeReadProtocolText(root, boardPath)
    if (content !== undefined) board = record(JSON.parse(content) as unknown)
  } catch (error) {
    if (error instanceof UnsafeProtocolPathError) throw error
    // A missing or invalid board starts from a clean, validated task list.
  }
  const existing = Array.isArray(board.tasks)
    ? board.tasks.filter((task): task is Record<string, unknown> => typeof task === 'object' && task !== null)
    : []
  const byId = new Map(existing.map((task) => [typeof task.id === 'string' ? task.id : '', task]))
  for (const task of input.capsule.tasks) {
    byId.set(task.id, {
      ...task,
      type: task.kind,
      status: 'open',
      files: task.files ?? []
    })
  }
  await safeWriteProtocolText(root, boardPath, `${JSON.stringify({ ...board, tasks: [...byId.values()] }, null, 2)}\n`)
}

async function persistPrivateProductContext(input: DialogueCapsuleProtocolInput): Promise<void> {
  const root = join(input.workspacePath, '.duo')
  if (input.capsule.pitches.length > 0) {
    const pitchPath = join(root, 'private', 'pitches.jsonl')
    for (const pitch of input.capsule.pitches) {
      await safeAppendProtocolText(root, pitchPath, `${JSON.stringify({
        runId: input.runId,
        round: input.round,
        agent: input.agent,
        ...pitch
      })}\n`)
    }
  }
  const consensus = input.capsule.consensus
  if (!consensus) return
  const sealedPath = join(root, 'sealed')
  const terms = new Map<string, { value: string; label: string }>()
  for (const term of [
    ...input.capsule.redactions,
    { value: consensus.appName, label: 'APP_NAME' },
    ...consensus.redactions
  ]) {
    terms.set(term.value.toLocaleLowerCase(), term)
  }
  await safeWriteProtocolText(
      root,
      join(sealedPath, 'idea.md'),
      `# ${consensus.appName}\n\n${consensus.idea}\n\n${consensus.summary}\n`
    )
  if (input.missionProfile === 'serious' && input.humanBrief) {
    // Validate the agent-writable path before the serious contract helper reads it.
    await safeReadProtocolText(root, join(sealedPath, 'serious_contract.json'))
    await sealSeriousMissionSpecification(sealedPath, input.humanBrief, consensus.spec)
  } else {
    await safeWriteProtocolText(root, join(sealedPath, 'spec.md'), `# Sealed product specification\n\n${consensus.spec}\n`)
  }
  await safeWriteProtocolText(
      root,
      join(sealedPath, 'redactions.json'),
      `${JSON.stringify({ terms: [...terms.values()] }, null, 2)}\n`
    )
}

export async function writeDialogueCapsuleProtocol(input: DialogueCapsuleProtocolInput): Promise<void> {
  const capsule = parseDialogueCapsule(input.capsule)
  if (input.missionProfile === 'serious' && capsule.consensus) {
    if (!input.humanBrief || !analyzeSeriousAgentSpecification(input.humanBrief, capsule.consensus.spec).valid) {
      throw new DialogueCapsuleError(
        'A serious consensus requires a detailed brief-anchored implementation plan with at least two testable acceptance checks.'
      )
    }
  }
  const accumulatedRedactions = await readAccumulatedRedactions(input.workspacePath)
  assertPublicTextIsSpoilerSafe(capsule, accumulatedRedactions)
  await persistAccumulatedRedactions(input.workspacePath, accumulatedRedactions, capsule)
  const validated = { ...input, capsule }
  const timestamp = new Date().toISOString()
  const selected = selectDialogueStatementForTurn(capsule, input.contract, input.replyTo)
  const dispatch = dispatchEvent(validated, selected.kind, selected.speech, timestamp, input.replyTo)
  const root = join(input.workspacePath, '.duo')

  await appendEventPair(
    root,
    join(root, 'public', 'dispatches.jsonl'),
    join(root, 'private', 'dispatches.jsonl'),
    dispatch
  )
  await appendEventPair(
    root,
    join(root, 'public', 'opinions.jsonl'),
    join(root, 'private', 'opinions.jsonl'),
    opinionEvent(validated, timestamp)
  )
  await mergeBoard(validated)
  await persistPrivateProductContext(validated)
}
