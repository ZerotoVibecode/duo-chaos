import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentId, DuoEvent, MissionProfile, RunPhase, TurnKind } from '@shared/types'
import { decodeProviderEnvelope } from '@main/process/provider-envelope'
import { repairProviderText } from '@main/text/repair-mojibake'
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
import {
  assessConsensusAgainstQualityBrief,
  compileQualityBrief,
  type CompiledQualityBrief
} from './quality-brief'
import {
  createPitchProvenanceId,
  resolveConsensusProvenance,
  type ConsensusProvenanceRecord,
  type PitchProvenanceRecord
} from './consensus-provenance'
import { canonicalAppSourceBoundaries } from './app-source-boundary'

const PUBLIC_TEXT_PRESENTATION_LIMIT = 180
const PROVIDER_PUBLIC_TEXT_LIMIT = 1_200
const CLIPPED_PUBLIC_TEXT_FALLBACK = 'Agent filed a longer statement; full wording remains sealed.'

const speechSchema = z.object({
  publicText: z.string().trim().min(1).max(PROVIDER_PUBLIC_TEXT_LIMIT),
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
  impact: z.enum(['core', 'substantial']),
  expectedOutcome: z.string().trim().min(24).max(600),
  acceptanceChecks: z.array(z.string().trim().min(12).max(240)).min(1).max(4),
  risk: z.enum(['low', 'medium', 'high']),
  claimedBy: z.enum(['claude', 'codex', 'both', 'none']),
  files: z.array(z.string().trim().min(1).max(260)).min(1).max(12)
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
  sourcePitchIds: z.array(z.string().regex(/^pitch-[a-f0-9]{24}$/u)).max(2).default([]),
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
        publicText: { type: 'string', minLength: 1, maxLength: PROVIDER_PUBLIC_TEXT_LIMIT },
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
        required: [
          'id', 'publicTitle', 'privateTitle', 'publicDescription', 'privateDescription', 'kind',
          'impact', 'expectedOutcome', 'acceptanceChecks', 'risk', 'claimedBy', 'files'
        ],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' },
          publicTitle: { type: 'string', minLength: 1, maxLength: 120 },
          privateTitle: { type: 'string', minLength: 1, maxLength: 240 },
          publicDescription: { type: 'string', minLength: 1, maxLength: 320 },
          privateDescription: { type: 'string', minLength: 1, maxLength: 1_200 },
          kind: { type: 'string', enum: ['implementation', 'design', 'verification', 'repair'] },
          impact: { type: 'string', enum: ['core', 'substantial'] },
          expectedOutcome: { type: 'string', minLength: 24, maxLength: 600 },
          acceptanceChecks: {
            type: 'array', minItems: 1, maxItems: 4,
            items: { type: 'string', minLength: 12, maxLength: 240 }
          },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          claimedBy: { type: 'string', enum: ['claude', 'codex', 'both', 'none'] },
          files: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 260 } }
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
          required: ['appName', 'sourcePitchIds', 'idea', 'summary', 'spec', 'redactions'],
          properties: {
            appName: { type: 'string', minLength: 1, maxLength: 120 },
            sourcePitchIds: {
              type: 'array', minItems: 1, maxItems: 2,
              items: { type: 'string', pattern: '^pitch-[a-f0-9]{24}$' }
            },
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
        publicText: { type: 'string', minLength: 1, maxLength: PROVIDER_PUBLIC_TEXT_LIMIT },
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

function normalizePublicTextForPresentation(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized.length <= PUBLIC_TEXT_PRESENTATION_LIMIT) return normalized

  const prefix = normalized.slice(0, PUBLIC_TEXT_PRESENTATION_LIMIT - 1)
  const wordBoundary = prefix.lastIndexOf(' ')
  if (wordBoundary < 48) return CLIPPED_PUBLIC_TEXT_FALLBACK
  const clipped = prefix
    .slice(0, wordBoundary)
    .replace(/[,:;.!?\-\u2013\u2014]+$/u, '')
    .trimEnd()
  return `${clipped}\u2026`
}

