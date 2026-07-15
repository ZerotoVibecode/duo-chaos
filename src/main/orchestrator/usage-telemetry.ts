import { createHash } from 'node:crypto'
import type { AgentUsageSnapshot, AgentUsageTotals } from '@shared/types'
import { decodeProviderEnvelope, type ProviderRecord } from '@main/process/provider-envelope'

type UsageAgent = keyof AgentUsageSnapshot

export type ProviderUsageDelta = Omit<AgentUsageTotals, 'largestRawLineBytes'>
export type ProviderUsageCallStatus = 'active' | 'complete' | 'incomplete' | 'cancelled' | 'timed-out' | 'failed'
export type ProviderUsageSource = 'none' | 'provisional' | 'terminal'

export interface ProviderUsageCallReceipt {
  id: string
  agent: UsageAgent
  status: ProviderUsageCallStatus
  complete: boolean
  source: ProviderUsageSource
  totals: ProviderUsageDelta
}

export interface ProviderUsageEvidenceSnapshot {
  totals: AgentUsageSnapshot
  calls: ProviderUsageCallReceipt[]
}

export type CompletedCallUsageReason = 'processed-input' | 'output' | 'reasoning'

export interface CompletedCallUsageLimits {
  effectiveInputTokens: number
  cachedInputTokenWeight: number
  outputTokens: number
  reasoningTokens: number
}

export interface CompletedCallUsageDecision {
  shouldPauseBeforeNextCall: true
  reasons: CompletedCallUsageReason[]
  callId: string
  agent: UsageAgent
  effectiveInputTokens: number
  totals: ProviderUsageDelta
  limits: CompletedCallUsageLimits
}

/**
 * Soft, between-call safety boundary based only on provider-reported terminal
 * usage. It never interrupts a productive call and does not estimate price or
 * unreported tokens. Resume grants a fresh compact call from the durable baton.
 */
export const DEFAULT_COMPLETED_CALL_USAGE_LIMITS: CompletedCallUsageLimits = Object.freeze({
  effectiveInputTokens: 250_000,
  cachedInputTokenWeight: 0.1,
  outputTokens: 24_000,
  reasoningTokens: 24_000
})

/**
 * Provider cache reads remain visible in raw telemetry but contribute only a
 * conservative fraction to the between-call input guard. Providers report
 * cached input as part of processed input, so subtract it once before applying
 * the configured cache weight. Invalid over-reported cache values are clamped.
 */
export function cacheWeightedInputTokens(
  totals: Pick<ProviderUsageDelta, 'processedInputTokens' | 'cachedInputTokens'>,
  cachedInputTokenWeight = DEFAULT_COMPLETED_CALL_USAGE_LIMITS.cachedInputTokenWeight
): number {
  const processed = Math.max(0, totals.processedInputTokens)
  const cached = Math.min(processed, Math.max(0, totals.cachedInputTokens))
  const uncached = processed - cached
  return Math.ceil(uncached + cached * cachedInputTokenWeight)
}

export function evaluateCompletedCallUsage(
  receipt: ProviderUsageCallReceipt,
  limits: CompletedCallUsageLimits = DEFAULT_COMPLETED_CALL_USAGE_LIMITS
): CompletedCallUsageDecision | undefined {
  if (!receipt.complete || receipt.source !== 'terminal') return undefined
  const reasons: CompletedCallUsageReason[] = []
  const effectiveInputTokens = cacheWeightedInputTokens(receipt.totals, limits.cachedInputTokenWeight)
  if (effectiveInputTokens > limits.effectiveInputTokens) reasons.push('processed-input')
  if (receipt.totals.outputTokens > limits.outputTokens) reasons.push('output')
  if (receipt.totals.reasoningTokens > limits.reasoningTokens) reasons.push('reasoning')
  if (reasons.length === 0) return undefined
  return {
    shouldPauseBeforeNextCall: true,
    reasons,
    callId: receipt.id,
    agent: receipt.agent,
    effectiveInputTokens,
    totals: { ...receipt.totals },
    limits: { ...limits }
  }
}

interface UsageObservation {
  source: Exclude<ProviderUsageSource, 'none'>
  totals: ProviderUsageDelta
  messageId?: string
}

interface UsageCallState {
  id: string
  agent: UsageAgent
  status: ProviderUsageCallStatus
  source: ProviderUsageSource
  terminalSeen: boolean
  provisionalByMessage: Map<string, ProviderUsageDelta>
  contributed: ProviderUsageDelta
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usageDelta(usage: Record<string, unknown>, reportedCostUsd?: number): ProviderUsageDelta {
  const directInput = nonNegativeNumber(usage.input_tokens)
  const cacheCreated = nonNegativeNumber(usage.cache_creation_input_tokens)
  const cacheRead = nonNegativeNumber(usage.cache_read_input_tokens)
  return {
    processedInputTokens: directInput + cacheCreated + cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: nonNegativeNumber(usage.output_tokens),
    reasoningTokens: nonNegativeNumber(usage.reasoning_output_tokens),
    calls: 1,
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd })
  }
}

