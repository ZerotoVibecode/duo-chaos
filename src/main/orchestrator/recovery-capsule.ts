import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { DuoEvent } from '@shared/types'
import { decodeProviderEnvelope } from '@main/process/provider-envelope'
import { repairProviderText } from '@main/text/repair-mojibake'
import {
  safeAppendProtocolText,
  safeReadProtocolText
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

const redactionSchema = z.object({
  value: z.string().trim().min(2).max(240),
  label: z.string().trim().min(1).max(40)
}).strict()

const recoveryCapsuleSchema = z.object({
  dispatch: speechSchema,
  opinion: opinionSchema.nullable(),
  redactions: z.array(redactionSchema).max(24)
}).strict()

const SPEECH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['publicText', 'privateText'],
  properties: {
    publicText: { type: 'string', minLength: 1, maxLength: 180 },
    privateText: { type: 'string', minLength: 1, maxLength: 1_200 }
  }
} as const

const OPINION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['publicText', 'privateText', 'tone'],
  properties: {
    ...SPEECH_JSON_SCHEMA.properties,
    tone: {
      type: 'string',
      enum: ['skeptical', 'impressed', 'annoyed', 'confident', 'cautious', 'amused', 'contrarian', 'self-critical', 'collaborative', 'ruthless']
    }
  }
} as const

const REDACTIONS_JSON_SCHEMA = {
  type: 'array',
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
} as const

export const RECOVERY_CAPSULE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dispatch', 'opinion', 'redactions'],
  properties: {
    dispatch: SPEECH_JSON_SCHEMA,
    opinion: { anyOf: [OPINION_JSON_SCHEMA, { type: 'null' }] },
    redactions: REDACTIONS_JSON_SCHEMA
  }
} as const

export type RecoveryCapsule = z.infer<typeof recoveryCapsuleSchema>
export type RecoveryOriginStage = 'opening' | 'work' | 'verdict'

export class RecoveryCapsuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryCapsuleError'
  }
}

export function recoveryCapsuleJsonSchema(requireOpinion: boolean): Record<string, unknown> {
  const schema = structuredClone(RECOVERY_CAPSULE_JSON_SCHEMA) as unknown as {
    properties: { opinion: Record<string, unknown> }
  } & Record<string, unknown>
  schema.properties.opinion = requireOpinion
    ? structuredClone(OPINION_JSON_SCHEMA)
    : { type: 'null' }
  return schema
}

export function parseRecoveryCapsule(value: unknown): RecoveryCapsule {
  let candidate = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{') || !text.endsWith('}')) {
      throw new RecoveryCapsuleError('Recovery capsule must be a single JSON object without a prose wrapper.')
    }
    try {
      candidate = JSON.parse(text) as unknown
    } catch {
      throw new RecoveryCapsuleError('Recovery capsule must contain valid JSON.')
    }
  }
  const parsed = recoveryCapsuleSchema.safeParse(candidate)
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || 'capsule'}: ${issue.message}`)
      .join('; ')
    throw new RecoveryCapsuleError(`Invalid recovery capsule: ${details}`)
  }
  return repairProviderText(parsed.data)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function unwrapStructuredOutputCandidate(value: unknown): unknown {
  const wrapper = record(value)
  const keys = Object.keys(wrapper)
  if (keys.length !== 1 || !['value', 'output', 'payload'].includes(keys[0]!)) return value
  const wrapped = wrapper[keys[0]!]
  if (typeof wrapped === 'string') {
    const text = wrapped.trim()
    if (text.length > 48_000 || !text.startsWith('{') || !text.endsWith('}')) return undefined
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

/** Extract a final capsule or one strictly validated first StructuredOutput attempt. */
export function extractRecoveryCapsuleFromCliLine(
  agent: 'claude' | 'codex',
  line: string
): RecoveryCapsule | undefined {
  let salvaged: RecoveryCapsule | undefined
  let finalCapsule: RecoveryCapsule | undefined
  for (const input of decodeProviderEnvelope(line)) {
    if (agent === 'claude') {
      for (const toolInput of claudeStructuredToolInputs(input)) {
        try {
          salvaged = parseRecoveryCapsule(unwrapStructuredOutputCandidate(toolInput))
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
      finalCapsule = parseRecoveryCapsule(unwrapStructuredOutputCandidate(candidate))
    } catch {
      // A malformed later record cannot erase an earlier valid final capsule.
    }
  }
  return finalCapsule ?? salvaged
}

interface WriteRecoveryCapsuleProtocolInput {
  workspacePath: string
  runId: string
  round: number
  agent: 'claude' | 'codex'
  targetAgent: 'claude' | 'codex'
  originStage: RecoveryOriginStage
  replyTo?: string
  requireOpinion: boolean
  capsule: RecoveryCapsule
}

interface WrittenRecoveryProtocol {
  dispatch: DuoEvent
  opinion?: DuoEvent
}

function stableId(input: WriteRecoveryCapsuleProtocolInput, kind: 'dispatch' | 'opinion'): string {
  const seed = `${input.runId}\0${String(input.round)}\0${input.agent}\0${input.originStage}\0${kind}`
  return `recovery-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function dispatchKind(origin: RecoveryOriginStage): NonNullable<DuoEvent['dispatchKind']> {
  if (origin === 'opening') return 'opening'
  if (origin === 'work') return 'evidence'
  return 'verdict'
}