function normalizeDialoguePublicText(capsule: DialogueCapsule): DialogueCapsule {
  return {
    ...capsule,
    opening: {
      ...capsule.opening,
      publicText: normalizePublicTextForPresentation(capsule.opening.publicText)
    },
    counter: {
      ...capsule.counter,
      publicText: normalizePublicTextForPresentation(capsule.counter.publicText)
    },
    verdict: {
      ...capsule.verdict,
      publicText: normalizePublicTextForPresentation(capsule.verdict.publicText)
    },
    opinion: {
      ...capsule.opinion,
      publicText: normalizePublicTextForPresentation(capsule.opinion.publicText)
    }
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
  return repairProviderText(result.data)
}

export interface DialogueTurnContract {
  kind: TurnKind
  phase: RunPhase
}

type JsonSchemaNode = Record<string, unknown> & {
  items: JsonSchemaNode
  properties: Record<string, JsonSchemaNode> & { claimedBy: JsonSchemaNode }
  required: string[]
  enum: string[]
  anyOf: JsonSchemaNode[]
}

export type DialogueProviderJsonSchema = Record<string, unknown> & {
  required: string[]
  properties: Record<string, JsonSchemaNode> & {
    statement: JsonSchemaNode
    opinion: JsonSchemaNode
    pitches: JsonSchemaNode
    tasks: JsonSchemaNode
    consensus: JsonSchemaNode
    redactions: JsonSchemaNode
  }
}

/**
 * Provider-side JSON Schema cannot express every semantic turn rule, but it
 * can prevent the expensive, common drift where a pitch response creates
 * tasks or consensus. The stricter runtime validator remains authoritative.
 */
export function dialogueCapsuleJsonSchemaForTurn(contract: DialogueTurnContract): DialogueProviderJsonSchema {
  const commonProperties = {
    statement: structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA.$defs.speech) as unknown as JsonSchemaNode,
    opinion: structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA.properties.opinion) as unknown as JsonSchemaNode,
    redactions: structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA.properties.redactions) as unknown as JsonSchemaNode
  }
  if (contract.kind === 'pitch') {
    const pitches = structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA.properties.pitches) as unknown as JsonSchemaNode
    pitches.minItems = 2
    pitches.maxItems = 2
    return {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'opinion', 'pitches', 'redactions'],
      properties: {
        statement: commonProperties.statement,
        opinion: commonProperties.opinion,
        pitches,
        redactions: commonProperties.redactions
      }
    } as unknown as DialogueProviderJsonSchema
  }
  if (contract.phase === 'round.consensus') {
    const tasks = structuredClone(DIALOGUE_CAPSULE_JSON_SCHEMA.properties.tasks) as unknown as JsonSchemaNode
    tasks.minItems = 2
    tasks.maxItems = 2
    tasks.items.properties.claimedBy = {
      type: 'string',
      enum: ['claude', 'codex']
    } as unknown as JsonSchemaNode
    const consensus = structuredClone(
      DIALOGUE_CAPSULE_JSON_SCHEMA.properties.consensus.anyOf[0]
    ) as unknown as JsonSchemaNode
    // Consensus is private provider output. Require the actual title here
    // instead of a public Spoiler Shield placeholder, and reserve one
    // dedicated redaction entry for it. Other private terms remain in the
    // top-level redactions array.
    consensus.properties.appName = {
      ...consensus.properties.appName,
      pattern: '^(?!\\s*(?:[Aa][Pp][Pp]|[Pp][Rr][Oo][Dd][Uu][Cc][Tt])[_ -]?[Nn][Aa][Mm][Ee]\\s*$)[^\\[<{].*$'
    } as unknown as JsonSchemaNode
    const consensusRedactions = consensus.properties.redactions!
    const consensusRedactionItems = consensusRedactions.items
    consensus.properties.redactions = {
      ...consensusRedactions,
      minItems: 1,
      maxItems: 1,
      items: {
        ...consensusRedactionItems,
        properties: {
          ...consensusRedactionItems.properties,
          value: {
            ...consensusRedactionItems.properties.value,
            pattern: '^(?!\\s*(?:[Aa][Pp][Pp]|[Pp][Rr][Oo][Dd][Uu][Cc][Tt])[_ -]?[Nn][Aa][Mm][Ee]\\s*$)[^\\[<{].*$'
          },
          label: { type: 'string', enum: ['app name', 'product name'] }
        }
      }
    } as unknown as JsonSchemaNode
    return {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'opinion', 'tasks', 'consensus', 'redactions'],
      properties: {
        statement: commonProperties.statement,
        opinion: commonProperties.opinion,
        tasks,
        consensus,
        redactions: commonProperties.redactions
      }
    } as unknown as DialogueProviderJsonSchema
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['statement', 'opinion', 'redactions'],
    properties: commonProperties
  } as unknown as DialogueProviderJsonSchema
}

const providerMoveCommonShape = {
  statement: speechSchema,
  opinion: opinionSchema,
  redactions: z.array(redactionTermSchema).min(1).max(24)
}