function parseProviderUsageRecord(agent: UsageAgent, input: ProviderRecord): ProviderUsageDelta | undefined {
  const usage = recordOf(input.usage)
  if (!usage) return undefined

  if (agent === 'codex') {
    if (input.type !== 'turn.completed') return undefined
    return {
      processedInputTokens: nonNegativeNumber(usage.input_tokens),
      cachedInputTokens: nonNegativeNumber(usage.cached_input_tokens),
      outputTokens: nonNegativeNumber(usage.output_tokens),
      reasoningTokens: nonNegativeNumber(usage.reasoning_output_tokens),
      calls: 1
    }
  }

  if (input.type !== 'result') return undefined
  const reportedCost = typeof input.total_cost_usd === 'number' && Number.isFinite(input.total_cost_usd) && input.total_cost_usd >= 0
    ? input.total_cost_usd
    : undefined
  return usageDelta(usage, reportedCost)
}

function parseUsageObservations(agent: UsageAgent, input: ProviderRecord): UsageObservation[] {
  const terminal = parseProviderUsageRecord(agent, input)
  if (terminal) return [{ source: 'terminal', totals: terminal }]
  if (agent !== 'claude' || input.type !== 'assistant') return []

  const message = recordOf(input.message)
  const usage = recordOf(message?.usage)
  if (!usage) return []
  const messageId = typeof message?.id === 'string' && message.id.trim()
    ? message.id
    : createHash('sha256').update(JSON.stringify(message)).digest('hex')
  return [{ source: 'provisional', totals: usageDelta(usage), messageId }]
}

function zeroDelta(): ProviderUsageDelta {
  return {
    processedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0
  }
}

function addDeltas(values: Iterable<ProviderUsageDelta>): ProviderUsageDelta {
  const total = zeroDelta()
  for (const value of values) {
    total.processedInputTokens += value.processedInputTokens
    total.cachedInputTokens += value.cachedInputTokens
    total.outputTokens += value.outputTokens
    total.reasoningTokens += value.reasoningTokens
    // All provisional messages belong to one provider call.
    total.calls = Math.max(total.calls, value.calls)
    if (value.reportedCostUsd !== undefined) {
      total.reportedCostUsd = (total.reportedCostUsd ?? 0) + value.reportedCostUsd
    }
  }
  return total
}

export function parseProviderUsageLine(agent: UsageAgent, line: string): ProviderUsageDelta | undefined {
  const deltas = decodeProviderEnvelope(line)
    .map((providerRecord) => parseProviderUsageRecord(agent, providerRecord))
    .filter((delta): delta is ProviderUsageDelta => delta !== undefined)
  if (deltas.length === 0) return undefined

  const total = zeroDelta()
  for (const delta of deltas) {
    total.processedInputTokens += delta.processedInputTokens
    total.cachedInputTokens += delta.cachedInputTokens
    total.outputTokens += delta.outputTokens
    total.reasoningTokens += delta.reasoningTokens
    total.calls += delta.calls
    if (delta.reportedCostUsd !== undefined) {
      total.reportedCostUsd = (total.reportedCostUsd ?? 0) + delta.reportedCostUsd
    }
  }
  return total
}

function emptyUsage(): AgentUsageTotals {
  return {
    ...zeroDelta(),
    largestRawLineBytes: 0
  }
}

/**
 * Tracks both settled provider totals and per-process evidence.
 *
 * Claude assistant envelopes carry per-message usage before the terminal
 * `result`. Those provisional totals are retained if a process is cancelled,
 * fails, or times out. When a result eventually arrives it atomically replaces
 * the provisional contribution, preventing double counting.
 */
export class RunUsageTracker {
  private readonly totals: AgentUsageSnapshot
  private readonly calls = new Map<string, UsageCallState>()
  private readonly callOrder: string[] = []
  private readonly implicitCurrent: Partial<Record<UsageAgent, string>> = {}
  private implicitSequence = 0

  constructor(initial?: Partial<AgentUsageSnapshot>) {
    this.totals = {
      claude: { ...emptyUsage(), ...initial?.claude },
      codex: { ...emptyUsage(), ...initial?.codex }
    }
  }

