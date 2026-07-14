import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

const agentSchema = z.enum(['claude', 'codex'])
const identifierSchema = z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/)
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO timestamp.')
const uniqueAgentsSchema = z.array(agentSchema).max(2).refine(
  (agents) => new Set(agents).size === agents.length,
  'Agent evidence cannot contain duplicates.'
)

const usageSchema = z.object({
  processedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  reportedCostUsd: z.number().nonnegative().optional()
}).strict()

const loadoutSchema = z.object({
  executable: z.string().trim().min(1).max(1_024),
  requestedModel: z.string().trim().min(1).max(256).optional(),
  requestedEffort: z.string().trim().min(1).max(64).optional(),
  resolvedModel: z.string().trim().min(1).max(256).optional(),
  resolvedEffort: z.string().trim().min(1).max(64).optional()
}).strict()

const capabilitySchema = z.object({
  adapterVersion: z.string().trim().min(1).max(128),
  cliVersion: z.string().trim().min(1).max(128),
  streamFormat: z.enum(['jsonl', 'json-array', 'mixed', 'unknown']),
  structuredOutput: z.boolean(),
  sessionResume: z.boolean(),
  discoveredAt: timestampSchema,
  models: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  efforts: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  customizationProfile: z.enum(['core', 'smart', 'full-local']).optional()
}).strict()

const retrySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(256),
  attempts: z.number().int().nonnegative(),
  lastReason: z.string().trim().min(1).max(128).optional(),
  updatedAt: timestampSchema
}).strict()