function parseDialogueProviderMove(value: unknown, contract: DialogueTurnContract): DialogueCapsule {
  let candidate = value
  if (typeof candidate === 'string') {
    const text = candidate.trim()
    if (text.length > 96_000 || !text.startsWith('{') || !text.endsWith('}')) {
      throw new DialogueCapsuleError('Dialogue move must be one bounded JSON object.')
    }
    try {
      candidate = JSON.parse(text) as unknown
    } catch {
      throw new DialogueCapsuleError('Dialogue move must contain valid JSON.')
    }
  }

  const invalidMove = (issues: Array<{ path: PropertyKey[]; message: string }>): never => {
    const details = issues
      .slice(0, 6)
      .map((issue) => `${issue.path.map(String).join('.') || 'move'}: ${issue.message}`)
      .join('; ')
    throw new DialogueCapsuleError(`Invalid dialogue move: ${details}`)
  }
  if (contract.kind === 'pitch') {
    const parsed = z.object({
      ...providerMoveCommonShape,
      pitches: z.array(pitchSchema).length(2)
    }).strict().safeParse(candidate)
    if (!parsed.success) return invalidMove(parsed.error.issues)
    const statement = parsed.data.statement
    return {
      opening: statement,
      counter: statement,
      verdict: statement,
      opinion: parsed.data.opinion,
      tasks: [],
      pitches: parsed.data.pitches,
      consensus: null,
      redactions: parsed.data.redactions
    }
  }
  if (contract.phase === 'round.consensus') {
    const parsed = z.object({
      ...providerMoveCommonShape,
      tasks: z.array(taskSchema).length(2),
      consensus: consensusSchema
    }).strict().safeParse(candidate)
    if (!parsed.success) return invalidMove(parsed.error.issues)
    const statement = parsed.data.statement
    return {
      opening: statement,
      counter: statement,
      verdict: statement,
      opinion: parsed.data.opinion,
      tasks: parsed.data.tasks,
      pitches: [],
      consensus: parsed.data.consensus,
      redactions: parsed.data.redactions
    }
  }
  const parsed = z.object(providerMoveCommonShape).strict().safeParse(candidate)
  if (!parsed.success) return invalidMove(parsed.error.issues)
  const statement = parsed.data.statement
  return {
    opening: statement,
    counter: statement,
    verdict: statement,
    opinion: parsed.data.opinion,
    tasks: [],
    pitches: [],
    consensus: null,
    redactions: parsed.data.redactions
  }
}

function parseDialogueProviderCandidate(value: unknown, contract?: DialogueTurnContract): DialogueCapsule {
  try {
    return parseDialogueCapsule(value)
  } catch (capsuleError) {
    if (!contract) throw capsuleError
    return parseDialogueProviderMove(value, contract)
  }
}

function unwrapStructuredOutputCandidate(value: unknown): unknown {
  const wrapper = record(value)
  const keys = Object.keys(wrapper)
  if (keys.length !== 1 || !['value', 'output', 'payload'].includes(keys[0]!)) return value
  const wrapped = wrapper[keys[0]!]
  if (typeof wrapped === 'string') {
    const text = wrapped.trim()
    if (text.length > 96_000 || !text.startsWith('{') || !text.endsWith('}')) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }
  if (typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)) return wrapped
  return undefined
}

function claudeStructuredToolInputs(input: Record<string, unknown>): unknown[] {
  if (input.type !== 'assistant') return []
  const message = record(input.message)
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((entry) => {
    const content = record(entry)
    if (content.type !== 'tool_use' || content.name !== 'StructuredOutput') return []
    return [content.input]
  })
}

function normalizedSecretTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function secretTermKey(value: string): string {
  const lexical = normalizedSecretTerm(value)
  if (lexical) return `text:${lexical}`
  const raw = value.normalize('NFKC').trim()
  return raw ? `raw:${raw}` : ''
}

function isProductNamePlaceholder(value: string): boolean {
  return /^(?:\[\s*(?:app|product)[_ -]?name\s*\]|\{\{\s*(?:app|product)[_ -]?name\s*\}\}|<\s*(?:app|product)[_ -]?name\s*>|(?:app|product)[_ -]name)$/iu.test(value.trim())
}

function isAppNameRedactionLabel(value: string): boolean {
  const label = normalizedSecretTerm(value)
  return /(?:^| )(?:app|product) name(?:$| )/u.test(label)
}

function hydratePrivateConsensusName(
  capsule: DialogueCapsule,
  accumulatedRedactions: DialogueCapsule['redactions'] = []
): DialogueCapsule {
  if (!capsule.consensus || !isProductNamePlaceholder(capsule.consensus.appName)) return capsule
  const candidates = [...capsule.redactions, ...capsule.consensus.redactions, ...accumulatedRedactions]
    .filter((term) => isAppNameRedactionLabel(term.label))
    .map((term) => term.value.trim())
    .filter((value) => value && !isProductNamePlaceholder(value))
  const unique = new Map(candidates.map((value) => [secretTermKey(value), value]))
  if (unique.size !== 1) {
    throw new DialogueCapsuleError('A redacted consensus app name requires exactly one private app-name term.')
  }
  const appName = [...unique.values()][0]
  if (!appName) throw new DialogueCapsuleError('The private consensus app name is missing.')
  return {
    ...capsule,
    consensus: { ...capsule.consensus, appName }
  }
}

