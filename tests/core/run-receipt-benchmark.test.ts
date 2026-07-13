import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts', 'benchmark-run-receipts.mjs')

function execute(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: resolve('.'),
      shell: false,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: 'Recorded balanced duel',
    source: 'saved-run',
    status: 'complete',
    releaseStatus: 'ready',
    elapsedActiveMs: 900_000,
    verification: { passes: 2, failures: 0, current: true },
    contributions: {
      claude: {
        acceptedImplementation: true,
        acceptedCrossReview: true,
        completedTasks: 1,
        edits: 2,
        messages: 5
      },
      codex: {
        acceptedImplementation: true,
        acceptedCrossReview: true,
        completedTasks: 1,
        edits: 3,
        messages: 4
      }
    },
    usage: {
      claude: { processedInputTokens: 100, cachedInputTokens: 60, outputTokens: 20, calls: 2 },
      codex: { processedInputTokens: 80, cachedInputTokens: 40, outputTokens: 15, calls: 2 }
    },
    ...overrides
  }
}

describe('saved run receipt benchmark command', () => {
  it('defaults to deterministic synthetic receipts without invoking providers', async () => {
    const result = await execute(['--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      schemaVersion: 1,
      sourceMode: 'synthetic',
      providerCallsMade: 0
    })
    expect(report.entries).toHaveLength(2)
    expect(result.stdout).not.toMatch(/generatedAt|timestamp/iu)
  })

  it('compares saved receipts using readiness, balance, verification, usage, calls, and active time only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-receipt-benchmark-'))
    const balancedPath = join(root, 'balanced.json')
    const takeoverPath = join(root, 'takeover.json')
    await Promise.all([
      writeFile(balancedPath, JSON.stringify(receipt()), 'utf8'),
      writeFile(takeoverPath, JSON.stringify(receipt({
        label: 'One-agent takeover',
        releaseStatus: 'partial',
        elapsedActiveMs: 1_200_000,
        prompt: 'Private prompt must never enter the report.',
        workspacePath: 'C:\\Users\\private-owner\\hidden-run',
        contributions: {
          claude: {
            acceptedImplementation: false,
            acceptedCrossReview: true,
            completedTasks: 0,
            edits: 0,
            messages: 2
          },
          codex: {
            acceptedImplementation: true,
            acceptedCrossReview: true,
            completedTasks: 2,
            edits: 7,
            messages: 6
          }
        }
      })), 'utf8')
    ])

    const result = await execute(['--json', balancedPath, takeoverPath])

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as {
      sourceMode: string
      entries: Array<Record<string, unknown>>
    }
    expect(report.sourceMode).toBe('saved-run')
    expect(report.entries[0]).toMatchObject({
      label: 'Recorded balanced duel',
      duoReady: true,
      balancedContributions: true,
      verification: { passes: 2, failures: 0, current: true },
      usage: { processedInputTokens: 180, cachedInputTokens: 100, outputTokens: 35, calls: 4 },
      elapsedActiveMs: 900_000
    })
    expect(report.entries[1]).toMatchObject({
      label: 'One-agent takeover',
      duoReady: false,
      balancedContributions: false,
      elapsedActiveMs: 1_200_000
    })
    expect(result.stdout).not.toMatch(/Private prompt|private-owner|C:\\Users/iu)
  })

  it('rejects live mode and malformed receipts without making a provider call', async () => {
    const live = await execute(['--live'])
    expect(live.code).toBe(2)
    expect(live.stderr).toMatch(/not supported|no provider/iu)

    const root = await mkdtemp(join(tmpdir(), 'duo-invalid-receipt-'))
    const invalidPath = join(root, 'invalid.json')
    await writeFile(invalidPath, '{"schemaVersion":1,"label":"missing evidence"}', 'utf8')
    const invalid = await execute(['--json', invalidPath])
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toMatch(/invalid receipt/iu)
    expect(invalid.stdout).toBe('')
  })
})