export const durableRunManifestSchema = z.object({
  schemaVersion: z.literal(1),
  planVersion: z.string().trim().min(1).max(128),
  revision: z.number().int().nonnegative(),
  runId: identifierSchema,
  workspaceId: identifierSchema,
  workspacePath: z.string().trim().min(1).max(4_096).optional(),
  status: z.enum([
    'running',
    'pausing',
    'paused',
    'resuming',
    'reveal-ready',
    'complete',
    'failed',
    'cancelled'
  ]),
  updatedAt: timestampSchema,
  request: z.object({
    prompt: z.string().min(1).max(32_000),
    executionMode: z.enum(['simulation', 'safe', 'chaos', 'yolo-sandbox']),
    visibilityMode: z.enum(['blind', 'spoiler-shield', 'full-chaos']),
    missionProfile: z.enum(['surprise', 'serious']).default('surprise'),
    maxTurns: z.number().int().min(2).max(50),
    maxRepairLoops: z.number().int().min(0).max(10),
    turnTimeoutSeconds: z.number().int().positive(),
    runTimeoutSeconds: z.number().int().positive(),
    codexCustomizationProfile: z.enum(['core', 'smart', 'full-local']).optional(),
    claudeCustomizationProfile: z.enum(['core', 'smart', 'full-local']).optional(),
    trustedLocalCapabilitiesConfirmed: z.boolean().optional(),
    qualityRoutingProfile: z.enum(['balanced', 'force-selected']).optional(),
    workInferenceLimit: z.number().int().min(3).max(20).optional(),
    claudeWorkInferenceLimit: z.number().int().min(3).max(20).optional()
  }).strict(),
  loadout: z.object({
    claude: loadoutSchema,
    codex: loadoutSchema
  }).strict(),
  capabilities: z.object({
    claude: capabilitySchema,
    codex: capabilitySchema
  }).strict(),
  cursor: z.object({
    turnIndex: z.number().int().nonnegative(),
    stage: z.enum(['dialogue', 'opening', 'work', 'verdict', 'recovery']),
    attempt: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(256),
    recoveryOriginStage: z.enum(['dialogue', 'opening', 'work', 'verdict']).optional(),
    recoveryReasons: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    stageReceipt: z.object({
      turnId: z.string().trim().min(1).max(256),
      agent: agentSchema,
      kind: z.string().trim().min(1).max(64),
      stage: z.enum(['dialogue', 'opening', 'work', 'verdict', 'recovery']),
      status: z.enum(['running', 'completed', 'timeboxed', 'paused']),
      startedAt: timestampSchema,
      deadlineAt: timestampSchema,
      attempt: z.number().int().positive(),
      effort: z.string().trim().min(1).max(64).optional(),
      qualityCeiling: z.string().trim().min(1).max(64).optional(),
      customizationProfile: z.enum(['core', 'smart', 'full-local']).optional(),
      inferenceSteps: z.number().int().nonnegative().optional(),
      inferenceLimit: z.number().int().positive().max(100).optional(),
      continuationCount: z.number().int().nonnegative().max(10).optional(),
      nextAgent: agentSchema.optional(),
      durableSourceChanged: z.boolean().optional(),
      durableWorkEvidence: z.boolean().optional(),
      evidenceFingerprint: z.string().max(64_000).optional()
    }).strict().optional()
  }).strict(),
  providerSessions: z.object({
    claude: z.string().trim().min(1).max(256).optional(),
    codex: z.string().trim().min(1).max(256).optional()
  }).strict(),
  evidence: z.object({
    acceptedCodeAgents: uniqueAgentsSchema,
    acceptedReviewAgents: uniqueAgentsSchema,
    completedTaskAgents: uniqueAgentsSchema,
    appRevision: z.number().int().nonnegative(),
    verifiedAppRevision: z.number().int().min(-1)
  }).strict(),
  git: z.object({
    head: z.string().trim().min(1).max(256).optional(),
    appFingerprint: z.string().max(64_000).optional()
  }).strict(),
  timing: z.object({
    remainingLeaseMs: z.number().int().nonnegative(),
    accumulatedActiveMs: z.number().int().nonnegative()
  }).strict(),
  usage: z.object({
    claude: usageSchema,
    codex: usageSchema
  }).strict(),
  usageGuard: z.object({
    status: z.enum(['pending', 'acknowledged']),
    agent: agentSchema,
    callId: z.string().trim().min(1).max(256),
    trigger: z.enum(['provider-warning', 'completed-call-usage']),
    reasons: z.array(z.enum(['provider-pressure', 'processed-input', 'output', 'reasoning'])).min(1).max(4),
    triggeredAt: timestampSchema,
    acknowledgedAt: timestampSchema.optional(),
    utilization: z.number().min(0).max(1).optional(),
    resetAt: timestampSchema.optional(),
    totals: usageSchema.omit({ reportedCostUsd: true }).optional(),
    limits: z.object({
      processedInputTokens: z.number().int().positive(),
      outputTokens: z.number().int().positive(),
      reasoningTokens: z.number().int().positive()
    }).strict().optional()
  }).strict().optional(),
  retries: z.array(retrySchema).max(200),
  qualityRepair: z.object({
    attempts: z.number().int().nonnegative().max(100),
    missingEvidence: z.array(z.string().trim().min(1).max(160)).max(20)
  }).strict().optional(),
  pause: z.object({
    reason: z.enum([
      'provider-quota',
      'provider-auth',
      'provider-unavailable',
      'host-interrupted',
      'cli-incompatible',
      'workspace-drift',
      'manual',
      'other'
    ]),
    agent: agentSchema.optional(),
    pausedAt: timestampSchema,
    resetAt: timestampSchema.optional(),
    detailCode: z.string().trim().min(1).max(128).optional()
  }).strict().optional(),
  eventCursor: z.object({
    sequence: z.number().int().nonnegative(),
    lastEventId: z.string().trim().min(1).max(256).optional()
  }).strict()
}).strict().superRefine((manifest, context) => {
  if (manifest.status === 'paused' && !manifest.pause) {
    context.addIssue({ code: 'custom', path: ['pause'], message: 'Paused runs require pause details.' })
  }
  if (manifest.evidence.verifiedAppRevision > manifest.evidence.appRevision) {
    context.addIssue({
      code: 'custom',
      path: ['evidence', 'verifiedAppRevision'],
      message: 'Verified app revision cannot exceed the current app revision.'
    })
  }
})

export type DurableRunManifest = z.infer<typeof durableRunManifestSchema>

