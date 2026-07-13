#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_RECEIPT_BYTES = 256_000
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u

const syntheticReceipts = [
  {
    schemaVersion: 1,
    label: 'Synthetic balanced Duo',
    source: 'synthetic',
    status: 'complete',
    releaseStatus: 'ready',
    elapsedActiveMs: 840_000,
    verification: { passes: 2, failures: 0, current: true },
    contributions: {
      claude: { acceptedImplementation: true, acceptedCrossReview: true, completedTasks: 1, edits: 2, messages: 4 },
      codex: { acceptedImplementation: true, acceptedCrossReview: true, completedTasks: 1, edits: 3, messages: 4 }
    },
    usage: {
      claude: { processedInputTokens: 120, cachedInputTokens: 80, outputTokens: 24, reasoningTokens: 0, calls: 2 },
      codex: { processedInputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 8, calls: 2 }
    }
  },
  {
    schemaVersion: 1,
    label: 'Synthetic single-agent baseline',
    source: 'synthetic',
    status: 'complete',
    releaseStatus: 'partial',
    elapsedActiveMs: 600_000,
    verification: { passes: 1, failures: 0, current: true },
    contributions: {
      claude: { acceptedImplementation: false, acceptedCrossReview: false, completedTasks: 0, edits: 0, messages: 0 },
      codex: { acceptedImplementation: true, acceptedCrossReview: false, completedTasks: 1, edits: 5, messages: 2 }
    },
    usage: {
      claude: { processedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0 },
      codex: { processedInputTokens: 150, cachedInputTokens: 90, outputTokens: 30, reasoningTokens: 10, calls: 3 }
    }
  }
]

function recordOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeCode(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLocaleLowerCase()
  return SAFE_CODE.test(normalized) ? normalized : undefined
}

function safeLabel(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, 80)
  if (!trimmed || /(?:[A-Za-z]:\\|\\\\|@|Bearer\s|\bsk-|\bgh[pousr]_)/iu.test(trimmed)) return fallback
  return /^[A-Za-z0-9][A-Za-z0-9 ._()/-]*$/u.test(trimmed) ? trimmed : fallback
}

function contributionOf(value, label) {
  const contribution = recordOf(value)
  if (!contribution) throw new Error(`Invalid receipt: missing ${label} contribution.`)
  const completedTasks = nonNegativeInteger(contribution.completedTasks)
  const edits = nonNegativeInteger(contribution.edits)
  const messages = nonNegativeInteger(contribution.messages)
  if (completedTasks === undefined || edits === undefined || messages === undefined) {
    throw new Error(`Invalid receipt: malformed ${label} contribution totals.`)
  }
  return {
    acceptedImplementation: contribution.acceptedImplementation === true,
    acceptedCrossReview: contribution.acceptedCrossReview === true,
    completedTasks,
    edits,
    messages
  }
}

function usageOf(value, label) {
  const usage = recordOf(value)
  if (!usage) throw new Error(`Invalid receipt: missing ${label} usage.`)
  const processedInputTokens = nonNegativeNumber(usage.processedInputTokens)
  const cachedInputTokens = nonNegativeNumber(usage.cachedInputTokens)
  const outputTokens = nonNegativeNumber(usage.outputTokens)
  const reasoningTokens = nonNegativeNumber(usage.reasoningTokens) ?? 0
  const calls = nonNegativeInteger(usage.calls)
  if (processedInputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined || calls === undefined) {
    throw new Error(`Invalid receipt: malformed ${label} usage.`)
  }
  return { processedInputTokens, cachedInputTokens, outputTokens, reasoningTokens, calls }
}

function sumUsage(left, right) {
  return {
    processedInputTokens: left.processedInputTokens + right.processedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    calls: left.calls + right.calls
  }
}

