import { describe, expect, it } from 'vitest'
import { decodeProviderEnvelope } from '../../src/main/process/provider-envelope'
import { normalizeCliActivity, normalizeCliLine, parseCliQuotaSignal } from '../../src/main/events/normalizer'
import { extractDialogueCapsuleFromCliLine } from '../../src/main/orchestrator/dialogue-capsule'
import { parseProviderUsageLine } from '../../src/main/orchestrator/usage-telemetry'
import { extractAgentSessionId } from '../../src/main/process/session-continuity'

const capsule = {
  opening: {
    publicText: 'Keep the [FEATURE] focused and immediately readable.',
    privateText: 'Keep the placeholder feature focused and immediately readable.'
  },
  counter: {
    publicText: 'Agreed, and give the [FEATURE] an accessible alternate input.',
    privateText: 'Agreed, and give the placeholder feature an accessible alternate input.'
  },
  verdict: {
    publicText: 'Ship the focused [FEATURE] with both input paths.',
    privateText: 'Ship the focused placeholder feature with both input paths.'
  },
  opinion: {
    publicText: 'The smaller [FEATURE] is stronger because it is testable.',
    privateText: 'The smaller placeholder feature is stronger because it is testable.',
    tone: 'confident'
  },
  tasks: [],
  pitches: [
    { title: 'Placeholder One', idea: 'Synthetic fixture one.', appeal: 'Small.', risk: 'None.' },
    { title: 'Placeholder Two', idea: 'Synthetic fixture two.', appeal: 'Clear.', risk: 'None.' }
  ],
  consensus: null,
  redactions: [
    { value: 'placeholder feature', label: 'FEATURE' },
    { value: 'Placeholder One', label: 'APP_NAME' },
    { value: 'Placeholder Two', label: 'APP_NAME' }
  ]
} as const

const claudeSessionId = 'c3aead27-8052-44db-8284-c588d31552a7'

function claudeArrayEnvelope(quotaStatus: 'allowed' | 'allowed_warning' | 'rejected' = 'allowed'): string {
  return JSON.stringify([
    { type: 'system', subtype: 'init', session_id: claudeSessionId },
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: quotaStatus,
        resetsAt: 1_783_771_800,
        rateLimitType: 'five_hour',
        overageStatus: quotaStatus === 'rejected' ? 'rejected' : 'allowed'
      }
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic private fixture' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'synthetic tool fixture' }] } },
    {
      type: 'result',
      subtype: 'success',
      structured_output: capsule,
      total_cost_usd: 0.125,
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 4_000,
        output_tokens: 500
      }
    }
  ])
}

describe('canonical provider envelope decoder', () => {
  it('decodes individual records and nested batches without descending into provider message content', () => {
    const individual = { type: 'turn.completed', usage: { input_tokens: 10 } }
    expect(decodeProviderEnvelope(JSON.stringify(individual))).toEqual([individual])

    const nested = JSON.stringify({
      batch: {
        events: [
          { type: 'system', subtype: 'init', session_id: claudeSessionId },
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SyntheticTool' }] } }
        ]
      }
    })
    expect(decodeProviderEnvelope(nested).map((record) => record.type)).toEqual(['system', 'assistant'])
  })

  it('recovers capsule, usage, session, quota, and meaningful activity from a Claude 2.1.207 array envelope', () => {
    const envelope = claudeArrayEnvelope()

    expect(extractDialogueCapsuleFromCliLine('claude', envelope)).toEqual(capsule)
    expect(parseProviderUsageLine('claude', envelope)).toEqual({
      processedInputTokens: 5_025,
      cachedInputTokens: 4_000,
      outputTokens: 500,
      reasoningTokens: 0,
      calls: 1,
      reportedCostUsd: 0.125
    })
    expect(extractAgentSessionId('claude', envelope)).toBe(claudeSessionId)
    expect(parseCliQuotaSignal(envelope)).toEqual({
      status: 'allowed',
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      resetAt: new Date(1_783_771_800_000).toISOString()
    })

    const context = { runId: 'synthetic-run', round: 1, source: 'claude' as const, stream: 'stdout' as const }
    const activity = normalizeCliActivity(envelope, context)
    const log = normalizeCliLine(envelope, context)
    expect(activity).toMatchObject({ publicText: 'Claude completed its private turn.', category: 'status' })
    expect(log).toMatchObject({ publicText: 'Claude completed its private turn.', category: 'status' })
    expect(activity?.publicText).not.toMatch(/private CLI signal/i)
    expect(log.publicText).not.toMatch(/private CLI signal/i)
  })

  it.each(['allowed_warning', 'rejected'] as const)('finds a %s quota signal inside a batch', (status) => {
    expect(parseCliQuotaSignal(claudeArrayEnvelope(status))).toMatchObject({ status, rateLimitType: 'five_hour' })
  })

  it.each([
    ['allowed then rejected', ['allowed', 'rejected']],
    ['rejected then allowed', ['rejected', 'allowed']]
  ] as const)('keeps a rejected quota signal dominant when a Claude batch is %s', (_label, statuses) => {
    const envelope = JSON.stringify(statuses.map((status) => ({
      type: 'rate_limit_event',
      rate_limit_info: {
        status,
        rateLimitType: 'five_hour',
        overageStatus: status
      }
    })))

    expect(parseCliQuotaSignal(envelope)).toMatchObject({
      status: 'rejected',
      rateLimitType: 'five_hour',
      overageStatus: 'rejected'
    })
  })

  it('keeps useful reset metadata while a sparse rejected record wins the batch', () => {
    const resetAt = new Date(1_783_771_800_000).toISOString()
    const envelope = JSON.stringify([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          resetsAt: 1_783_771_800
        }
      },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }
    ])

    expect(parseCliQuotaSignal(envelope)).toEqual({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetAt
    })
  })

  it('extracts a same-day reset from Codex natural usage-limit errors', () => {
    const now = new Date(2026, 6, 12, 4, 30)
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit. Try again at 7:01 AM." }
    })
    expect(parseCliQuotaSignal(line, now)).toEqual({
      status: 'rejected',
      resetAt: new Date(2026, 6, 12, 7, 1).toISOString()
    })
  })

  it.each([
    {
      label: 'same-day morning',
      now: new Date(2026, 6, 12, 4, 30),
      message: "You've hit your usage limit. Try again at 7:01 AM.",
      expected: new Date(2026, 6, 12, 7, 1)
    },
    {
      label: 'next-day morning',
      now: new Date(2026, 6, 12, 8, 30),
      message: "You've hit your usage limit. Try again at 7:01 AM.",
      expected: new Date(2026, 6, 13, 7, 1)
    },
    {
      label: 'noon',
      now: new Date(2026, 6, 12, 11, 30),
      message: 'Usage limit reached. Resets at 12:00 PM.',
      expected: new Date(2026, 6, 12, 12, 0)
    },
    {
      label: 'midnight',
      now: new Date(2026, 6, 12, 23, 30),
      message: 'Usage limit reached. Resets at 12:00 AM.',
      expected: new Date(2026, 6, 13, 0, 0)
    }
  ])('parses a $label natural quota reset without losing the local calendar boundary', ({ now, message, expected }) => {
    const line = JSON.stringify([{ type: 'error', message }])
    expect(parseCliQuotaSignal(line, now)).toEqual({
      status: 'rejected',
      resetAt: expected.toISOString()
    })
  })
})