function canonicalSecretTitle(value: string): string {
  const trimmed = value.trim()
  const decorated = trimmed.match(/^(.*?)(?:\s*[([{]|\s+(?:—|–|-|\||·)\s+|:\s+)/u)?.[1]?.trim()
  return decorated || trimmed
}

function isCoveredByRedaction(value: string, redactions: ReadonlySet<string>): boolean {
  const keys = new Set([secretTermKey(value), secretTermKey(canonicalSecretTitle(value))].filter(Boolean))
  return keys.size > 0 && [...redactions].some((term) => keys.has(secretTermKey(term)))
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
    const key = secretTermKey(term.value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(term)
  }

  const requiredKeys = new Set(required.map((term) => secretTermKey(term.value)))

  for (const term of required) {
    if (isCoveredByRedaction(term.source, new Set(result.map((candidate) => candidate.value)))) continue
    if (result.length >= 24) {
      let replaceIndex = -1
      for (let index = result.length - 1; index >= 0; index -= 1) {
        const candidate = result[index]
        if (candidate && !requiredKeys.has(secretTermKey(candidate.value))) {
          replaceIndex = index
          break
        }
      }
      if (replaceIndex >= 0) {
        seen.delete(secretTermKey(result[replaceIndex]?.value ?? ''))
        result.splice(replaceIndex, 1)
      }
    }
    const key = secretTermKey(term.value)
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

const TRIVIAL_TASK_LANGUAGE = /\b(?:copy[- ]?only|docs?[- ]?only|readme[- ]?only|tiny tweak|minor polish|optional label|just verify|only verify)\b/iu

function isSourceBoundary(value: string): boolean {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()
  if (!path || path.startsWith('.duo/') || path.startsWith('docs/')) return false
  if (/^(?:readme|license|changelog)(?:\.|$)/iu.test(path)) return false
  return !/\.md(?:$|[/*])/iu.test(path)
}

function materialTaskScore(task: DialogueCapsule['tasks'][number]): number {
  return (task.impact === 'core' ? 3 : 2) +
    (task.kind === 'implementation' || task.kind === 'repair' ? 2 : 1) +
    ({ low: 0, medium: 1, high: 2 } as const)[task.risk] +
    (task.acceptanceChecks.length >= 2 ? 2 : 1) +
    (task.files.length >= 2 ? 1 : 0)
}

function assertMaterialConsensusTasks(tasks: DialogueCapsule['tasks']): void {
  const scores = tasks.map((task) => {
    const privateContract = [
      task.privateTitle,
      task.privateDescription,
      task.expectedOutcome,
      ...task.acceptanceChecks
    ].join(' ')
    if (TRIVIAL_TASK_LANGUAGE.test(privateContract)) {
      throw new DialogueCapsuleError('Consensus tasks must be substantive source contributions, not trivial or copy-only work.')
    }
    if (!task.files.some(isSourceBoundary)) {
      throw new DialogueCapsuleError('Every consensus task needs at least one expected app-source file boundary.')
    }
    return materialTaskScore(task)
  })
  const lowest = Math.min(...scores)
  const highest = Math.max(...scores)
  if (lowest < 4 || highest - lowest > 3) {
    throw new DialogueCapsuleError('Consensus task impact is materially imbalanced; both agents need substantive source-changing work.')
  }
}

function canonicalConsensusTaskBoundaries(tasks: DialogueCapsule['tasks']): DialogueCapsule['tasks'] {
  return tasks.map((task) => {
    const files = canonicalAppSourceBoundaries(task.files)
    if (files.length === 0 || files.includes('[WORKSPACE_FILE]') ||
      task.files.some((file) => canonicalAppSourceBoundaries([file]).length === 0)) {
      throw new DialogueCapsuleError('Consensus task file boundaries must be safe workspace-relative paths inside app/.')
    }
    return { ...task, files }
  })
}

export function validateDialogueCapsuleForTurn(
  capsule: DialogueCapsule,
  contract: DialogueTurnContract,
  context: { accumulatedRedactions?: DialogueCapsule['redactions'] } = {}
): DialogueCapsule {
  const hydratedCapsule = hydratePrivateConsensusName(capsule, context.accumulatedRedactions)
  const repairedRedactions = repairedTitleRedactions(hydratedCapsule)
  const repairedConsensusRedactions = hydratedCapsule.consensus
    ? reserveRequiredRedactions(hydratedCapsule.consensus.redactions, [{
        source: hydratedCapsule.consensus.appName,
        value: canonicalSecretTitle(hydratedCapsule.consensus.appName),
        label: 'app name'
      }])
    : undefined
  const safeCapsule = dialogueCapsuleSchema.parse({
    ...hydratedCapsule,
    redactions: repairedRedactions,
    ...(hydratedCapsule.consensus && repairedConsensusRedactions
      ? { consensus: { ...hydratedCapsule.consensus, redactions: repairedConsensusRedactions } }
      : {})
  })

  if (contract.kind === 'pitch') {
    if (hydratedCapsule.pitches.length !== 2) throw new DialogueCapsuleError('Pitch turns require exactly two private pitches.')
    if (hydratedCapsule.tasks.length !== 0 || hydratedCapsule.consensus !== null) {
      throw new DialogueCapsuleError('Pitch turns cannot create tasks or seal consensus.')
    }
    return safeCapsule
  }

  if (contract.phase === 'round.consensus') {
    if (!hydratedCapsule.consensus) throw new DialogueCapsuleError('The consensus turn must include a sealed consensus.')
    if (hydratedCapsule.pitches.length !== 0) throw new DialogueCapsuleError('The consensus turn cannot introduce fresh pitches.')
    if (hydratedCapsule.tasks.length !== 2) throw new DialogueCapsuleError('The consensus turn requires exactly two balanced tasks.')
    if (new Set(hydratedCapsule.tasks.map((task) => task.id)).size !== hydratedCapsule.tasks.length) {
      throw new DialogueCapsuleError('Consensus task identifiers must be unique.')
    }
    const tasks = canonicalConsensusTaskBoundaries(balancedConsensusTasks(safeCapsule.tasks))
    assertMaterialConsensusTasks(tasks)
    return { ...safeCapsule, tasks }
  }

  if (hydratedCapsule.consensus !== null || hydratedCapsule.tasks.length !== 0) {
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
    const key = secretTermKey(term.value)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function redactionPlaceholder(term: DialogueCapsule['redactions'][number]): '[APP_NAME]' | '[FEATURE]' {
  const label = normalizedSecretTerm(term.label)
  return /\b(?:app|name|pitch|product|title)\b/iu.test(label) ? '[APP_NAME]' : '[FEATURE]'
}

function flexibleSecretPattern(value: string): RegExp | undefined {
  const raw = value.normalize('NFKC').trim()
  const tokens = normalizedSecretTerm(value).split(' ').filter(Boolean)
  if (tokens.length === 0) {
    return raw
      ? new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')
      : undefined
  }
  const genericSingleWord = new Set([
    'app', 'build', 'code', 'echo', 'field', 'flow', 'focus', 'forge', 'garden', 'local',
    'pulse', 'room', 'signal', 'spark', 'studio', 'task', 'work'
  ])
  if (tokens.length === 1 && genericSingleWord.has(tokens[0]!) && /^[\p{L}\p{N}]+$/u.test(raw)) {
    const escapedRaw = raw.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapedRaw}(?![\\p{L}\\p{N}])`, 'gu')
  }
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`,
    'giu'
  )
}

function redactPublicValue(
  value: string,
  terms: DialogueCapsule['redactions']
): string {
  let result = value
  const ordered = [...terms].sort((left, right) =>
    (normalizedSecretTerm(right.value).length || right.value.normalize('NFKC').trim().length) -
    (normalizedSecretTerm(left.value).length || left.value.normalize('NFKC').trim().length)
  )
  for (const term of ordered) {
    const pattern = flexibleSecretPattern(term.value)
    if (pattern) result = result.replace(pattern, redactionPlaceholder(term))
  }
  return result
}

function redactDialoguePublicText(
  capsule: DialogueCapsule,
  accumulatedRedactions: DialogueCapsule['redactions']
): DialogueCapsule {
  const terms = [...accumulatedRedactions, ...capsulePrivateRedactions(capsule)]
  return {
    ...capsule,
    opening: { ...capsule.opening, publicText: redactPublicValue(capsule.opening.publicText, terms) },
    counter: { ...capsule.counter, publicText: redactPublicValue(capsule.counter.publicText, terms) },
    verdict: { ...capsule.verdict, publicText: redactPublicValue(capsule.verdict.publicText, terms) },
    opinion: { ...capsule.opinion, publicText: redactPublicValue(capsule.opinion.publicText, terms) },
    tasks: capsule.tasks.map((task) => ({
      ...task,
      publicTitle: redactPublicValue(task.publicTitle, terms),
      publicDescription: redactPublicValue(task.publicDescription, terms)
    }))
  }
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
  const privateTerms = [
    ...accumulatedRedactions.map((term) => term.value),
    ...capsulePrivateRedactions(capsule).map((term) => term.value)
  ]
  for (const term of privateTerms) {
    const pattern = flexibleSecretPattern(term)
    if (pattern?.test(publicText)) {
      throw new DialogueCapsuleError(`Public dialogue contains sealed term "${term}".`)
    }
  }
}

const ACCUMULATED_REDACTION_LIMIT = 512

export async function readAccumulatedDialogueRedactions(
  workspacePath: string
): Promise<DialogueCapsule['redactions']> {
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
    const key = secretTermKey(term.value)
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

/**
 * Extracts a provider's final structured response. Claude may intermittently
 * serialize an otherwise valid first StructuredOutput attempt under one
 * wrapper key; that exact tool input is accepted only after the same strict
 * schema validation and is never treated as workspace activity.
 */
export function extractDialogueCapsuleFromCliLine(
  agent: 'claude' | 'codex',
  line: string,
  contract?: DialogueTurnContract
): DialogueCapsule | undefined {
  let salvaged: DialogueCapsule | undefined
  let finalCapsule: DialogueCapsule | undefined
  for (const input of decodeProviderEnvelope(line)) {
    if (agent === 'claude') {
      for (const toolInput of claudeStructuredToolInputs(input)) {
        const candidate = unwrapStructuredOutputCandidate(toolInput)
        try {
          salvaged = parseDialogueProviderCandidate(candidate, contract)
        } catch {
          // Invalid or partial tool input is never accepted as a capsule.
        }
      }
    }
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
      finalCapsule = parseDialogueProviderCandidate(
        unwrapStructuredOutputCandidate(candidate),
        contract
      )
    } catch {
      // A malformed candidate cannot erase an earlier valid final record.
    }
  }
  return finalCapsule ?? salvaged
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

function capsuleReplayFingerprint(input: DialogueCapsuleProtocolInput, capsule: DialogueCapsule): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    runId: input.runId,
    round: input.round,
    agent: input.agent,
    targetAgent: input.targetAgent,
    claimKey: input.claimKey,
    contract: input.contract,
    missionProfile: input.missionProfile ?? 'surprise',
    humanBrief: input.humanBrief ?? null,
    replyTo: input.replyTo ?? null,
    capsule
  })).digest('hex')
}

async function commitFullCapsuleReplay(
  input: DialogueCapsuleProtocolInput,
  capsule: DialogueCapsule
): Promise<void> {
  const root = join(input.workspacePath, '.duo')
  const path = join(root, 'private', 'dialogue-commits.jsonl')
  const commitId = stableId(input, 'capsule')
  const fingerprint = capsuleReplayFingerprint(input, capsule)
  const existing = await safeReadProtocolText(root, path) ?? ''
  let matched = false
  for (const line of existing.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const candidate = record(JSON.parse(line) as unknown)
      if (candidate.commitId !== commitId) continue
      matched = true
      if (candidate.fingerprint !== fingerprint) {
        throw new DialogueCapsuleError(
          `Dialogue capsule replay conflict for ${commitId}: the complete preserved capsule has different logical content.`
        )
      }
    } catch (error) {
      if (error instanceof DialogueCapsuleError) throw error
      // An unrelated truncated tail cannot verify this logical turn.
    }
  }
  if (matched) return
  await safeAppendProtocolText(root, path, `${JSON.stringify({
    schemaVersion: 1,
    commitId,
    runId: input.runId,
    round: input.round,
    agent: input.agent,
    claimKey: input.claimKey,
    fingerprint
  })}\n`)
}

async function appendUniqueJsonlRecord(
  protocolRoot: string,
  path: string,
  key: string,
  value: string,
  serialized: string
): Promise<void> {
  const existing = await safeReadProtocolText(protocolRoot, path) ?? ''
  for (const line of existing.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      if (record(JSON.parse(line) as unknown)[key] === value) return
    } catch {
      // A truncated record cannot make the stable accepted record disappear.
    }
  }
  await safeAppendProtocolText(protocolRoot, path, `${serialized}\n`)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null'
  const input = value as Record<string, unknown>
  return `{${Object.keys(input)
    .sort()
    .filter((key) => input[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
    .join(',')}}`
}

function publicEventRecord(value: Record<string, unknown>): Record<string, unknown> {
  const publicEvent = { ...value }
  delete publicEvent.privateText
  delete publicEvent.metadata
  return publicEvent
}

function replayFingerprint(value: Record<string, unknown>, visibility: 'public' | 'private'): string {
  const stable = visibility === 'public' ? publicEventRecord(value) : { ...value }
  delete stable.timestamp
  return createHash('sha256').update(canonicalJson(stable)).digest('hex')
}

async function matchingJsonlRecords(
  protocolRoot: string,
  path: string,
  key: string,
  value: string
): Promise<Record<string, unknown>[]> {
  const existing = await safeReadProtocolText(protocolRoot, path) ?? ''
  return existing.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const parsed = record(JSON.parse(line) as unknown)
      return parsed[key] === value ? [parsed] : []
    } catch {
      // A truncated unrelated tail is ignored. It can never verify a logical ID.
      return []
    }
  })
}