function normalizeReceipt(value, index) {
  const receipt = recordOf(value)
  if (!receipt || receipt.schemaVersion !== 1) throw new Error('Invalid receipt: expected schemaVersion 1.')
  const status = safeCode(receipt.status)
  const releaseStatus = safeCode(receipt.releaseStatus)
  const elapsedActiveMs = nonNegativeInteger(receipt.elapsedActiveMs)
  const verification = recordOf(receipt.verification)
  const contributions = recordOf(receipt.contributions)
  const usage = recordOf(receipt.usage)
  const passes = nonNegativeInteger(verification?.passes)
  const failures = nonNegativeInteger(verification?.failures)
  if (!status || !releaseStatus || elapsedActiveMs === undefined || passes === undefined || failures === undefined || !verification) {
    throw new Error('Invalid receipt: missing readiness, verification, or active-time evidence.')
  }
  const claude = contributionOf(contributions?.claude, 'Claude')
  const codex = contributionOf(contributions?.codex, 'Codex')
  const claudeUsage = usageOf(usage?.claude, 'Claude')
  const codexUsage = usageOf(usage?.codex, 'Codex')
  const smallerEditCount = Math.min(claude.edits, codex.edits)
  const largerEditCount = Math.max(claude.edits, codex.edits)
  const editRatioBalanced = smallerEditCount > 0 && largerEditCount / smallerEditCount <= 4
  const balancedContributions = [claude, codex].every((agent) =>
    agent.acceptedImplementation && agent.acceptedCrossReview && agent.completedTasks > 0 && agent.edits > 0
  ) && editRatioBalanced
  const verifiedReady = ['complete', 'reveal-ready'].includes(status) && releaseStatus === 'ready' &&
    verification.current === true && passes > 0 && failures === 0

  return {
    label: safeLabel(receipt.label, `Receipt ${String(index + 1)}`),
    source: receipt.source === 'synthetic' ? 'synthetic' : 'saved-run',
    duoReady: verifiedReady && balancedContributions,
    balancedContributions,
    verification: { passes, failures, current: verification.current === true },
    contributions: { claude, codex },
    usage: sumUsage(claudeUsage, codexUsage),
    elapsedActiveMs
  }
}

async function loadReceipt(path) {
  const absolutePath = resolve(path)
  const info = await lstat(absolutePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) {
    throw new Error('Invalid receipt: file must be a bounded regular JSON file.')
  }
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'))
  } catch {
    throw new Error('Invalid receipt: file is not valid JSON.')
  }
}

function renderHuman(report) {
  const lines = [
    'Duo Chaos saved-run benchmark',
    'No providers or direct APIs were called.',
    `Mode: ${report.sourceMode}`,
    '',
    'Label | Duo ready | Balanced | Verification | Calls | Processed input | Output | Active time',
    '--- | --- | --- | --- | ---: | ---: | ---: | ---:'
  ]
  for (const entry of report.entries) {
    lines.push([
      entry.label,
      entry.duoReady ? 'yes' : 'no',
      entry.balancedContributions ? 'yes' : 'no',
      `${String(entry.verification.passes)} pass / ${String(entry.verification.failures)} fail / ${entry.verification.current ? 'current' : 'stale'}`,
      String(entry.usage.calls),
      String(entry.usage.processedInputTokens),
      String(entry.usage.outputTokens),
      `${(entry.elapsedActiveMs / 60_000).toFixed(1)} min`
    ].join(' | '))
  }
  lines.push('', 'This report compares recorded evidence only. It does not claim model quality from synthetic data.')
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--live')) {
    process.stderr.write('Live benchmark mode is not supported. No provider or direct API call was made.\n')
    process.exitCode = 2
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: npm run benchmark:receipts -- [--json] [receipt.json ...]\nNo arguments uses deterministic synthetic receipts. Live provider execution is intentionally unsupported.\n')
    return
  }
  const json = args.includes('--json')
  const paths = args.filter((argument) => argument !== '--json')
  try {
    const receipts = paths.length > 0 ? await Promise.all(paths.map(loadReceipt)) : syntheticReceipts
    const report = {
      schemaVersion: 1,
      sourceMode: paths.length > 0 ? 'saved-run' : 'synthetic',
      providerCallsMade: 0,
      entries: receipts.map(normalizeReceipt)
    }
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid receipt.'}\n`)
    process.exitCode = 1
  }
}

await main()
