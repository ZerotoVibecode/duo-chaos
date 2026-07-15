import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPLETED_CALL_USAGE_LIMITS,
  RunUsageTracker,
  evaluateCompletedCallUsage,
  parseProviderUsageLine
} from '../../src/main/orchestrator/usage-telemetry'

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

  it('retains deduplicated provisional Claude usage when a call is cancelled before its result record', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('claude', 'claude-work-1')
    const partial = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 10_000,
          output_tokens: 120
        }
      }
    })
    tracker.ingest('claude', partial, true, 'claude-work-1')
    tracker.ingest('claude', partial, true, 'claude-work-1')
    tracker.finishCall('claude', 'claude-work-1', 'cancelled')

    expect(tracker.snapshot().claude).toMatchObject({
      processedInputTokens: 15_002,
      cachedInputTokens: 10_000,
      outputTokens: 120,
      calls: 1
    })
    const [receipt] = tracker.evidenceSnapshot().calls
    expect(receipt).toMatchObject({
      id: 'claude-work-1',
      agent: 'claude',
      status: 'cancelled',
      complete: false,
      source: 'provisional'
    })
    expect(receipt?.totals).toMatchObject({ processedInputTokens: 15_002, outputTokens: 120, calls: 1 })
  })

  it('reconciles provisional Claude messages to terminal aggregate usage without double counting', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('claude', 'claude-work-2')
    tracker.ingest('claude', JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-2',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 0,
          output_tokens: 400
        }
      }
    }), true, 'claude-work-2')
    tracker.ingest('claude', JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 8_000,
        output_tokens: 900
      }
    }), true, 'claude-work-2')
    tracker.finishCall('claude', 'claude-work-2', 'complete')

    const claudeUsage = tracker.snapshot().claude
    expect(claudeUsage.largestRawLineBytes).toBeGreaterThan(0)
    expect(claudeUsage).toEqual({
      processedInputTokens: 13_003,
      cachedInputTokens: 8_000,
      outputTokens: 900,
      reasoningTokens: 0,
      calls: 1,
      largestRawLineBytes: claudeUsage.largestRawLineBytes,
      reportedCostUsd: 0.42
    })
    expect(tracker.evidenceSnapshot().calls[0]).toMatchObject({
      status: 'complete',
      complete: true,
      source: 'terminal'
    })
  })

  it('records a successful process without terminal usage as explicitly incomplete', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('claude', 'claude-work-3')
    tracker.finishCall('claude', 'claude-work-3', 'complete')

    expect(tracker.evidenceSnapshot().calls[0]).toMatchObject({
      status: 'incomplete',
      complete: false,
      source: 'none'
    })
  })

  it('requests a between-call checkpoint from excessive cache-weighted terminal input', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('codex', 'codex-work-heavy')
    tracker.ingest('codex', JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: DEFAULT_COMPLETED_CALL_USAGE_LIMITS.effectiveInputTokens + 1,
        cached_input_tokens: 0,
        output_tokens: 8_000,
        reasoning_output_tokens: 2_000
      }
    }), true, 'codex-work-heavy')
    tracker.finishCall('codex', 'codex-work-heavy', 'complete')

    const [receipt] = tracker.evidenceSnapshot().calls
    expect(evaluateCompletedCallUsage(receipt!)).toEqual({
      shouldPauseBeforeNextCall: true,
      reasons: ['processed-input'],
      callId: 'codex-work-heavy',
      agent: 'codex',
      effectiveInputTokens: DEFAULT_COMPLETED_CALL_USAGE_LIMITS.effectiveInputTokens + 1,
      totals: {
        processedInputTokens: DEFAULT_COMPLETED_CALL_USAGE_LIMITS.effectiveInputTokens + 1,
        cachedInputTokens: 0,
        outputTokens: 8_000,
        reasoningTokens: 2_000,
        calls: 1
      },
      limits: DEFAULT_COMPLETED_CALL_USAGE_LIMITS
    })
  })

  it('keeps cache-heavy terminal telemetry exact without treating cache reads as full guard pressure', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('claude', 'claude-cache-heavy')
    tracker.ingest('claude', JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 49_980,
        cache_read_input_tokens: 900_000,
        output_tokens: 10_000
      }
    }), true, 'claude-cache-heavy')
    tracker.finishCall('claude', 'claude-cache-heavy', 'complete')

    const [receipt] = tracker.evidenceSnapshot().calls
    expect(receipt?.totals).toMatchObject({
      processedInputTokens: 950_000,
      cachedInputTokens: 900_000,
      outputTokens: 10_000
    })
    expect(evaluateCompletedCallUsage(receipt!)).toBeUndefined()
  })

  it('preserves independent output and reasoning guards when cache-weighted input stays ordinary', () => {
    const receipt = {
      id: 'codex-output-heavy',
      agent: 'codex' as const,
      status: 'complete' as const,
      complete: true,
      source: 'terminal' as const,
      totals: {
        processedInputTokens: 950_000,
        cachedInputTokens: 900_000,
        outputTokens: DEFAULT_COMPLETED_CALL_USAGE_LIMITS.outputTokens + 1,
        reasoningTokens: DEFAULT_COMPLETED_CALL_USAGE_LIMITS.reasoningTokens + 1,
        calls: 1
      }
    }

    expect(evaluateCompletedCallUsage(receipt)).toMatchObject({
      reasons: ['output', 'reasoning'],
      effectiveInputTokens: 140_000,
      totals: receipt.totals
    })
  })

  it('never guards incomplete or ordinary completed receipts', () => {
    const tracker = new RunUsageTracker()
    tracker.beginCall('claude', 'claude-incomplete')
    tracker.finishCall('claude', 'claude-incomplete', 'cancelled')
    const [incomplete] = tracker.evidenceSnapshot().calls
    expect(evaluateCompletedCallUsage(incomplete!)).toBeUndefined()

    tracker.beginCall('claude', 'claude-normal')
    tracker.ingest('claude', JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 50_000,
        output_tokens: 4_000
      }
    }), true, 'claude-normal')
    tracker.finishCall('claude', 'claude-normal', 'complete')
    const normal = tracker.evidenceSnapshot().calls.find((receipt) => receipt.id === 'claude-normal')
    expect(evaluateCompletedCallUsage(normal!)).toBeUndefined()
  })
})
