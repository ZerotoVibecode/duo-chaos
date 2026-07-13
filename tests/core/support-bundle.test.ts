import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createSupportBundle,
  SupportBundleIdentityError
} from '../../src/main/diagnostics/support-bundle'

const RUN_ID = 'duo-run-support-a1b2'

async function fixture(): Promise<{ root: string; runtimePath: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'duo-support-bundle-'))
  const runtimePath = join(root, 'runtime', RUN_ID)
  const workspacePath = join(root, 'workspaces', RUN_ID)
  await Promise.all([
    mkdir(join(runtimePath, 'public'), { recursive: true }),
    mkdir(join(runtimePath, 'private', 'raw'), { recursive: true }),
    mkdir(join(workspacePath, '.duo', 'sealed'), { recursive: true }),
    mkdir(join(workspacePath, 'app'), { recursive: true })
  ])
  return { root, runtimePath, workspacePath }
}

async function writeState(runtimePath: string, workspacePath: string): Promise<void> {
  await Promise.all([
    writeFile(join(runtimePath, 'run.json'), `${JSON.stringify({
      runId: RUN_ID,
      workspacePath,
      status: 'paused',
      phase: 'round.code',
      prompt: 'Build Velvet Oracle for private@example.com.',
      failureCode: 'Bearer this-value-must-never-leave-the-machine',
      agentUsage: {
        claude: {
          processedInputTokens: 120,
          cachedInputTokens: 80,
          outputTokens: 30,
          reasoningTokens: 0,
          calls: 2,
          reportedCostUsd: 0.12,
          largestRawLineBytes: 99
        },
        codex: {
          processedInputTokens: 50,
          cachedInputTokens: 20,
          outputTokens: 10,
          reasoningTokens: 4,
          calls: 1,
          largestRawLineBytes: 70
        }
      }
    })}\n`, 'utf8'),
    writeFile(join(runtimePath, 'run-manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      workspaceId: 'workspace-support-a1b2',
      status: 'paused',
      request: { prompt: 'Velvet Oracle hidden idea text' },
      cursor: { turnIndex: 3, stage: 'work', attempt: 2, idempotencyKey: 'private-key' },
      usage: {
        claude: { processedInputTokens: 120, cachedInputTokens: 80, outputTokens: 30, reasoningTokens: 0, calls: 2, reportedCostUsd: 0.12 },
        codex: { processedInputTokens: 50, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 4, calls: 1 }
      },
      pause: {
        reason: 'provider-quota',
        agent: 'claude',
        pausedAt: '2026-07-11T18:00:00.000Z',
        resetAt: '2026-07-11T21:00:00.000Z',
        detailCode: 'rate-limit'
      }
    })}\n`, 'utf8'),
    writeFile(join(runtimePath, 'public', 'timeline.jsonl'), [
      JSON.stringify({ type: 'run.started', publicText: 'C:\\Users\\private-owner\\secret' }),
      JSON.stringify({ type: 'agent.started', agent: 'claude' }),
      JSON.stringify({ type: 'agent.started', agent: 'codex' }),
      JSON.stringify({ type: 'agent.dispatch', publicText: 'Velvet Oracle' }),
      '{broken-final-line'
    ].join('\n'), 'utf8'),
    writeFile(join(runtimePath, 'private', 'transcript.jsonl'), 'private@example.com Velvet Oracle\n', 'utf8'),
    writeFile(join(runtimePath, 'private', 'raw', 'claude.jsonl'), 'OPENAI_API_KEY=super-secret-value\n', 'utf8'),
    writeFile(join(workspacePath, '.duo', 'sealed', 'redactions.json'), JSON.stringify({
      terms: [{ value: 'Velvet Oracle', label: 'APP_NAME' }]
    }), 'utf8'),
    writeFile(join(workspacePath, 'app', 'velvet-oracle.js'), 'console.log("hidden implementation")\n', 'utf8'),
    writeFile(join(workspacePath, 'app', 'index.html'), '<!doctype html>\n', 'utf8')
  ])
}

describe('privacy-safe diagnostic support bundles', () => {
  it('emits only bounded diagnostic facts and strips private content, paths, identities, and secrets', async () => {
    const { runtimePath, workspacePath } = await fixture()
    await writeState(runtimePath, workspacePath)

    const bundle = await createSupportBundle({
      runtimePath,
      workspacePath,
      runId: RUN_ID,
      failureCode: 'private@example.com',
      capabilities: {
        claude: {
          cliVersion: 'Claude Code 2.1.207 C:\\Users\\private-owner private@example.com',
          adapterVersion: 'claude-v1',
          streamFormat: 'json-array',
          structuredOutput: true,
          sessionResume: true
        },
        codex: {
          cliVersion: 'codex-cli 0.144.0 Bearer abcdefghijklmnopqrstuvwxyz',
          adapterVersion: 'codex-v1',
          streamFormat: 'jsonl',
          structuredOutput: true,
          sessionResume: true
        }
      }
    })

    expect(bundle.report).toMatchObject({
      schemaVersion: 1,
      runId: RUN_ID,
      status: 'paused',
      phase: 'round.code',
      pause: { reason: 'provider-quota', agent: 'claude', detailCode: 'rate-limit' },
      cursor: { turnIndex: 3, stage: 'work', attempt: 2 },
      events: {
        total: 4,
        invalidLines: 1,
        byType: { 'run.started': 1, 'agent.started': 2, 'agent.dispatch': 1 }
      },
      usage: {
        claude: { processedInputTokens: 120, outputTokens: 30, calls: 2 },
        codex: { processedInputTokens: 50, outputTokens: 10, calls: 1 },
        total: { processedInputTokens: 170, outputTokens: 40, calls: 3 }
      },
      capabilities: {
        claude: { cliVersion: '2.1.207', streamFormat: 'json-array' },
        codex: { cliVersion: '0.144.0', streamFormat: 'jsonl' }
      }
    })
    expect(bundle.report.failureCode).toBe('other')
    expect(bundle.report.files.some((file) => file.path === 'app/[PRIVATE].js')).toBe(true)
    expect(bundle.report.files.some((file) => file.path === 'app/index.html')).toBe(true)
    expect(bundle.report.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true)

    for (const output of [bundle.json, bundle.text, JSON.stringify(bundle.report)]) {
      expect(output).not.toMatch(/Velvet Oracle/iu)
      expect(output).not.toMatch(/private-owner|private@example\.com/iu)
      expect(output).not.toMatch(/[A-Z]:\\Users\\/iu)
      expect(output).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]+/iu)
      expect(output).not.toMatch(/OPENAI_API_KEY|super-secret-value/iu)
      expect(output).not.toMatch(/transcript|private\/raw|claude\.jsonl/iu)
    }
  })

  it('rejects mismatched run and workspace identities before producing a report', async () => {
    const { runtimePath, workspacePath } = await fixture()
    await writeState(runtimePath, workspacePath)
    await writeFile(join(runtimePath, 'run.json'), `${JSON.stringify({
      runId: 'duo-run-someone-else',
      workspacePath,
      status: 'failed'
    })}\n`, 'utf8')

    await expect(createSupportBundle({ runtimePath, workspacePath, runId: RUN_ID }))
      .rejects.toBeInstanceOf(SupportBundleIdentityError)

    await writeFile(join(runtimePath, 'run.json'), `${JSON.stringify({
      runId: RUN_ID,
      workspacePath: join(workspacePath, '..', 'duo-run-different-workspace'),
      status: 'failed'
    })}\n`, 'utf8')

    await expect(createSupportBundle({ runtimePath, workspacePath, runId: RUN_ID }))
      .rejects.toThrow(/workspace identity/i)
  })

  it('caps input reads, file inventory, and both serialized outputs', async () => {
    const { runtimePath, workspacePath } = await fixture()
    await writeState(runtimePath, workspacePath)
    const events = Array.from({ length: 200 }, (_, index) => JSON.stringify({
      type: index % 2 === 0 ? 'agent.activity' : 'agent.dispatch',
      publicText: `private payload ${'x'.repeat(200)}`
    })).join('\n')
    await writeFile(join(runtimePath, 'public', 'timeline.jsonl'), events, 'utf8')
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(workspacePath, 'app', `module-${String(index)}.js`), 'x'.repeat(2_000), 'utf8')
    }

    const bundle = await createSupportBundle({
      runtimePath,
      workspacePath,
      runId: RUN_ID,
      maxInputFileBytes: 1_024,
      maxFiles: 8,
      maxOutputBytes: 4_096
    })

    expect(Buffer.byteLength(bundle.json, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(Buffer.byteLength(bundle.text, 'utf8')).toBeLessThanOrEqual(4_096)
    expect(bundle.report.files.length).toBeLessThanOrEqual(8)
    expect(bundle.report.limits.inputTruncated).toBe(true)
    expect(bundle.report.limits.inventoryTruncated).toBe(true)
    expect(bundle.report.events.truncated).toBe(true)
  })
})