function verifiedReplayRecord(
  records: Record<string, unknown>[],
  expected: Record<string, unknown>,
  visibility: 'public' | 'private',
  eventId: string
): Record<string, unknown> | undefined {
  if (records.length === 0) return undefined
  const expectedFingerprint = replayFingerprint(expected, visibility)
  if (records.some((candidate) => replayFingerprint(candidate, visibility) !== expectedFingerprint)) {
    throw new DialogueCapsuleError(
      `Dialogue replay conflict for ${eventId}: the preserved ${visibility} record has different logical content.`
    )
  }
  return records[0]
}

const eventPairQueues = new Map<string, Promise<void>>()

async function appendEventPair(protocolRoot: string, publicPath: string, privatePath: string, event: DuoEvent): Promise<void> {
  const queueKey = `${protocolRoot}\0${privatePath}\0${event.id}`
  const previous = eventPairQueues.get(queueKey) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(async () => {
    const expectedPrivate = event as unknown as Record<string, unknown>
    const expectedPublic = publicEventRecord(expectedPrivate)
    const [publicMatches, privateMatches] = await Promise.all([
      matchingJsonlRecords(protocolRoot, publicPath, 'id', event.id),
      matchingJsonlRecords(protocolRoot, privatePath, 'id', event.id)
    ])
    const privateRecord = verifiedReplayRecord(privateMatches, expectedPrivate, 'private', event.id)
    const publicRecord = verifiedReplayRecord(publicMatches, expectedPublic, 'public', event.id)

    if (publicRecord && !privateRecord) {
      throw new DialogueCapsuleError(
        `Dialogue replay conflict for ${event.id}: a public-only partial write cannot verify its sealed counterpart.`
      )
    }
    if (privateRecord && publicRecord) {
      if (canonicalJson(publicEventRecord(privateRecord)) !== canonicalJson(publicRecord)) {
        throw new DialogueCapsuleError(
          `Dialogue replay conflict for ${event.id}: the public and private records are not the same committed pair.`
        )
      }
      return
    }
    if (privateRecord) {
      await safeAppendProtocolText(protocolRoot, publicPath, `${canonicalJson(publicEventRecord(privateRecord))}\n`)
      return
    }

    // The private record is the authoritative half because it contains both
    // public and sealed content. Persist it first so any interrupted write can
    // be verified and safely completed on an identical replay.
    await safeAppendProtocolText(protocolRoot, privatePath, `${JSON.stringify(event)}\n`)
    await safeAppendProtocolText(protocolRoot, publicPath, `${JSON.stringify(expectedPublic)}\n`)
  })
  eventPairQueues.set(queueKey, queued)
  try {
    await queued
  } finally {
    if (eventPairQueues.get(queueKey) === queued) eventPairQueues.delete(queueKey)
  }
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
    for (const [index, pitch] of input.capsule.pitches.entries()) {
      const pitchId = createPitchProvenanceId({
        runId: input.runId,
        round: input.round,
        agent: input.agent,
        index,
        title: pitch.title,
        idea: pitch.idea
      })
      await appendUniqueJsonlRecord(root, pitchPath, 'pitchId', pitchId, JSON.stringify({
        pitchId,
        runId: input.runId,
        round: input.round,
        agent: input.agent,
        ...pitch
      }))
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

function pitchRecord(value: unknown, fallbackIndex: number): PitchProvenanceRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  if (
    typeof input.runId !== 'string' ||
    typeof input.round !== 'number' ||
    (input.agent !== 'claude' && input.agent !== 'codex') ||
    typeof input.title !== 'string' ||
    typeof input.idea !== 'string' ||
    typeof input.appeal !== 'string' ||
    typeof input.risk !== 'string'
  ) return undefined
  return {
    pitchId: typeof input.pitchId === 'string' && /^pitch-[a-f0-9]{24}$/u.test(input.pitchId)
      ? input.pitchId
      : createPitchProvenanceId({
          runId: input.runId,
          round: input.round,
          agent: input.agent,
          index: fallbackIndex,
          title: input.title,
          idea: input.idea
        }),
    runId: input.runId,
    round: input.round,
    agent: input.agent,
    title: input.title,
    idea: input.idea,
    appeal: input.appeal,
    risk: input.risk
  }
}

async function readPitchProvenanceRecords(input: DialogueCapsuleProtocolInput): Promise<PitchProvenanceRecord[]> {
  const root = join(input.workspacePath, '.duo')
  const content = await safeReadProtocolText(root, join(root, 'private', 'pitches.jsonl'), 2_000_000)
  if (!content) return []
  return content.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      const parsed = pitchRecord(JSON.parse(line) as unknown, index)
      return parsed ? [parsed] : []
    } catch {
      return []
    }
  })
}

