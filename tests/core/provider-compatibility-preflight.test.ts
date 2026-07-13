import { describe, expect, it } from 'vitest'
import type { ToolHealth } from '../../src/shared/types'
import {
  buildRunPreflightReport,
  type ExpectedProviderCliContract
} from '../../src/main/providers/provider-compatibility-preflight'

const capturedAt = '2026-07-11T20:00:00.000Z'

function contract(
  agent: 'claude' | 'codex',
  override: Partial<ExpectedProviderCliContract> = {}
): ExpectedProviderCliContract {
  const claude = agent === 'claude'
  return {
    agent,
    evidence: 'verified',
    transportFormats: claude ? ['json', 'stream-json'] : ['jsonl'],
    structuredOutput: true,
    sessionResume: true,
    toolDisable: true,
    quotaResetAvailable: claude,
    efforts: claude
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    requiredStructuredTransports: claude ? ['json', 'stream-json'] : ['jsonl'],
    requireStructuredOutput: true,
    sessionResumeRequirement: 'warning',
    toolDisableRequirement: 'warning',
    ...override
  }
}

function health(
  agent: 'claude' | 'codex',
  override: Partial<ToolHealth> = {}
): ToolHealth {
  const claude = agent === 'claude'
  return {
    id: agent,
    label: claude ? 'Claude Code' : 'Codex CLI',
    command: `C:\\private-machine\\${agent}.cmd`,
    available: true,
    version: claude ? 'claude 2.1.207' : 'codex-cli 0.144.0',
    checkedAt: capturedAt,
    runtime: {
      model: claude ? 'fable' : 'gpt-5.6-sol',
      effort: 'low',
      source: 'studio'
    },
    catalog: {
      agent,
      source: claude ? 'cli-help' : 'cli-live',
      discoveredAt: capturedAt,
      models: claude
        ? [{ id: 'fable', label: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }]
        : [{ id: 'gpt-5.6-sol', label: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }]
    },
    ...override
  }
}

describe('standalone provider compatibility preflight', () => {
  it('pins deterministic verified snapshots from healthy live catalogs and verified adapter contracts', () => {
    const input = {
      capturedAt,
      tools: [health('codex'), health('claude')],
      contracts: [contract('codex'), contract('claude')],
      selections: {
        claude: { model: 'fable', effort: 'low' as const },
        codex: { model: 'gpt-5.6-sol', effort: 'max' as const }
      }
    }
    const first = buildRunPreflightReport(input)
    const second = buildRunPreflightReport({ ...input, tools: [...input.tools].reverse(), contracts: [...input.contracts].reverse() })

    expect(first).toEqual(second)
    expect(first.ready).toBe(true)
    expect(first.blockers).toEqual([])
    expect(first.warnings).toEqual([])
    expect(first.providers.claude).toMatchObject({
      agent: 'claude', source: 'verified', cliVersion: 'claude 2.1.207', models: [{ id: 'fable' }]
    })
    expect(first.providers.codex).toMatchObject({
      agent: 'codex', source: 'verified', cliVersion: 'codex-cli 0.144.0', models: [{ id: 'gpt-5.6-sol' }]
    })
    expect(Object.isFrozen(first.providers.claude)).toBe(true)
    expect(JSON.stringify(first)).not.toContain('private-machine')
  })

  it('keeps fallback catalogs and assumed adapter contracts explicitly unverified', () => {
    const claude = health('claude', {
      catalog: {
        agent: 'claude', source: 'fallback', discoveredAt: capturedAt,
        models: [{ id: 'fable', label: 'Fable', efforts: ['low', 'max'] }]
      }
    })
    const report = buildRunPreflightReport({
      capturedAt,
      tools: [claude, health('codex')],
      contracts: [contract('claude', { evidence: 'unverified' }), contract('codex')],
      selections: { claude: { model: 'fable', effort: 'low' }, codex: {} }
    })

    expect(report.ready).toBe(true)
    expect(report.providers.claude.source).toBe('unverified')
    expect(report.warnings).toContainEqual(expect.objectContaining({ agent: 'claude', code: 'capability-unverified' }))
  })

  it('blocks unavailable CLIs, missing structured transport, and missing structured output', () => {
    const report = buildRunPreflightReport({
      capturedAt,
      tools: [health('claude', { available: false }), health('codex')],
      contracts: [
        contract('claude', { transportFormats: ['text'], structuredOutput: false }),
        contract('codex')
      ],
      selections: { claude: {}, codex: {} }
    })

    expect(report.ready).toBe(false)
    expect(report.blockers.map((issue) => issue.code)).toEqual([
      'provider-unavailable',
      'structured-output-missing',
      'structured-transport-missing'
    ])
  })

  it('blocks an unsupported selected model or effort without guessing aliases', () => {
    const report = buildRunPreflightReport({
      capturedAt,
      tools: [health('claude'), health('codex')],
      contracts: [contract('claude'), contract('codex')],
      selections: {
        claude: { model: 'unknown-premium-model', effort: 'low' },
        codex: { model: 'gpt-5.6-sol', effort: 'default' as const }
      }
    })
    const effortReport = buildRunPreflightReport({
      capturedAt,
      tools: [health('claude'), health('codex')],
      contracts: [contract('claude'), contract('codex')],
      selections: {
        claude: { model: 'fable', effort: 'ultra' },
        codex: {}
      }
    })

    expect(report.blockers).toContainEqual(expect.objectContaining({ agent: 'claude', code: 'model-unsupported' }))
    expect(effortReport.blockers).toContainEqual(expect.objectContaining({ agent: 'claude', code: 'effort-unsupported' }))
  })

  it('warns when resumable sessions or tool suppression are unavailable', () => {
    const report = buildRunPreflightReport({
      capturedAt,
      tools: [health('claude'), health('codex')],
      contracts: [
        contract('claude', { sessionResume: false, toolDisable: false }),
        contract('codex')
      ],
      selections: { claude: {}, codex: {} }
    })

    expect(report.ready).toBe(true)
    expect(report.warnings.map((issue) => issue.code)).toEqual([
      'session-resume-missing',
      'tool-disable-missing'
    ])
  })
})