  beginCall(agent: UsageAgent, callId: string): void {
    const id = callId.trim()
    if (!id) throw new Error('Provider usage call id must not be empty.')
    const existing = this.calls.get(id)
    if (existing && existing.agent !== agent) throw new Error(`Provider usage call ${id} belongs to ${existing.agent}.`)
    if (!existing) {
      this.calls.set(id, this.newCall(agent, id))
      this.callOrder.push(id)
    } else if (existing.status !== 'active') {
      existing.status = 'active'
    }
    this.implicitCurrent[agent] = id
  }

  ingest(agent: UsageAgent, line: string, parseUsage = true, callId?: string): boolean {
    const current = this.totals[agent]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sizeChanged = lineBytes > current.largestRawLineBytes
    current.largestRawLineBytes = Math.max(current.largestRawLineBytes, lineBytes)
    if (!parseUsage) return sizeChanged

    const observations = decodeProviderEnvelope(line).flatMap((providerRecord) => parseUsageObservations(agent, providerRecord))
    if (observations.length === 0) return sizeChanged
    const state = this.resolveCall(agent, callId)
    for (const observation of observations) this.applyObservation(state, observation)
    if (state.terminalSeen && !callId) this.implicitCurrent[agent] = undefined
    return true
  }

  finishCall(agent: UsageAgent, callId: string, outcome: Exclude<ProviderUsageCallStatus, 'active' | 'incomplete'>): void {
    const state = this.calls.get(callId)
    if (state && state.agent !== agent) throw new Error(`Provider usage call ${callId} belongs to ${state.agent}.`)
    const resolved = state ?? this.newCall(agent, callId)
    if (!state) {
      this.calls.set(callId, resolved)
      this.callOrder.push(callId)
    }
    resolved.status = outcome === 'complete' && !resolved.terminalSeen ? 'incomplete' : outcome
    if (this.implicitCurrent[agent] === callId) this.implicitCurrent[agent] = undefined
  }

  snapshot(): AgentUsageSnapshot {
    return {
      claude: { ...this.totals.claude },
      codex: { ...this.totals.codex }
    }
  }

  evidenceSnapshot(): ProviderUsageEvidenceSnapshot {
    return {
      totals: this.snapshot(),
      calls: this.callOrder.map((id) => {
        const state = this.calls.get(id)!
        return {
          id: state.id,
          agent: state.agent,
          status: state.status,
          complete: state.terminalSeen && state.status === 'complete',
          source: state.source,
          totals: { ...state.contributed }
        }
      })
    }
  }

  private resolveCall(agent: UsageAgent, explicitId?: string): UsageCallState {
    const currentId = explicitId ?? this.implicitCurrent[agent]
    if (currentId) {
      const existing = this.calls.get(currentId)
      if (existing) {
        if (existing.agent !== agent) throw new Error(`Provider usage call ${currentId} belongs to ${existing.agent}.`)
        return existing
      }
      this.beginCall(agent, currentId)
      return this.calls.get(currentId)!
    }
    const implicitId = `${agent}-implicit-${this.implicitSequence += 1}`
    this.beginCall(agent, implicitId)
    return this.calls.get(implicitId)!
  }

  private newCall(agent: UsageAgent, id: string): UsageCallState {
    return {
      id,
      agent,
      status: 'active',
      source: 'none',
      terminalSeen: false,
      provisionalByMessage: new Map(),
      contributed: zeroDelta()
    }
  }

  private applyObservation(state: UsageCallState, observation: UsageObservation): void {
    if (observation.source === 'terminal') {
      state.terminalSeen = true
      state.status = 'complete'
      state.source = 'terminal'
      this.replaceContribution(state, observation.totals)
      return
    }
    if (state.terminalSeen || !observation.messageId) return
    state.source = 'provisional'
    state.provisionalByMessage.set(observation.messageId, observation.totals)
    this.replaceContribution(state, addDeltas(state.provisionalByMessage.values()))
  }

  private replaceContribution(state: UsageCallState, next: ProviderUsageDelta): void {
    const target = this.totals[state.agent]
    target.processedInputTokens += next.processedInputTokens - state.contributed.processedInputTokens
    target.cachedInputTokens += next.cachedInputTokens - state.contributed.cachedInputTokens
    target.outputTokens += next.outputTokens - state.contributed.outputTokens
    target.reasoningTokens += next.reasoningTokens - state.contributed.reasoningTokens
    target.calls += next.calls - state.contributed.calls
    const costDelta = (next.reportedCostUsd ?? 0) - (state.contributed.reportedCostUsd ?? 0)
    if (costDelta !== 0 || target.reportedCostUsd !== undefined) {
      target.reportedCostUsd = Math.max(0, (target.reportedCostUsd ?? 0) + costDelta)
    }
    state.contributed = { ...next }
  }
}