async function preparePrivateQualityContract(input: DialogueCapsuleProtocolInput): Promise<{
  brief: CompiledQualityBrief
  provenance?: ConsensusProvenanceRecord
} | undefined> {
  if (!input.humanBrief?.trim()) return undefined
  const brief = compileQualityBrief({
    humanBrief: input.humanBrief,
    missionProfile: input.missionProfile ?? 'surprise'
  })
  const consensus = input.capsule.consensus
  if (!consensus) return { brief }

  const quality = assessConsensusAgainstQualityBrief(brief, consensus)
  if (!quality.valid) {
    throw new DialogueCapsuleError(
      `The consensus violates the binding quality brief: ${quality.violations.join(' ')}`
    )
  }
  const pitches = await readPitchProvenanceRecords(input)
  const provenance = resolveConsensusProvenance({
    runId: input.runId,
    appName: consensus.appName,
    humanBrief: input.humanBrief,
    qualityBriefFingerprint: brief.fingerprint,
    selectedSourcePitchIds: consensus.sourcePitchIds,
    pitches
  })
  if (!provenance) {
    throw new DialogueCapsuleError(
      'The consensus must select a previously pitched candidate; no matching private pitch provenance was found.'
    )
  }
  return { brief, provenance }
}

async function persistPrivateQualityContract(
  input: DialogueCapsuleProtocolInput,
  prepared: { brief: CompiledQualityBrief; provenance?: ConsensusProvenanceRecord } | undefined
): Promise<void> {
  if (!prepared) return
  const root = join(input.workspacePath, '.duo')
  const sealed = join(root, 'sealed')
  await safeWriteProtocolText(root, join(sealed, 'quality_brief.json'), `${JSON.stringify(prepared.brief, null, 2)}\n`)
  if (prepared.provenance) {
    await safeWriteProtocolText(
      root,
      join(sealed, 'consensus_provenance.json'),
      `${JSON.stringify(prepared.provenance, null, 2)}\n`
    )
  }
}

