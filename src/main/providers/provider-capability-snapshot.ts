import { z } from 'zod'

const transportFormatSchema = z.enum(['text', 'json', 'jsonl', 'stream-json'])
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  efforts: z.array(effortSchema).max(16)
}).strict()

const capabilitySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  agent: z.enum(['claude', 'codex']),
  capturedAt: z.string().refine((value) => {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  }, 'capturedAt must be an exact ISO-8601 UTC timestamp'),
  cliVersion: z.string().trim().min(1).max(200),
  source: z.enum(['verified', 'unverified']),
  transportFormats: z.array(transportFormatSchema).min(1).max(16),
  structuredOutput: z.boolean(),
  sessionResume: z.boolean(),
  toolDisable: z.boolean(),
  efforts: z.array(effortSchema).max(16),
  models: z.array(modelSchema).max(128),
  quotaResetAvailable: z.boolean()
}).strict().superRefine((snapshot, context) => {
  const availableEfforts = new Set(snapshot.efforts)
  if (snapshot.agent === 'claude' && snapshot.efforts.includes('ultra')) {
    context.addIssue({ code: 'custom', path: ['efforts'], message: 'Claude does not support the Codex-only ultra effort.' })
  }
  for (const [index, model] of snapshot.models.entries()) {
    if (snapshot.agent === 'claude' && model.efforts.includes('ultra')) {
      context.addIssue({ code: 'custom', path: ['models', index, 'efforts'], message: 'Claude models cannot advertise ultra effort.' })
    }
    for (const effort of model.efforts) {
      if (!availableEfforts.has(effort)) {
        context.addIssue({
          code: 'custom',
          path: ['models', index, 'efforts'],
          message: `Model effort ${effort} is absent from the snapshot effort set.`
        })
      }
    }
  }
})

export type ProviderTransportFormat = z.infer<typeof transportFormatSchema>
export type ProviderCapabilityEffort = z.infer<typeof effortSchema>
export type ProviderCapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

const TRANSPORT_ORDER: readonly ProviderTransportFormat[] = ['text', 'json', 'jsonl', 'stream-json']
const EFFORT_ORDER: readonly ProviderCapabilityEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function orderedUnique<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  const unique = new Set(values)
  return order.filter((value) => unique.has(value))
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

export function validateProviderCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot {
  return capabilitySnapshotSchema.parse(value)
}

export function pinProviderCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot {
  const parsed = validateProviderCapabilitySnapshot(value)
  const models = parsed.models
    .map((model) => ({
      id: model.id,
      efforts: orderedUnique(model.efforts, EFFORT_ORDER)
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const canonical: ProviderCapabilitySnapshot = {
    ...parsed,
    transportFormats: orderedUnique(parsed.transportFormats, TRANSPORT_ORDER),
    efforts: orderedUnique(parsed.efforts, EFFORT_ORDER),
    models
  }
  const serializable = JSON.parse(JSON.stringify(canonical)) as ProviderCapabilitySnapshot
  return deepFreeze(serializable)
}
