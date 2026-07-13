#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_RESULTS_ROOT = resolve(REPOSITORY_ROOT, 'test-results')
const DEFAULT_FIXTURE = resolve(REPOSITORY_ROOT, 'tests', 'fixtures', 'benchmarks', 'quality-per-token.json')
const DEFAULT_OUTPUT = resolve(TEST_RESULTS_ROOT, 'quality-per-token')
const MAX_FIXTURE_BYTES = 256_000
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .()/-]{0,95}$/u
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const PRIVATE_STRING = /(?:[A-Za-z]:\\|\\\\|@|Bearer\s|\bsk-|\bgh[pousr]_)/iu

function fail(message) {
  throw new Error(message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`Invalid fixture: ${label} must be an object.`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Invalid fixture: unexpected ${label} field ${key}.`)
  }
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`Invalid fixture: ${label} must be a safe identifier.`)
  return value
}

function safeLabel(value, label) {
  if (typeof value !== 'string' || !SAFE_LABEL.test(value) || PRIVATE_STRING.test(value)) {
    fail(`Invalid fixture: ${label} is not a sanitized public label.`)
  }
  return value
}

function nonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`Invalid fixture: ${label} must be a non-negative integer.`)
  }
  return value
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`Invalid fixture: ${label} must be boolean.`)
  return value
}

function within(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !pathFromRoot.startsWith(sep))
}

function parseArgs(args) {
  let fixturePath = DEFAULT_FIXTURE
  let outputDirectory = DEFAULT_OUTPUT
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--fixture') {
      const next = args[index + 1]
      if (!next) fail('Missing path after --fixture.')
      fixturePath = resolve(REPOSITORY_ROOT, next)
      index += 1
      continue
    }
    if (argument === '--output-dir') {
      const next = args[index + 1]
      if (!next) fail('Missing path after --output-dir.')
      outputDirectory = resolve(REPOSITORY_ROOT, next)
      index += 1
      continue
    }
    if (argument === '--help' || argument === '-h') {
      return { help: true, fixturePath, outputDirectory }
    }
    fail(`Unknown argument: ${argument}`)
  }
  if (!within(TEST_RESULTS_ROOT, outputDirectory)) {
    fail('Benchmark output must stay inside the ignored test-results directory.')
  }
  return { help: false, fixturePath, outputDirectory }
}

async function loadFixture(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_FIXTURE_BYTES) {
    fail('Invalid fixture: expected a bounded regular JSON file.')
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    fail('Invalid fixture: file is not valid JSON.')
  }
}

function normalizeCommand(value, index) {
  const input = record(value, `commands[${String(index)}]`)
  exactKeys(input, ['id', 'variant', 'binary', 'transport', 'model', 'effort'], `commands[${String(index)}]`)
  const id = safeId(input.id, `commands[${String(index)}].id`)
  const variant = safeId(input.variant, `commands[${String(index)}].variant`)
  const binary = typeof input.binary === 'string' ? input.binary.trim().toLocaleLowerCase() : ''
  if (!/^codex(?:\.exe|\.cmd)?$/u.test(binary)) {
    fail('Safety gate: deterministic quality benchmarks may select only the local Codex CLI; Claude invocation is forbidden.')
  }
  if (input.transport !== 'local-cli') {
    fail('Safety gate: direct API and remote transports are forbidden in deterministic quality benchmarks.')
  }
  const model = typeof input.model === 'string' && SAFE_MODEL.test(input.model) ? input.model : undefined
  const effort = typeof input.effort === 'string' ? input.effort.toLocaleLowerCase() : ''
  if (!model) fail(`Invalid fixture: commands[${String(index)}].model is not safe.`)
  if (!['low', 'medium', 'high', 'extra-high', 'max', 'ultra'].includes(effort)) {
    fail(`Invalid fixture: commands[${String(index)}].effort is unsupported.`)
  }
  if (/sol/iu.test(model) && effort === 'ultra') {
    fail('Safety gate: Sol Ultra is forbidden in this benchmark.')
  }
  return { id, variant, binary: 'codex', transport: 'local-cli', model, effort }
}

function normalizeUsage(value, label) {
  const input = record(value, label)
  exactKeys(input, ['processedInputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'calls'], label)
  return {
    processedInputTokens: nonNegativeInteger(input.processedInputTokens, `${label}.processedInputTokens`),
    cachedInputTokens: nonNegativeInteger(input.cachedInputTokens, `${label}.cachedInputTokens`),
    outputTokens: nonNegativeInteger(input.outputTokens, `${label}.outputTokens`),
    reasoningTokens: nonNegativeInteger(input.reasoningTokens, `${label}.reasoningTokens`),
    calls: nonNegativeInteger(input.calls, `${label}.calls`)
  }
}

function normalizeRole(value, label) {
  const input = record(value, label)
  exactKeys(input, ['acceptedImplementation', 'acceptedCrossReview', 'completedTasks', 'edits'], label)
  return {
    acceptedImplementation: boolean(input.acceptedImplementation, `${label}.acceptedImplementation`),
    acceptedCrossReview: boolean(input.acceptedCrossReview, `${label}.acceptedCrossReview`),
    completedTasks: nonNegativeInteger(input.completedTasks, `${label}.completedTasks`),
    edits: nonNegativeInteger(input.edits, `${label}.edits`)
  }
}

function normalizeQuality(value, label) {
  const input = record(value, label)
  exactKeys(input, ['releaseStatus', 'artifactReady', 'verification', 'hiddenJudge', 'roles'], label)
  if (!['ready', 'partial', 'failed'].includes(input.releaseStatus)) fail(`Invalid fixture: ${label}.releaseStatus is unsupported.`)
  const verification = record(input.verification, `${label}.verification`)
  exactKeys(verification, ['passes', 'failures', 'current'], `${label}.verification`)
  const hiddenJudge = record(input.hiddenJudge, `${label}.hiddenJudge`)
  exactKeys(hiddenJudge, ['passed', 'total'], `${label}.hiddenJudge`)
  const roles = record(input.roles, `${label}.roles`)
  exactKeys(roles, ['roleA', 'roleB'], `${label}.roles`)
  const passed = nonNegativeInteger(hiddenJudge.passed, `${label}.hiddenJudge.passed`)
  const total = nonNegativeInteger(hiddenJudge.total, `${label}.hiddenJudge.total`)
  if (passed > total) fail(`Invalid fixture: ${label}.hiddenJudge.passed cannot exceed total.`)
  return {
    releaseStatus: input.releaseStatus,
    artifactReady: boolean(input.artifactReady, `${label}.artifactReady`),
    verification: {
      passes: nonNegativeInteger(verification.passes, `${label}.verification.passes`),
      failures: nonNegativeInteger(verification.failures, `${label}.verification.failures`),
      current: boolean(verification.current, `${label}.verification.current`)
    },
    hiddenJudge: { passed, total },
    roles: {
      roleA: normalizeRole(roles.roleA, `${label}.roles.roleA`),
      roleB: normalizeRole(roles.roleB, `${label}.roles.roleB`)
    }
  }
}

function normalizeEfficiency(value, label) {
  const input = record(value, label)
  exactKeys(input, ['usage', 'promptBytes', 'toolOutputBytes', 'peakContextTokens', 'batonBytes', 'acceptedTasks', 'recoveryCalls', 'activeMs'], label)
  return {
    usage: normalizeUsage(input.usage, `${label}.usage`),
    promptBytes: nonNegativeInteger(input.promptBytes, `${label}.promptBytes`),
    toolOutputBytes: nonNegativeInteger(input.toolOutputBytes, `${label}.toolOutputBytes`),
    peakContextTokens: nonNegativeInteger(input.peakContextTokens, `${label}.peakContextTokens`),
    batonBytes: nonNegativeInteger(input.batonBytes, `${label}.batonBytes`),
    acceptedTasks: nonNegativeInteger(input.acceptedTasks, `${label}.acceptedTasks`),
    recoveryCalls: nonNegativeInteger(input.recoveryCalls, `${label}.recoveryCalls`),
    activeMs: nonNegativeInteger(input.activeMs, `${label}.activeMs`)
  }
}

function hardGates(quality) {
  const roles = Object.values(quality.roles)
  const editCounts = roles.map((role) => role.edits)
  const smaller = Math.min(...editCounts)
  const larger = Math.max(...editCounts)
  const balanced = roles.every((role) =>
    role.acceptedImplementation && role.acceptedCrossReview && role.completedTasks > 0 && role.edits > 0
  ) && smaller > 0 && larger / smaller <= 4
  return {
    readyRelease: quality.releaseStatus === 'ready' && quality.artifactReady,
    currentVerification: quality.verification.current && quality.verification.passes > 0 && quality.verification.failures === 0,
    hiddenJudge: quality.hiddenJudge.total > 0 && quality.hiddenJudge.passed === quality.hiddenJudge.total,
    balancedLogicalRoles: balanced
  }
}

function normalizeVariant(value, index) {
  const input = record(value, `variants[${String(index)}]`)
  exactKeys(input, ['id', 'label', 'architecture', 'quality', 'efficiency'], `variants[${String(index)}]`)
  const id = safeId(input.id, `variants[${String(index)}].id`)
  const label = safeLabel(input.label, `variants[${String(index)}].label`)
  if (!['monolithic-context', 'bounded-baton'].includes(input.architecture)) {
    fail(`Invalid fixture: variants[${String(index)}].architecture is unsupported.`)
  }
  const quality = normalizeQuality(input.quality, `variants[${String(index)}].quality`)
  const efficiency = normalizeEfficiency(input.efficiency, `variants[${String(index)}].efficiency`)
  return { id, label, architecture: input.architecture, quality, gates: hardGates(quality), efficiency }
}

function reductionPercent(before, after) {
  if (before === 0) return after === 0 ? 0 : -100
  return Math.round(((before - after) / before) * 1_000) / 10
}

function normalizeFixture(value) {
  const input = record(value, 'root')
  exactKeys(input, ['schemaVersion', 'benchmark', 'evidenceKind', 'baseline', 'candidate', 'commands', 'variants'], 'root')
  if (input.schemaVersion !== 1 || input.benchmark !== 'quality-per-token' || input.evidenceKind !== 'deterministic-fixture') {
    fail('Invalid fixture: unsupported benchmark identity or schema version.')
  }
  if (!Array.isArray(input.commands) || input.commands.length === 0) fail('Invalid fixture: at least one Codex command selection is required.')
  if (!Array.isArray(input.variants) || input.variants.length !== 2) fail('Invalid fixture: exactly two variants are required.')
  const commands = input.commands.map(normalizeCommand)
  const variants = input.variants.map(normalizeVariant)
  const baselineId = safeId(input.baseline, 'baseline')
  const candidateId = safeId(input.candidate, 'candidate')
  const baseline = variants.find((variant) => variant.id === baselineId)
  const candidate = variants.find((variant) => variant.id === candidateId)
  if (!baseline || !candidate || baseline.id === candidate.id) fail('Invalid fixture: baseline and candidate must name different variants.')
  if (!commands.some((command) => command.variant === baseline.id) || !commands.some((command) => command.variant === candidate.id)) {
    fail('Invalid fixture: both variants require an explicit safe command selection.')
  }
  const baselineGatesPass = Object.values(baseline.gates).every(Boolean)
  const candidateGatesPass = Object.values(candidate.gates).every(Boolean)
  const baselineJudgeRatio = baseline.quality.hiddenJudge.passed / Math.max(1, baseline.quality.hiddenJudge.total)
  const candidateJudgeRatio = candidate.quality.hiddenJudge.passed / Math.max(1, candidate.quality.hiddenJudge.total)
  const qualityNonInferior = baselineGatesPass && candidateGatesPass && candidateJudgeRatio >= baselineJudgeRatio
  const deltas = {
    processedInputTokens: candidate.efficiency.usage.processedInputTokens - baseline.efficiency.usage.processedInputTokens,
    processedInputReductionPct: reductionPercent(baseline.efficiency.usage.processedInputTokens, candidate.efficiency.usage.processedInputTokens),
    outputTokens: candidate.efficiency.usage.outputTokens - baseline.efficiency.usage.outputTokens,
    outputReductionPct: reductionPercent(baseline.efficiency.usage.outputTokens, candidate.efficiency.usage.outputTokens),
    toolOutputBytes: candidate.efficiency.toolOutputBytes - baseline.efficiency.toolOutputBytes,
    toolOutputReductionPct: reductionPercent(baseline.efficiency.toolOutputBytes, candidate.efficiency.toolOutputBytes),
    peakContextTokens: candidate.efficiency.peakContextTokens - baseline.efficiency.peakContextTokens,
    peakContextReductionPct: reductionPercent(baseline.efficiency.peakContextTokens, candidate.efficiency.peakContextTokens),
    calls: candidate.efficiency.usage.calls - baseline.efficiency.usage.calls,
    recoveryCalls: candidate.efficiency.recoveryCalls - baseline.efficiency.recoveryCalls
  }
  const candidatePreferred = qualityNonInferior && deltas.processedInputTokens < 0 && deltas.outputTokens <= 0 &&
    deltas.toolOutputBytes < 0 && deltas.peakContextTokens < 0
  return {
    schemaVersion: 1,
    benchmark: 'quality-per-token',
    evidenceKind: 'deterministic-fixture',
    providerCallsMade: 0,
    claudeCommandsMade: 0,
    directApiCallsMade: 0,
    qualityClaim: 'Architecture contract only; synthetic fixtures do not prove future model quality or token savings.',
    providerPolicy: commands.map(({ variant, model, effort }) => ({ variant, physicalProvider: 'codex', transport: 'local-cli', model, effort })),
    variants,
    comparison: {
      baseline: baseline.id,
      candidate: candidate.id,
      qualityNonInferior,
      deltas,
      verdict: candidatePreferred ? 'candidate-preferred' : qualityNonInferior ? 'efficiency-not-proven' : 'quality-regression'
    }
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Quality-per-token architecture benchmark',
    '',
    '> Deterministic fixture benchmark. Zero provider calls. It validates comparison plumbing and safety contracts; it does not prove future model quality or token savings.',
    '',
    '| Variant | Architecture | Hard gates | Processed input | Output | Peak context | Tool output | Calls |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |'
  ]
  for (const variant of report.variants) {
    const gates = Object.values(variant.gates).every(Boolean) ? 'pass' : 'fail'
    lines.push(`| ${variant.label} | ${variant.architecture} | ${gates} | ${String(variant.efficiency.usage.processedInputTokens)} | ${String(variant.efficiency.usage.outputTokens)} | ${String(variant.efficiency.peakContextTokens)} | ${String(variant.efficiency.toolOutputBytes)} | ${String(variant.efficiency.usage.calls)} |`)
  }
  const deltas = report.comparison.deltas
  lines.push(
    '',
    '## Candidate comparison',
    '',
    `- Verdict: **${report.comparison.verdict}**`,
    `- Quality non-inferior in fixture: **${report.comparison.qualityNonInferior ? 'yes' : 'no'}**`,
    `- Processed-input reduction: **${String(deltas.processedInputReductionPct)}%**`,
    `- Output-token reduction: **${String(deltas.outputReductionPct)}%**`,
    `- Peak-context reduction: **${String(deltas.peakContextReductionPct)}%**`,
    `- Tool-output reduction: **${String(deltas.toolOutputReductionPct)}%**`,
    '',
    'No Claude command, direct API, or Sol Ultra selection is permitted by this benchmark.',
    ''
  )
  return lines.join('\n')
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write('Usage: npm run benchmark:quality -- [--fixture path.json] [--output-dir test-results/path]\nThis command is deterministic and makes zero provider calls.\n')
      return
    }
    const report = normalizeFixture(await loadFixture(options.fixturePath))
    const json = `${JSON.stringify(report, null, 2)}\n`
    const markdown = renderMarkdown(report)
    await mkdir(options.outputDirectory, { recursive: true })
    await Promise.all([
      writeFile(resolve(options.outputDirectory, 'report.json'), json, 'utf8'),
      writeFile(resolve(options.outputDirectory, 'report.md'), markdown, 'utf8')
    ])
    process.stdout.write(`${JSON.stringify({
      benchmark: report.benchmark,
      evidenceKind: report.evidenceKind,
      providerCallsMade: 0,
      verdict: report.comparison.verdict,
      outputDirectory: relative(REPOSITORY_ROOT, options.outputDirectory).replaceAll('\\', '/')
    })}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed.'}\n`)
    process.exitCode = 1
  }
}

await main()