async function containsEventId(root: string, path: string, id: string): Promise<boolean> {
  const content = await safeReadProtocolText(root, path)
  if (!content) return false
  return content.split(/\r?\n/u).some((line) => {
    if (!line.trim()) return false
    try {
      return record(JSON.parse(line) as unknown).id === id
    } catch {
      return false
    }
  })
}

async function appendEventPair(root: string, publicPath: string, privatePath: string, event: DuoEvent): Promise<void> {
  const publicEvent = { ...event }
  delete publicEvent.privateText
  delete publicEvent.metadata
  const [hasPublic, hasPrivate] = await Promise.all([
    containsEventId(root, publicPath, event.id),
    containsEventId(root, privatePath, event.id)
  ])
  await Promise.all([
    hasPublic ? Promise.resolve() : safeAppendProtocolText(root, publicPath, `${JSON.stringify(publicEvent)}\n`),
    hasPrivate ? Promise.resolve() : safeAppendProtocolText(root, privatePath, `${JSON.stringify(event)}\n`)
  ])
}

export async function writeRecoveryCapsuleProtocol(
  input: WriteRecoveryCapsuleProtocolInput
): Promise<WrittenRecoveryProtocol> {
  const capsule = parseRecoveryCapsule(input.capsule)
  if (input.requireOpinion && capsule.opinion === null) {
    throw new RecoveryCapsuleError('This recovery requires an opinion capsule.')
  }
  if (!input.requireOpinion && capsule.opinion !== null) {
    throw new RecoveryCapsuleError('This recovery must not invent a duplicate opinion.')
  }
  const timestamp = new Date().toISOString()
  const agentName = input.agent === 'claude' ? 'Claude' : 'Codex'
  const targetName = input.targetAgent === 'claude' ? 'Claude' : 'Codex'
  const dispatch: DuoEvent = {
    id: stableId(input, 'dispatch'),
    type: 'agent.dispatch',
    runId: input.runId,
    round: input.round,
    timestamp,
    agent: input.agent,
    targetAgent: input.targetAgent,
    dispatchKind: dispatchKind(input.originStage),
    claimKey: 'shared-topic',
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    topic: 'contract-recovery',
    // Recovery output is model-authored and cannot prove that its own
    // redaction list is exhaustive. Keep the authentic handoff private and
    // publish only supervisor-authored copy across the spoiler boundary.
    publicText: `${agentName} handed ${targetName} a spoiler-sealed build position.`,
    privateText: capsule.dispatch.privateText,
    spoilerRisk: 0.05,
    severity: input.originStage === 'verdict' ? 'high' : 'medium',
    metadata: {
      protocolOrigin: 'supervisor-structured-recovery',
      recoveryOriginStage: input.originStage
    }
  }
  const opinion = capsule.opinion
    ? {
        id: stableId(input, 'opinion'),
        type: 'opinion' as const,
        runId: input.runId,
        round: input.round,
        timestamp,
        agent: input.agent,
        targetAgent: input.targetAgent,
        claimKey: 'shared-topic',
        topic: 'contract-recovery-opinion',
        tone: capsule.opinion.tone,
        publicText: `${agentName} challenged ${targetName} on a hidden build choice.`,
        privateText: capsule.opinion.privateText,
        spoilerRisk: 0.05,
        severity: 'medium' as const,
        metadata: {
          protocolOrigin: 'supervisor-structured-recovery',
          recoveryOriginStage: input.originStage
        }
      }
    : undefined
  const root = join(input.workspacePath, '.duo')
  await appendEventPair(
    root,
    join(root, 'public', 'dispatches.jsonl'),
    join(root, 'private', 'dispatches.jsonl'),
    dispatch
  )
  if (opinion) {
    await appendEventPair(
      root,
      join(root, 'public', 'opinions.jsonl'),
      join(root, 'private', 'opinions.jsonl'),
      opinion
    )
  }
  return { dispatch, ...(opinion ? { opinion } : {}) }
}
