import { describe, expect, it } from 'vitest'
import { normalizeCliActivity, normalizeCliLine, normalizeEvent, parseCliQuotaSignal } from '../../src/main/events/normalizer'

describe('event normalizer', () => {
  it('normalizes legacy opinion aliases into the canonical contract', () => {
    const event = normalizeEvent(
      {
        id: 'legacy-1',
        type: 'opinion',
        agent: 'claude',
        target: 'codex',
        mood: 'skeptical',
        public: 'Claude objects to the [REDACTED] scope.',
        private: 'Claude objects to the duel scope.',
        spoilerRisk: true,
        confidence: 0.73,
        createdAt: '2026-07-09T12:00:00.000Z'
      },
      { runId: 'run-1', round: 2 }
    )

    expect(event).toMatchObject({
      type: 'opinion',
      runId: 'run-1',
      round: 2,
      agent: 'claude',
      targetAgent: 'codex',
      tone: 'skeptical',
      publicText: 'Claude objects to the [REDACTED] scope.',
      privateText: 'Claude objects to the duel scope.',
      spoilerRisk: 0.85,
      confidence: 0.73
    })
  })

  it('converts string risk levels and clamps numeric confidence', () => {
    const event = normalizeEvent(
      {
        type: 'opinion',
        agent: 'codex',
        tone: 'confident',
        publicText: 'Codex prefers the smaller route.',
        spoilerRisk: 'low',
        confidence: 9,
        timestamp: '2026-07-09T12:00:00.000Z'
      },
      { runId: 'run-2', round: 1 }
    )

    expect(event.spoilerRisk).toBe(0.25)
    expect(event.confidence).toBe(1)
  })

  it('does not invent confidence or heat when a real agent did not report them', () => {
    const event = normalizeEvent(
      {
        type: 'product-opinion',
        agent: 'codex',
        publicText: 'Codex backs the smaller [FEATURE].'
      },
      { runId: 'legacy-real-run', round: 2 }
    )

    expect(event.confidence).toBeUndefined()
    expect(event.heat).toBeUndefined()
  })

  it('normalizes concise agent dispatches without changing the quoted public text', () => {
    const event = normalizeEvent(
      {
        id: 'claude-r4-counter',
        type: 'counter',
        agent: 'claude',
        targetAgent: 'codex',
        dispatchKind: 'counter',
        claimKey: 'interaction',
        replyTo: 'codex-r3-challenge',
        publicText: 'Codex has a runnable core. It still feels like a settings page wearing a gradient.',
        privateText: 'Private implementation detail.',
        spoilerRisk: 0.05
      },
      { runId: 'run-broadcast', round: 4 }
    )

    expect(event).toMatchObject({
      type: 'agent.dispatch',
      dispatchKind: 'counter',
      claimKey: 'interaction',
      replyTo: 'codex-r3-challenge',
      publicText: 'Codex has a runnable core. It still feels like a settings page wearing a gradient.'
    })
  })

  it('keeps invalid JSONL as a safe raw log event', () => {
    const event = normalizeCliLine('not-json but still useful', {
      runId: 'run-3',
      round: 4,
      source: 'codex',
      stream: 'stdout'
    })

    expect(event).toMatchObject({
      type: 'cli.log',
      source: 'codex',
      category: 'message',
      publicText: 'Codex emitted a private CLI message.',
      privateText: 'not-json but still useful'
    })
  })

  it.each([
    ['product-opinion', 'confident'],
    ['critique', 'skeptical'],
    ['implementation-opinion', 'collaborative'],
    ['review', 'cautious'],
    ['design-review', 'cautious'],
    ['verification-opinion', 'cautious'],
    ['wrap-opinion', 'impressed']
  ] as const)('normalizes the real-run %s alias into a visible opinion', (type, tone) => {
    const event = normalizeEvent(
      { type, agent: 'codex', publicText: 'Codex challenges the current [FEATURE] tradeoff.' },
      { runId: 'real-run', round: 3 }
    )

    expect(event).toMatchObject({
      type: 'opinion',
      topic: type,
      tone,
      targetAgent: 'claude'
    })
  })

  it('turns a Codex command into a spoiler-safe live activity event', () => {
    const line = JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'npm test -- secret-feature' }
    })
    const context = { runId: 'run-live', round: 7, source: 'codex' as const, stream: 'stdout' as const }

    expect(normalizeCliLine(line, context)).toMatchObject({
      type: 'cli.log',
      category: 'command',
      publicText: 'Codex is testing the current build.'
    })
    expect(normalizeCliLine(line, context).publicText).not.toContain('secret-feature')
    expect(normalizeCliActivity(line, context)).toMatchObject({
      type: 'agent.activity',
      agent: 'codex',
      category: 'command',
      publicText: 'Codex is testing the current build.'
    })
  })

  it('turns a Claude edit tool call into a safe file activity without leaking its target', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'app/secret-orb.html' } }]
      }
    })
    const activity = normalizeCliActivity(line, {
      runId: 'run-live',
      round: 8,
      source: 'claude',
      stream: 'stdout'
    })

    expect(activity).toMatchObject({
      type: 'agent.activity',
      category: 'file',
      publicText: 'Claude is editing a workspace file.'
    })
    expect(JSON.stringify(activity)).not.toContain('secret-orb')
  })

  it('keeps Codex agent messages private until reveal instead of streaming hidden nouns', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'The secret orb mechanic is now ready.' }
    })
    const event = normalizeCliLine(line, {
      runId: 'run-live',
      round: 7,
      source: 'codex',
      stream: 'stdout'
    })

    expect(event.publicText).toBe('Codex recorded a private progress update.')
    expect(event.publicText).not.toContain('secret orb')
    expect(event.privateText).toContain('secret orb')
  })

  it.each([
    [{ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } }, 'Codex finished a verification command.', 'command'],
    [{ type: 'item.started', item: { type: 'command_execution', command: 'Get-Content private-file' } }, 'Codex is inspecting the shared workspace.', 'command'],
    [{ type: 'item.started', item: { type: 'command_execution', command: 'git status' } }, 'Codex is checking repository evidence.', 'command'],
    [{ type: 'item.started', item: { type: 'command_execution', command: 'npm start' } }, 'Codex is running a workspace command.', 'command'],
    [{ type: 'item.completed', item: { type: 'command_execution', command: 'npm start' } }, 'Codex completed a workspace command.', 'command'],
    [{ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 1 } }, 'Codex hit a failed workspace command and is adjusting.', 'error'],
    [{ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'failed' } }, 'Codex hit a failed workspace command and is adjusting.', 'error'],
    [{ type: 'item.started', item: { type: 'file_change' } }, 'Codex is preparing a workspace edit.', 'file'],
    [{ type: 'item.completed', item: { type: 'file_change', changes: [{}] } }, 'Codex changed 1 workspace file.', 'file'],
    [{ type: 'item.completed', item: { type: 'file_change', changes: [{}, {}] } }, 'Codex changed 2 workspace files.', 'file'],
    [{ type: 'turn.started' }, 'Codex started its private turn.', 'status'],
    [{ type: 'turn.completed' }, 'Codex completed its private turn.', 'status'],
    [{ type: 'result' }, 'Codex completed its private turn.', 'status'],
    [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, 'Codex confirmed the current session can continue.', 'status']
  ] as const)('summarizes Codex signal %# without exposing command details', (payload, publicText, category) => {
    const activity = normalizeCliActivity(JSON.stringify(payload), {
      runId: 'run-codex-signals', round: 3, source: 'codex', stream: 'stdout'
    })
    expect(activity).toMatchObject({ publicText, category })
  })

  it.each([
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } },
      'Codex completed a workspace command.'
    ],
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'echo build passed', exit_code: 0 } },
      'Codex completed a workspace command.'
    ],
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm start -- --check', exit_code: 0 } },
      'Codex completed a workspace command.'
    ],
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test || true', exit_code: 0 } },
      'Codex completed a workspace command.'
    ],
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test; echo done', exit_code: 0 } },
      'Codex completed a workspace command.'
    ],
    [
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test | tee output.txt', exit_code: 0 } },
      'Codex completed a workspace command.'
    ]
  ] as const)('does not certify an ambiguous command completion %# as verification', (payload, publicText) => {
    const activity = normalizeCliActivity(JSON.stringify(payload), {
      runId: 'run-unverified-command', round: 6, source: 'codex', stream: 'stdout'
    })

    expect(activity).toMatchObject({ publicText, category: 'command' })
    expect(activity?.metadata).not.toMatchObject({ verificationPassed: true })
  })

  it.each([
    'npm run build',
    'pnpm run typecheck',
    'npx vitest run',
    'python -m pytest',
    'cargo test',
    'npm test 2>&1',
    'cd app && npm test',
    'powershell.exe -Command "npm run lint"'
  ])('records explicit successful verification command %s as trusted evidence', (command) => {
    const activity = normalizeCliActivity(JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command, exit_code: 0 }
    }), {
      runId: 'run-verified-command', round: 7, source: 'codex', stream: 'stdout'
    })

    expect(activity).toMatchObject({
      publicText: 'Codex finished a verification command.',
      category: 'command',
      metadata: { verificationPassed: true }
    })
  })

  it('records a successful workspace inspection without pretending it verified the build', () => {
    const activity = normalizeCliActivity(JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'Get-Content app/index.html', exit_code: 0 }
    }), {
      runId: 'run-inspected-command', round: 6, source: 'codex', stream: 'stdout'
    })

    expect(activity).toMatchObject({
      publicText: 'Codex is inspecting the shared workspace.',
      category: 'command',
      metadata: { commandCompleted: true }
    })
    expect(activity?.metadata).not.toMatchObject({ verificationPassed: true })
  })

  it.each([
    ['Read', { file_path: 'secret.ts' }, 'Claude is inspecting the shared workspace.', 'command'],
    ['Bash', { command: 'npm build secret-feature' }, 'Claude is testing the current build.', 'command'],
    ['CustomTool', { secret: 'hidden' }, 'Claude started a private CustomTool tool step.', 'status']
  ] as const)('summarizes Claude %s tool use safely', (name, input, publicText, category) => {
    const activity = normalizeCliActivity(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input }] }
    }), { runId: 'run-claude-signals', round: 4, source: 'claude', stream: 'stdout' })
    expect(activity).toMatchObject({ publicText, category })
    expect(JSON.stringify(activity)).not.toMatch(/secret-feature|secret\.ts|hidden/)
  })

  it('certifies a recognizable Claude Bash verifier only after its matching successful tool result', () => {
    const state = { pendingClaudeVerificationToolUses: new Set<string>() }
    const context = { runId: 'run-claude-verification', round: 7, source: 'claude' as const, stream: 'stdout' as const }
    const started = normalizeCliActivity(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_verifier',
          name: 'Bash',
          input: { command: 'npm test' }
        }]
      }
    }), context, state)
    const completed = normalizeCliActivity(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_verifier',
          content: 'All tests passed.',
          is_error: false
        }]
      }
    }), context, state)

    expect(started).toMatchObject({
      publicText: 'Claude is testing the current build.',
      category: 'command'
    })
    expect(started?.metadata).not.toMatchObject({ verificationPassed: true })
    expect(completed).toMatchObject({
      publicText: 'Claude finished a verification command.',
      category: 'command',
      metadata: { verificationPassed: true }
    })
  })

  it.each([
    [
      'unrelated Bash command',
      { id: 'toolu_other', command: 'echo looks good' },
      { tool_use_id: 'toolu_other', is_error: false }
    ],
    [
      'mismatched tool result',
      { id: 'toolu_expected', command: 'npm run build' },
      { tool_use_id: 'toolu_wrong', is_error: false }
    ],
    [
      'failed tool result',
      { id: 'toolu_failed', command: 'npm run typecheck' },
      { tool_use_id: 'toolu_failed', is_error: true }
    ],
    [
      'ambiguous tool result',
      { id: 'toolu_ambiguous', command: 'npm run lint' },
      { tool_use_id: 'toolu_ambiguous' }
    ]
  ] as const)('does not certify Claude verification from an %s', (_label, tool, result) => {
    const state = { pendingClaudeVerificationToolUses: new Set<string>() }
    const context = { runId: 'run-claude-untrusted', round: 8, source: 'claude' as const, stream: 'stdout' as const }
    const started = normalizeCliActivity(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: tool.id,
          name: 'Bash',
          input: { command: tool.command }
        }]
      }
    }), context, state)
    const completed = normalizeCliActivity(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', ...result, content: 'private provider output' }]
      }
    }), context, state)

    expect(started?.metadata).not.toMatchObject({ verificationPassed: true })
    expect(completed?.metadata).not.toMatchObject({ verificationPassed: true })
  })

  it('does not certify a Claude verifier when no tool result arrives', () => {
    const state = { pendingClaudeVerificationToolUses: new Set<string>() }
    const activity = normalizeCliActivity(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_missing_result',
          name: 'Bash',
          input: { command: 'npx vitest run' }
        }]
      }
    }), {
      runId: 'run-claude-missing-result', round: 8, source: 'claude', stream: 'stdout'
    }, state)

    expect(activity?.metadata).not.toMatchObject({ verificationPassed: true })
  })

  it('treats any failed matched Claude verifier as dominant within one tool-result message', () => {
    const state = { pendingClaudeVerificationToolUses: new Set<string>() }
    const context = { runId: 'run-claude-mixed-results', round: 8, source: 'claude' as const, stream: 'stdout' as const }
    normalizeCliActivity(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_pass', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'toolu_fail', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    }), context, state)
    const outcome = normalizeCliActivity(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_pass', content: 'tests passed', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_fail', content: 'build failed', is_error: true }
        ]
      }
    }), context, state)

    expect(outcome).toMatchObject({
      category: 'error',
      metadata: { verificationFailed: true }
    })
    expect(outcome?.metadata).not.toMatchObject({ verificationPassed: true })
  })

  it('handles reasoning, stderr, ignored protocol events, and meaningless private signals honestly', () => {
    const context = { runId: 'run-mixed-signals', round: 5, source: 'claude' as const, stream: 'stdout' as const }
    expect(normalizeCliActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hidden idea' }] } }), context))
      .toMatchObject({ publicText: 'Claude is evaluating the next move.', category: 'reasoning' })
    expect(normalizeCliActivity('private failure detail', { ...context, stream: 'stderr' }))
      .toMatchObject({ publicText: 'Claude reported a private CLI error.', category: 'error' })
    expect(normalizeCliActivity(JSON.stringify({ type: 'opinion', publicText: 'Public opinion' }), context)).toBeUndefined()
    expect(normalizeCliActivity(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }), context))
      .toMatchObject({ topic: 'quota-pressure', category: 'error', severity: 'high' })
  })

  it('classifies failing stderr output as an error', () => {
    const event = normalizeCliLine('Build failed: missing module', {
      runId: 'run-4',
      round: 6,
      source: 'claude',
      stream: 'stderr'
    })

    expect(event).toMatchObject({ category: 'error', severity: 'high' })
  })

  it.each([
    ['running command npm test', 'command'],
    ['created file src/App.tsx', 'file'],
    ['status complete', 'status'],
    ['ordinary agent message', 'message']
  ] as const)('classifies plain output %s as %s', (line, category) => {
    expect(
      normalizeCliLine(line, {
        runId: 'run-categories',
        round: 1,
        source: 'codex',
        stream: 'stdout'
      }).category
    ).toBe(category)
  })

  it('extracts nested display text from parsed CLI JSON', () => {
    const event = normalizeCliLine(JSON.stringify({ item: { text: 'Nested tool status complete' } }), {
      runId: 'run-json',
      round: 3,
      source: 'claude',
      stream: 'stdout'
    })
    expect(event).toMatchObject({ publicText: 'Nested tool status complete', category: 'status' })
  })

  it('falls back safely for malformed or sparse event shapes', () => {
    const event = normalizeEvent(null, { runId: 'fallback', round: 7 })
    expect(event).toMatchObject({
      type: 'cli.log',
      runId: 'fallback',
      round: 7,
      agent: 'system',
      publicText: 'Activity received.',
      spoilerRisk: 0.1,
      severity: 'medium'
    })
    expect(event.confidence).toBeUndefined()
    expect(event.heat).toBeUndefined()
  })

  it.each([
    [false, 0.05],
    ['none', 0.05],
    ['medium', 0.55],
    ['high', 0.85],
    ['critical', 1],
    ['unknown', 0.1]
  ])('normalizes spoiler risk %s', (risk, expected) => {
    expect(
      normalizeEvent(
        { type: 'opinion', source: 'referee', publicText: 'Safe', spoilerRisk: risk },
        { runId: 'risks', round: 1 }
      )
    ).toMatchObject({ spoilerRisk: expected, agent: 'director' })
  })

  it('preserves provider utilization so the scheduler can pause before a doomed premium call', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.96,
        surpassedThreshold: 0.9,
        resetsAt: 1_783_893_600
      }
    })

    expect(parseCliQuotaSignal(line)).toMatchObject({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.96,
      warningThreshold: 0.9
    })
    expect(normalizeCliActivity(line, {
      runId: 'run-quota-utilization', round: 5, source: 'claude', stream: 'stdout'
    })?.metadata).toMatchObject({ quotaStatus: 'allowed_warning', utilization: 0.96 })
  })
})
