import type { AgentUsageSnapshot, AgentUsageTotals } from '@shared/types'
import { decodeProviderEnvelope, type ProviderRecord } from '@main/process/provider-envelope'

type UsageAgent = keyof AgentUsageSnapshot

export type ProviderUsageDelta = Omit<AgentUsageTotals, 'largestRawLineBytes'>

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
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
  const directInput = nonNegativeNumber(usage.input_tokens)
  const cacheCreated = nonNegativeNumber(usage.cache_creation_input_tokens)
  const cacheRead = nonNegativeNumber(usage.cache_read_input_tokens)
  const reportedCost = typeof input.total_cost_usd === 'number' && Number.isFinite(input.total_cost_usd) && input.total_cost_usd >= 0
    ? input.total_cost_usd
    : undefined
  return {
    processedInputTokens: directInput + cacheCreated + cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: nonNegativeNumber(usage.output_tokens),
    reasoningTokens: 0,
    calls: 1,
    ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost })
  }
}

export function parseProviderUsageLine(agent: UsageAgent, line: string): ProviderUsageDelta | undefined {
  const deltas = decodeProviderEnvelope(line)
    .map((record) => parseProviderUsageRecord(agent, record))
    .filter((delta): delta is ProviderUsageDelta => delta !== undefined)
  if (deltas.length === 0) return undefined

  const total: ProviderUsageDelta = {
    processedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0
  }
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
    processedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    largestRawLineBytes: 0
  }
}

export class RunUsageTracker {
  private readonly totals: AgentUsageSnapshot

  constructor(initial?: Partial<AgentUsageSnapshot>) {
    this.totals = {
      claude: { ...emptyUsage(), ...initial?.claude },
      codex: { ...emptyUsage(), ...initial?.codex }
    }
  }

  ingest(agent: UsageAgent, line: string, parseUsage = true): boolean {
    const current = this.totals[agent]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sizeChanged = lineBytes > current.largestRawLineBytes
    current.largestRawLineBytes = Math.max(current.largestRawLineBytes, lineBytes)
    const usage = parseUsage ? parseProviderUsageLine(agent, line) : undefined
    if (!usage) return sizeChanged

    current.processedInputTokens += usage.processedInputTokens
    current.cachedInputTokens += usage.cachedInputTokens
    current.outputTokens += usage.outputTokens
    current.reasoningTokens += usage.reasoningTokens
    current.calls += usage.calls
    if (usage.reportedCostUsd !== undefined) {
      current.reportedCostUsd = (current.reportedCostUsd ?? 0) + usage.reportedCostUsd
    }
    return true
  }

  snapshot(): AgentUsageSnapshot {
    return {
      claude: { ...this.totals.claude },
      codex: { ...this.totals.codex }
    }
  }
}
