import { createHash } from 'node:crypto'
import type { ProviderRecord } from '@main/process/provider-envelope'

export type WorkLeaseRecommendation =
  | 'continue'
  | 'request-finalization'
  | 'cancel-idle'
  | 'accept-complete'

export type WorkLeaseState = 'working' | 'finalizing' | 'idle' | 'complete'

export interface LeaseSnapshot {
  /** Total unique provider inference messages observed for this owned task. */
  inferenceSteps: number
  /** Consecutive inference messages since the last successful tool boundary. */
  idleInferenceSteps: number
  /** Successful provider tool boundaries observed during this lease. */
  progressBoundaries: number
  durableToolBoundary: boolean
  pendingTools: number
  completionObserved: boolean
  state: WorkLeaseState
  recommendation: WorkLeaseRecommendation
  /**
   * Backwards-compatible cancellation flag. This is intentionally true only
   * for a genuine idle loop, never merely because total messages crossed a
   * soft budget.
   */
  shouldTimebox: boolean
}

interface LeaseGuardOptions {
  agent?: 'claude' | 'codex'
  initialInferenceSteps?: number
  initialIdleInferenceSteps?: number
}

const IDENTICAL_PERMISSION_DENIAL_LIMIT = 2
const TOTAL_PERMISSION_DENIAL_LIMIT = 3

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function contentOf(providerRecord: ProviderRecord): Record<string, unknown>[] {
  const message = record(providerRecord.message)
  return Array.isArray(message?.content)
    ? message.content.map(record).filter((value): value is Record<string, unknown> => value !== undefined)
    : []
}

function flattenText(value: unknown, output: string[], depth = 0): void {
  if (depth > 5 || output.length >= 32) return
  if (typeof value === 'string') {
    output.push(value.slice(0, 4_000))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) flattenText(item, output, depth + 1)
    return
  }
  const valueRecord = record(value)
  if (!valueRecord) return
  for (const item of Object.values(valueRecord).slice(0, 32)) flattenText(item, output, depth + 1)
}

function toolResultText(block: Record<string, unknown>): string {
  const text: string[] = []
  flattenText(block.content, text)
  return text.join(' ')
}

function isPermissionClassifierDenial(text: string): boolean {
  if (!text) return false
  return /\bauto mode\b.{0,160}\bcannot determine\b.{0,160}\b(?:safety|safe)\b/iu.test(text) ||
    /\b(?:safety|permission) classifier\b.{0,160}\b(?:unavailable|failed|cannot determine)\b/iu.test(text) ||
    /\b(?:denied by (?:the )?permission policy|tool use (?:was )?denied by (?:the )?permission policy)\b/iu.test(text)
}

