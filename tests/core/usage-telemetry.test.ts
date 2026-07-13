import { describe, expect, it } from 'vitest'
import { RunUsageTracker, parseProviderUsageLine } from '../../src/main/orchestrator/usage-telemetry'

describe('provider-reported usage telemetry', () => {
  it('parses Codex terminal usage without inventing a price', () => {
    const usage = parseProviderUsageLine('codex', JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 411_333,
        cached_input_tokens: 381_696,
        output_tokens: 4_882,
        reasoning_output_tokens: 371
      }
    }))

    expect(usage).toEqual({
      processedInputTokens: 411_333,
      cachedInputTokens: 381_696,
      outputTokens: 4_882,
      reasoningTokens: 371,
      calls: 1
    })
    expect(usage).not.toHaveProperty('reportedCostUsd')
  })

  it('counts Claude cache creation and reads as processed input and preserves reported cost', () => {
    const usage = parseProviderUsageLine('claude', JSON.stringify({
      type: 'result',
      subtype: 'success',
      num_turns: 16,
      total_cost_usd: 0.3847,
      usage: {
        input_tokens: 26,
        cache_creation_input_tokens: 19_204,
        cache_read_input_tokens: 393_893,
        output_tokens: 10_046
      }
    }))

    expect(usage).toEqual({
      processedInputTokens: 413_123,
      cachedInputTokens: 393_893,
      outputTokens: 10_046,
      reasoningTokens: 0,
      calls: 1,
      reportedCostUsd: 0.3847
    })
  })

  it('accumulates numeric totals and the largest UTF-8 line without retaining raw text', () => {
    const tracker = new RunUsageTracker()
    const first = JSON.stringify({
      type: 'turn.completed',
      private_result: 'SEALED_PRIVATE_OUTPUT_MUST_NOT_SURVIVE',
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 14, reasoning_output_tokens: 3 }
    })
    const second = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 75, cached_input_tokens: 32, output_tokens: 9, reasoning_output_tokens: 2 }
    })
    const nonUsage = JSON.stringify({ type: 'item.completed', private_result: 'å'.repeat(300) })

    tracker.ingest('codex', first)
    tracker.ingest('codex', second)
    tracker.ingest('codex', nonUsage, false)
    const snapshot = tracker.snapshot()

    expect(snapshot.codex).toEqual({
      processedInputTokens: 195,
      cachedInputTokens: 112,
      outputTokens: 23,
      reasoningTokens: 5,
      calls: 2,
      largestRawLineBytes: Math.max(
        Buffer.byteLength(first, 'utf8'),
        Buffer.byteLength(second, 'utf8'),
        Buffer.byteLength(nonUsage, 'utf8')
      )
    })
    expect(JSON.stringify(snapshot)).not.toContain('SEALED_PRIVATE_OUTPUT_MUST_NOT_SURVIVE')
    expect(JSON.stringify(snapshot)).not.toContain('private_result')
  })

  it('ignores malformed, non-terminal, and invalid usage instead of fabricating totals', () => {
    expect(parseProviderUsageLine('codex', 'not-json')).toBeUndefined()
    expect(parseProviderUsageLine('codex', JSON.stringify({
      type: 'item.completed',
      usage: { input_tokens: 10 }
    }))).toBeUndefined()
    expect(parseProviderUsageLine('claude', JSON.stringify({
      type: 'result',
      num_turns: -5,
      total_cost_usd: -2,
      usage: {
        input_tokens: -10,
        cache_creation_input_tokens: 'invalid',
        cache_read_input_tokens: -20,
        output_tokens: -1
      }
    }))).toEqual({
      processedInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      calls: 1
    })
  })
})