async function writeDialogueCapsuleProtocolUnlocked(input: DialogueCapsuleProtocolInput): Promise<void> {
  const providerCapsule = parseDialogueCapsule(input.capsule)
  if (input.missionProfile === 'serious' && providerCapsule.consensus) {
    if (!input.humanBrief || !analyzeSeriousAgentSpecification(input.humanBrief, providerCapsule.consensus.spec).valid) {
      throw new DialogueCapsuleError(
        'A serious consensus requires a detailed brief-anchored implementation plan with at least two testable acceptance checks.'
      )
    }
  }
  const preparedQuality = await preparePrivateQualityContract({ ...input, capsule: providerCapsule })
  const accumulatedRedactions = await readAccumulatedDialogueRedactions(input.workspacePath)
  const spoilerSafeProviderCapsule = redactDialoguePublicText(providerCapsule, accumulatedRedactions)
  // Validate the complete provider statement before presentation clipping so a
  // sealed term near the end cannot be hidden beyond the broadcast boundary.
  assertPublicTextIsSpoilerSafe(spoilerSafeProviderCapsule, accumulatedRedactions)
  const capsule = normalizeDialoguePublicText(spoilerSafeProviderCapsule)
  // Commit the complete logical capsule before any protocol mutation. Event
  // IDs alone cover only the visible statement/opinion and cannot detect a
  // retry that quietly changes pitches, tasks, consensus, redactions, or the
  // quality-bearing human contract after a partial write.
  await commitFullCapsuleReplay(input, providerCapsule)
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
  await persistPrivateQualityContract(validated, preparedQuality)
}

const capsuleProtocolQueues = new Map<string, Promise<void>>()

export async function writeDialogueCapsuleProtocol(input: DialogueCapsuleProtocolInput): Promise<void> {
  const queueKey = `${input.workspacePath}\0${stableId(input, 'capsule')}`
  const previous = capsuleProtocolQueues.get(queueKey) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(async () => {
    await writeDialogueCapsuleProtocolUnlocked(input)
  })
  capsuleProtocolQueues.set(queueKey, queued)
  try {
    await queued
  } finally {
    if (capsuleProtocolQueues.get(queueKey) === queued) capsuleProtocolQueues.delete(queueKey)
  }
}