function permissionDenialFingerprint(text: string): string {
  return text
    .toLocaleLowerCase('en-US')
    .replace(/^error:\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function isPermissionControlledCommand(toolName: string): boolean {
  return /^(?:bash|powershell|shell|command|terminal|exec)$/iu.test(toolName.trim())
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
}

/**
 * Outcome-aware, provider-neutral work lease.
 *
 * The configured inference limit is a soft finalization boundary and an idle
 * loop threshold, not a maximum amount of productive work. Successful tool
 * calls reset idle pressure, so an agent that is still inspecting, editing,
 * testing, or using a capability is never cancelled just because it emitted N
 * messages. The orchestrator may use `request-finalization` to queue a compact
 * handoff, while `shouldTimebox` is reserved for a no-progress reasoning loop
 * or a repeated provider permission-classifier denial. The latter is detected
 * from completed error tool results, so replayed stream records and unrelated
 * in-flight tools retain the normal pending-tool semantics.
 */
export class WorkLeaseGuard {
  private readonly messageIds = new Set<string>()
  private readonly anonymousMessageFingerprints = new Set<string>()
  private readonly pendingTools = new Set<string>()
  private readonly pendingToolNames = new Map<string, string>()
  private readonly durableTools = new Set<string>()
  private anonymousMessages = 0
  private readonly initialInferenceSteps: number
  private idleSteps: number
  private progress = 0
  private durableBoundary = false
  private finalizationRequested = false
  private completion = false
  private idleCancellationRequested = false
  private permissionDenialTotal = 0
  private readonly permissionDenialFingerprints = new Map<string, number>()
  private permissionDenialCancellationRequested = false

  private readonly agent: 'claude' | 'codex'

  constructor(private readonly idleInferenceLimit: number, options: LeaseGuardOptions = {}) {
    positiveInteger(idleInferenceLimit, 'Work idle inference limit')
    const initialInferenceSteps = options.initialInferenceSteps ?? 0
    const initialIdleInferenceSteps = options.initialIdleInferenceSteps ?? 0
    nonNegativeInteger(initialInferenceSteps, 'Initial work inference steps')
    nonNegativeInteger(initialIdleInferenceSteps, 'Initial work idle inference steps')
    this.agent = options.agent ?? 'claude'
    this.initialInferenceSteps = initialInferenceSteps
    this.idleSteps = initialIdleInferenceSteps
  }

  observe(records: readonly ProviderRecord[]): LeaseSnapshot {
    for (const providerRecord of records) {
      if (this.agent === 'claude') {
        if (providerRecord.type === 'assistant') this.observeAssistant(providerRecord)
        if (providerRecord.type === 'user') this.observeToolResults(providerRecord)
        if (providerRecord.type === 'result') this.completion = true
      } else {
        this.observeCodex(providerRecord)
      }
    }

    const steps = this.inferenceSteps()
    if (!this.completion && steps >= this.idleInferenceLimit && this.durableBoundary && this.pendingTools.size === 0) {
      this.finalizationRequested = true
    }
    if (!this.completion && this.idleSteps > this.idleInferenceLimit && this.pendingTools.size === 0) {
      this.idleCancellationRequested = true
    }
    return this.snapshot()
  }

  snapshot(): LeaseSnapshot {
    const recommendation = this.recommendation()
    return {
      inferenceSteps: this.inferenceSteps(),
      idleInferenceSteps: this.idleSteps,
      progressBoundaries: this.progress,
      durableToolBoundary: this.durableBoundary,
      pendingTools: this.pendingTools.size,
      completionObserved: this.completion,
      state: recommendation === 'accept-complete'
        ? 'complete'
        : recommendation === 'cancel-idle'
          ? 'idle'
          : recommendation === 'request-finalization'
            ? 'finalizing'
            : 'working',
      recommendation,
      shouldTimebox: recommendation === 'cancel-idle'
    }
  }

  private observeAssistant(providerRecord: ProviderRecord): void {
    const message = record(providerRecord.message)
    this.observeInference(message, providerRecord)

    for (const block of contentOf(providerRecord)) {
      if (block.type !== 'tool_use') continue
      const name = typeof block.name === 'string' ? block.name : ''
      const toolId = typeof block.id === 'string' ? block.id : undefined
      if (!toolId) continue
      // Every provider tool blocks cancellation while in flight. Successful
      // completion of any tool is work progress; write-family tools also mark
      // a durable source boundary suitable for a later finalization handoff.
      this.pendingTools.add(toolId)
      this.pendingToolNames.set(toolId, name)
      if (/^(?:edit|write|multiedit|notebookedit)$/iu.test(name)) {
        this.durableTools.add(toolId)
        this.durableBoundary = false
      }
    }
  }

  private observeInference(message: Record<string, unknown> | undefined, providerRecord: ProviderRecord): void {
    const id = typeof message?.id === 'string' && message.id.trim() ? message.id : undefined
    let isNewInference = false
    if (id) {
      if (!this.messageIds.has(id)) {
        this.messageIds.add(id)
        isNewInference = true
      }
    } else {
      const fingerprint = createHash('sha256').update(JSON.stringify(message ?? providerRecord)).digest('hex')
      if (!this.anonymousMessageFingerprints.has(fingerprint)) {
        this.anonymousMessageFingerprints.add(fingerprint)
        this.anonymousMessages += 1
        isNewInference = true
      }
    }
    if (isNewInference) this.idleSteps += 1
  }

  private observeCodex(providerRecord: ProviderRecord): void {
    if (providerRecord.type === 'turn.completed') {
      this.completion = true
      return
    }
    const item = record(providerRecord.item)
    if (!item) return
    const itemType = typeof item.type === 'string' ? item.type : ''
    const itemId = typeof item.id === 'string' && item.id.trim()
      ? item.id
      : createHash('sha256').update(JSON.stringify(item)).digest('hex')
    if (itemType === 'agent_message' || itemType === 'reasoning') {
      if (providerRecord.type === 'item.completed') this.observeInference({ ...item, id: itemId }, providerRecord)
      return
    }
    if (providerRecord.type === 'item.started') {
      this.pendingTools.add(itemId)
      if (itemType === 'file_change') {
        this.durableTools.add(itemId)
        this.durableBoundary = false
      }
      return
    }
    if (providerRecord.type !== 'item.completed') return

    this.pendingTools.delete(itemId)
    const failed = item.status === 'failed' ||
      (typeof item.exit_code === 'number' && item.exit_code !== 0)
    if (failed) {
      this.durableTools.delete(itemId)
      return
    }
    this.progress += 1
    this.idleSteps = 0
    this.idleCancellationRequested = false
    if (itemType === 'file_change' || this.durableTools.delete(itemId)) this.durableBoundary = true
  }

  private observeToolResults(providerRecord: ProviderRecord): void {
    for (const block of contentOf(providerRecord)) {
      const toolId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      if (block.type !== 'tool_result' || !toolId || !this.pendingTools.delete(toolId)) continue
      const toolName = this.pendingToolNames.get(toolId) ?? ''
      this.pendingToolNames.delete(toolId)
      const durable = this.durableTools.delete(toolId)
      if (block.is_error === true) {
        if (durable) this.durableBoundary = false
        this.observePermissionDenial(block)
        continue
      }
      if (isPermissionControlledCommand(toolName)) this.resetPermissionDenials()
      this.progress += 1
      this.idleSteps = 0
      this.idleCancellationRequested = false
      if (durable) this.durableBoundary = true
    }
  }

  private observePermissionDenial(block: Record<string, unknown>): void {
    const text = toolResultText(block)
    if (!isPermissionClassifierDenial(text)) return
    const fingerprint = permissionDenialFingerprint(text)
    const identical = (this.permissionDenialFingerprints.get(fingerprint) ?? 0) + 1
    this.permissionDenialFingerprints.set(fingerprint, identical)
    this.permissionDenialTotal += 1
    if (
      identical >= IDENTICAL_PERMISSION_DENIAL_LIMIT ||
      this.permissionDenialTotal >= TOTAL_PERMISSION_DENIAL_LIMIT
    ) {
      this.permissionDenialCancellationRequested = true
    }
  }

  private resetPermissionDenials(): void {
    if (this.permissionDenialCancellationRequested) return
    this.permissionDenialTotal = 0
    this.permissionDenialFingerprints.clear()
  }

  private inferenceSteps(): number {
    return this.initialInferenceSteps + this.messageIds.size + this.anonymousMessages
  }

  private recommendation(): WorkLeaseRecommendation {
    if (this.completion) return 'accept-complete'
    if (
      (this.idleCancellationRequested || this.permissionDenialCancellationRequested) &&
      this.pendingTools.size === 0
    ) return 'cancel-idle'
    if (this.finalizationRequested && this.pendingTools.size === 0) return 'request-finalization'
    return 'continue'
  }
}

/** @deprecated Use WorkLeaseGuard. Retained for persisted integrations and extensions. */
export class ClaudeWorkLeaseGuard extends WorkLeaseGuard {
  constructor(idleInferenceLimit: number, options: Omit<LeaseGuardOptions, 'agent'> = {}) {
    super(idleInferenceLimit, { ...options, agent: 'claude' })
  }
}