export interface DurableRunIdentity {
  runId: string
  workspaceId: string
}

const journalEntrySchema = z.object({
  journalVersion: z.literal(1),
  state: durableRunManifestSchema
}).strict()

export class DurableRunValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DurableRunValidationError'
  }
}

export class DurableRunIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurableRunIdentityError'
  }
}

function validateManifest(value: unknown): DurableRunManifest {
  const parsed = durableRunManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw new DurableRunValidationError(`Invalid durable run manifest: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    throw new DurableRunValidationError(`${label} is not valid JSON.`, { cause: error })
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function durableAppend(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class DurableRunStateStore {
  readonly manifestPath: string
  readonly journalPath: string
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly identity: DurableRunIdentity

  constructor(runtimePath: string, identity: DurableRunIdentity) {
    const runId = identifierSchema.parse(identity.runId)
    const workspaceId = identifierSchema.parse(identity.workspaceId)
    this.identity = { runId, workspaceId }
    const root = resolve(runtimePath)
    this.manifestPath = join(root, 'run-manifest.json')
    this.journalPath = join(root, 'run-journal.jsonl')
  }

  persist(value: DurableRunManifest): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const manifest = this.expectIdentity(validateManifest(value))
      const entry = `${JSON.stringify({ journalVersion: 1, state: manifest })}\n`
      await durableAppend(this.journalPath, entry)
      await atomicWrite(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }

  async readManifest(): Promise<DurableRunManifest> {
    let content: string
    try {
      content = await readFile(this.manifestPath, 'utf8')
    } catch (error) {
      throw new DurableRunValidationError('The durable run manifest could not be read.', { cause: error })
    }
    return this.expectIdentity(validateManifest(parseJson(content, 'The durable run manifest')))
  }

  async readJournal(): Promise<DurableRunManifest[]> {
    let content: string
    try {
      content = await readFile(this.journalPath, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'ENOENT') return []
      throw new DurableRunValidationError('The durable run journal could not be read.', { cause: error })
    }
    const terminated = /\r?\n$/u.test(content)
    const lines = content.split(/\r?\n/u)
    let lastContentIndex = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]?.trim()) {
        lastContentIndex = index
        break
      }
    }
    const manifests: DurableRunManifest[] = []
    for (let index = 0; index <= lastContentIndex; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch (error) {
        if (index === lastContentIndex && !terminated) break
        throw new DurableRunValidationError(`Durable run journal line ${String(index + 1)} is not valid JSON.`, { cause: error })
      }
      const entry = journalEntrySchema.safeParse(parsed)
      if (!entry.success) {
        throw new DurableRunValidationError(
          `Durable run journal line ${String(index + 1)} is invalid: ${z.prettifyError(entry.error)}`
        )
      }
      manifests.push(this.expectIdentity(entry.data.state))
    }
    return manifests
  }

  async reconstruct(): Promise<DurableRunManifest> {
    let manifest: DurableRunManifest | undefined
    try {
      manifest = await this.readManifest()
    } catch (error) {
      if (error instanceof DurableRunIdentityError) throw error
    }
    const journal = await this.readJournal()
    const candidates = [...journal, ...(manifest ? [manifest] : [])]
    const latest = candidates.sort((left, right) => {
      if (left.revision !== right.revision) return right.revision - left.revision
      return right.updatedAt.localeCompare(left.updatedAt)
    })[0]
    if (!latest) throw new DurableRunValidationError('No safe durable run state could be reconstructed.')
    return latest
  }

  private expectIdentity(manifest: DurableRunManifest): DurableRunManifest {
    if (manifest.runId !== this.identity.runId) {
      throw new DurableRunIdentityError(
        `Durable state belongs to run ${manifest.runId}, not ${this.identity.runId}.`
      )
    }
    if (manifest.workspaceId !== this.identity.workspaceId) {
      throw new DurableRunIdentityError(
        `Durable state belongs to workspace ${manifest.workspaceId}, not ${this.identity.workspaceId}.`
      )
    }
    return manifest
  }
}
