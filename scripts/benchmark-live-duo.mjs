#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, win32 as win32Path } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import crossSpawn from 'cross-spawn'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Playwright owns and clears test-results/ at the start of an E2E run. Live
// provider evidence needs a separate archive so later release verification
// cannot silently erase the benchmark receipt and preserved artifact.
const BENCHMARK_RESULTS_ROOT = resolve(REPOSITORY_ROOT, 'benchmark-results')
const FIXTURE_PATH = resolve(REPOSITORY_ROOT, 'tests', 'fixtures', 'benchmarks', 'live', 'terra-low-sonnet-low.json')
const ELECTRON_ENTRY = resolve(REPOSITORY_ROOT, 'out', 'main', 'index.js')
const MAX_FIXTURE_BYTES = 32_000
const LIVE_FLAG = '--live'
const QUOTA_FLAG = '--i-understand-this-uses-local-cli-quota'
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .()+-]{0,119}$/u
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const TERMINAL_STATUSES = new Set(['paused', 'reveal-ready', 'complete', 'failed', 'cancelled'])
const PASSING_STATUSES = new Set(['reveal-ready', 'complete'])

class HarnessTimeoutError extends Error {
  constructor() {
    super('The independent live-benchmark watchdog expired. The run was stopped and its local evidence was preserved.')
    this.name = 'HarnessTimeoutError'
  }
}

function fail(message) {
  throw new Error(message)
}

function missingPath(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

async function terminateElectronProcessTree(
  child,
  spawnProcess = crossSpawn,
  helperTimeoutMs = 3_000,
  platform = process.platform,
  environment = process.env
) {
  if (!child?.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32') {
    const configuredWindowsRoot = environment.SystemRoot ?? environment.WINDIR
    const windowsRoot = configuredWindowsRoot && win32Path.isAbsolute(configuredWindowsRoot)
      ? configuredWindowsRoot
      : 'C:\\Windows'
    const taskkillPath = win32Path.join(windowsRoot, 'System32', 'taskkill.exe')
    let killer
    try {
      killer = spawnProcess(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      child.kill()
      return
    }
    await new Promise((resolveTermination) => {
      let settled = false
      let timer
      const settle = (fallback) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (fallback) child.kill()
        resolveTermination()
      }
      killer.once('error', () => settle(true))
      killer.once('close', (code) => settle(code !== 0))
      timer = setTimeout(() => {
        try {
          killer.kill()
        } catch {
          // The fallback below still targets the benchmark process itself.
        }
        settle(true)
      }, helperTimeoutMs)
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

async function closeElectronApplication(application, graceMs = 5_000, terminateTree = terminateElectronProcessTree) {
  let finished = false
  let closeError
  const closeAttempt = application.close()
    .catch((error) => { closeError = error })
    .finally(() => { finished = true })
  await Promise.race([
    closeAttempt,
    new Promise((resolveDelay) => setTimeout(resolveDelay, graceMs))
  ])
  if (!finished) {
    try {
      await terminateTree(application.process())
    } catch (error) {
      closeError = closeError ?? error
    }
    await Promise.race([
      closeAttempt,
      new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(2_000, graceMs)))
    ])
  }
  if (!finished) throw new Error('Electron did not exit after the benchmark shutdown deadline.')
  if (closeError instanceof Error) throw closeError
  if (closeError !== undefined) throw new Error('Electron failed to close with a non-Error value.')
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`Invalid live fixture: ${label} must be an object.`)
  return value
}

function exactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`Invalid live fixture: ${label} fields must match the fixed contract.`)
  }
}

function safeString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`Invalid live fixture: ${label} is not sanitized.`)
  return value
}

function boundedText(value, label) {
  if (typeof value !== 'string' || value.trim().length < 40 || value.length > 1_200 || /(?:[A-Za-z]:\\|\\\\|https?:\/\/|Bearer\s|\bsk-)/iu.test(value)) {
    fail(`Invalid live fixture: ${label} is not a bounded public brief.`)
  }
  return value.trim()
}

function integer(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`Invalid live fixture: ${label} is outside the fixed range.`)
  }
  return value
}

function oneOf(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`Invalid live fixture: ${label} is not allowed.`)
  return value
}

function parseArgs(args) {
  const accepted = new Set(['--json', '--help', '-h', LIVE_FLAG, QUOTA_FLAG])
  for (const argument of args) {
    if (!accepted.has(argument)) fail(`Unknown argument: ${argument}`)
  }
  return {
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
    live: args.includes(LIVE_FLAG),
    quotaAcknowledged: args.includes(QUOTA_FLAG)
  }
}

async function loadFixture() {
  const info = await lstat(FIXTURE_PATH)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_FIXTURE_BYTES) {
    fail('Invalid live fixture: expected a bounded regular JSON file.')
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
  } catch {
    fail('Invalid live fixture: file is not valid JSON.')
  }
  const fixture = record(parsed, 'root')
  exactKeys(fixture, ['schemaVersion', 'id', 'label', 'prompt', 'condition', 'judge'], 'root')
  if (fixture.schemaVersion !== 1) fail('Invalid live fixture: expected schemaVersion 1.')
  const condition = record(fixture.condition, 'condition')
  exactKeys(condition, [
    'executionMode', 'visibilityMode', 'missionProfile', 'codexModel', 'codexEffort', 'claudeModel',
    'claudeEffort', 'customizationProfile', 'qualityRoutingProfile', 'maxTurns', 'maxRepairLoops',
    'workInferenceLimit', 'turnTimeoutSeconds', 'runTimeoutSeconds'
  ], 'condition')
  const judge = record(fixture.judge, 'judge')
  exactKeys(judge, [
    'requiredReleaseStatus', 'requireCurrentVerification', 'requireBalancedAcceptedContributions',
    'requireAllTasksDone', 'maxEditRatio'
  ], 'judge')
  const normalized = {
    schemaVersion: 1,
    id: safeString(fixture.id, SAFE_ID, 'id'),
    label: safeString(fixture.label, SAFE_LABEL, 'label'),
    prompt: boundedText(fixture.prompt, 'prompt'),
    condition: {
      executionMode: oneOf(condition.executionMode, ['chaos'], 'condition.executionMode'),
      visibilityMode: oneOf(condition.visibilityMode, ['spoiler-shield'], 'condition.visibilityMode'),
      missionProfile: oneOf(condition.missionProfile, ['serious'], 'condition.missionProfile'),
      codexModel: safeString(condition.codexModel, SAFE_MODEL, 'condition.codexModel'),
      codexEffort: oneOf(condition.codexEffort, ['low'], 'condition.codexEffort'),
      claudeModel: safeString(condition.claudeModel, SAFE_MODEL, 'condition.claudeModel'),
      claudeEffort: oneOf(condition.claudeEffort, ['low'], 'condition.claudeEffort'),
      customizationProfile: oneOf(condition.customizationProfile, ['core'], 'condition.customizationProfile'),
      qualityRoutingProfile: oneOf(condition.qualityRoutingProfile, ['balanced'], 'condition.qualityRoutingProfile'),
      maxTurns: integer(condition.maxTurns, 7, 7, 'condition.maxTurns'),
      maxRepairLoops: integer(condition.maxRepairLoops, 0, 0, 'condition.maxRepairLoops'),
      workInferenceLimit: integer(condition.workInferenceLimit, 8, 8, 'condition.workInferenceLimit'),
      turnTimeoutSeconds: integer(condition.turnTimeoutSeconds, 7_200, 7_200, 'condition.turnTimeoutSeconds'),
      runTimeoutSeconds: integer(condition.runTimeoutSeconds, 21_600, 21_600, 'condition.runTimeoutSeconds')
    },
    judge: {
      requiredReleaseStatus: oneOf(judge.requiredReleaseStatus, ['ready'], 'judge.requiredReleaseStatus'),
      requireCurrentVerification: judge.requireCurrentVerification === true,
      requireBalancedAcceptedContributions: judge.requireBalancedAcceptedContributions === true,
      requireAllTasksDone: judge.requireAllTasksDone === true,
      maxEditRatio: integer(judge.maxEditRatio, 4, 4, 'judge.maxEditRatio')
    }
  }
  if (!normalized.judge.requireCurrentVerification || !normalized.judge.requireBalancedAcceptedContributions || !normalized.judge.requireAllTasksDone) {
    fail('Invalid live fixture: every fixed judge gate must be enabled.')
  }
  return normalized
}

function conditionSummary(fixture) {
  return {
    id: fixture.id,
    label: fixture.label,
    executionMode: fixture.condition.executionMode,
    visibilityMode: fixture.condition.visibilityMode,
    missionProfile: fixture.condition.missionProfile,
    codex: { model: fixture.condition.codexModel, effort: fixture.condition.codexEffort },
    claude: { model: fixture.condition.claudeModel, effort: fixture.condition.claudeEffort },
    customizationProfile: fixture.condition.customizationProfile,
    qualityRoutingProfile: fixture.condition.qualityRoutingProfile,
    maxTurns: fixture.condition.maxTurns,
    maxRepairLoops: fixture.condition.maxRepairLoops
  }
}

function sanitizedElectronEnvironment(overrides) {
  const environment = { ...process.env, ...overrides }
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase()
    if (normalizedKey === 'ELECTRON_RENDERER_URL' || normalizedKey === 'ELECTRON_RUN_AS_NODE' || normalizedKey === 'NODE_OPTIONS' || normalizedKey.startsWith('VITE_')) {
      delete environment[key]
    }
  }
  return environment
}

function dryReport(fixture) {
  return {
    schemaVersion: 1,
    benchmark: 'duo-live-exact-condition',
    mode: 'dry-run',
    providerCallsMade: 0,
    directApiCallsMade: 0,
    rawLogsSaved: false,
    condition: conditionSummary(fixture),
    activation: `Provider execution requires both ${LIVE_FLAG} and ${QUOTA_FLAG}.`
  }
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function nonNegativeInteger(value) {
  const normalized = nonNegativeNumber(value)
  return Number.isSafeInteger(normalized) ? normalized : Math.floor(normalized)
}

function usageOf(snapshot, agent) {
  const usage = record(snapshot.agentUsage ?? {}, 'snapshot.agentUsage')[agent]
  const data = typeof usage === 'object' && usage !== null ? usage : {}
  return {
    processedInputTokens: nonNegativeInteger(data.processedInputTokens),
    cachedInputTokens: nonNegativeInteger(data.cachedInputTokens),
    outputTokens: nonNegativeInteger(data.outputTokens),
    reasoningTokens: nonNegativeInteger(data.reasoningTokens),
    calls: nonNegativeInteger(data.calls)
  }
}

function contributionOf(snapshot, agent) {
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  return {
    acceptedImplementation: events.some((event) => event?.proof?.kind === 'contribution' && event.proof.agent === agent && event.proof.accepted === true),
    acceptedCrossReview: events.some((event) => event?.proof?.kind === 'review' && event.proof.agent === agent && event.proof.accepted === true),
    completedTasks: tasks.filter((task) => task?.claimedBy === agent && task?.status === 'done').length,
    edits: events.filter((event) => event?.agent === agent && (event.type === 'file.changed' || (event.type === 'agent.activity' && event.category === 'file'))).length,
    messages: events.filter((event) => event?.agent === agent && (event.type === 'agent.dispatch' || event.type === 'opinion')).length,
    turns: events.filter((event) => event?.agent === agent && event.type === 'agent.started').length
  }
}

function judgeSnapshot(snapshot, fixture) {
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  const claude = contributionOf(snapshot, 'claude')
  const codex = contributionOf(snapshot, 'codex')
  const latestVerification = [...events].reverse().find((event) => event?.type === 'build.passed' || event?.type === 'build.failed')
  const verificationCurrent = latestVerification?.type === 'build.passed'
  const verificationPasses = events.filter((event) => event?.type === 'build.passed').length
  const verificationFailures = events.filter((event) => event?.type === 'build.failed').length
  const smallerEditCount = Math.min(claude.edits, codex.edits)
  const largerEditCount = Math.max(claude.edits, codex.edits)
  const editRatioBalanced = smallerEditCount > 0 && largerEditCount / smallerEditCount <= fixture.judge.maxEditRatio
  const balancedContributions = [claude, codex].every((entry) => (
    entry.acceptedImplementation && entry.acceptedCrossReview && entry.completedTasks > 0 && entry.edits > 0
  )) && editRatioBalanced
  const allTasksDone = tasks.length > 0 && tasks.every((task) => task?.status === 'done')
  const gates = {
    terminal: PASSING_STATUSES.has(snapshot.status),
    releaseReady: snapshot.releaseStatus === fixture.judge.requiredReleaseStatus,
    currentVerification: verificationCurrent && verificationPasses > 0,
    balancedAcceptedContributions: balancedContributions,
    allTasksDone
  }
  const passed = Object.values(gates).every(Boolean)
  const status = oneOf(snapshot.status, [...TERMINAL_STATUSES], 'snapshot.status')
  return {
    schemaVersion: 1,
    benchmark: 'duo-live-exact-condition',
    evidenceKind: 'live-local-cli',
    condition: conditionSummary(fixture),
    providerCallsMade: usageOf(snapshot, 'claude').calls + usageOf(snapshot, 'codex').calls,
    directApiCallsMade: 0,
    rawLogsSaved: false,
    result: {
      status,
      releaseStatus: ['ready', 'partial', 'failed'].includes(snapshot.releaseStatus) ? snapshot.releaseStatus : 'unavailable',
      pauseReason: status === 'paused' && typeof snapshot.pause?.reason === 'string' && SAFE_ID.test(snapshot.pause.reason)
        ? snapshot.pause.reason
        : undefined,
      activeTimeMs: nonNegativeInteger(snapshot.activeTimeMs),
      rounds: nonNegativeInteger(snapshot.round),
      tasks: { completed: tasks.filter((task) => task?.status === 'done').length, total: tasks.length },
      verification: { passes: verificationPasses, failures: verificationFailures, current: verificationCurrent },
      contributions: { claude, codex },
      usage: { claude: usageOf(snapshot, 'claude'), codex: usageOf(snapshot, 'codex') }
    },
    judge: {
      kind: 'restricted-supervisor-evidence',
      gates,
      verdict: passed ? 'pass' : status === 'paused' || status === 'failed' ? 'preserved-incomplete' : 'fail'
    },
    qualityClaim: 'One recorded condition. Supervisor evidence is factual, but independent blind human review is still required for product-quality claims.'
  }
}

async function waitForTerminalSnapshot({ readSnapshot, stopRun, timeoutMs, pollMs = 1_000 }) {
  const bounded = (operation, maximumMs, message) => Promise.race([
    operation,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), maximumMs))
  ])
  const hasDeadline = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
  const deadline = hasDeadline ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  let lastSnapshot
  while (Date.now() < deadline) {
    const candidate = await bounded(readSnapshot(), 30_000, 'The Electron benchmark surface stopped responding.')
    if (candidate) lastSnapshot = candidate
    if (candidate && TERMINAL_STATUSES.has(candidate.status)) {
      return { snapshot: candidate, timedOut: false }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  }
  await bounded(stopRun(), 10_000, 'The timed-out benchmark could not be stopped through IPC.').catch(() => undefined)
  const stopped = await bounded(readSnapshot(), 10_000, 'The stopped benchmark did not return a final snapshot.').catch(() => undefined)
  return { snapshot: stopped ?? lastSnapshot, timedOut: true }
}

function failureReceipt(fixture, snapshot, failureKind) {
  const status = snapshot && typeof snapshot.status === 'string' && TERMINAL_STATUSES.has(snapshot.status)
    ? snapshot.status
    : 'unavailable'
  return {
    schemaVersion: 1,
    benchmark: 'duo-live-exact-condition',
    evidenceKind: 'live-local-cli',
    condition: conditionSummary(fixture),
    providerCallsMade: snapshot ? usageOf(snapshot, 'claude').calls + usageOf(snapshot, 'codex').calls : 0,
    directApiCallsMade: 0,
    rawLogsSaved: false,
    result: { status, failureKind },
    judge: { kind: 'restricted-supervisor-evidence', verdict: 'preserved-incomplete' },
    qualityClaim: 'Harness failure evidence is preserved locally and cannot count as a product-quality pass.'
  }
}

function humanDry(report) {
  return [
    'Duo Chaos live benchmark dry run',
    'No provider or direct API call was made.',
    `Condition: ${report.condition.label}`,
    `Codex: ${report.condition.codex.model} / ${report.condition.codex.effort}`,
    `Claude: ${report.condition.claude.model} / ${report.condition.claude.effort}`,
    report.activation
  ].join('\n') + '\n'
}

function executionId() {
  const date = new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14)
  return `${date}-${randomUUID().slice(0, 8)}`
}

function samePath(left, right) {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function pathInside(root, candidate) {
  const relation = relative(root, candidate)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

async function canonicalEvidenceDirectory(path, label) {
  const resolvedPath = resolve(path)
  const info = await lstat(resolvedPath)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`The live benchmark refused a linked or non-directory ${label}.`)
  }
  const canonicalPath = await realpath(resolvedPath)
  if (!samePath(canonicalPath, resolvedPath)) {
    fail(`The live benchmark refused a noncanonical ${label}.`)
  }
  return canonicalPath
}

async function prepareLiveOutputDirectory(id, archiveRoot = BENCHMARK_RESULTS_ROOT) {
  if (!SAFE_ID.test(id)) fail('The live benchmark refused an unsafe archive identifier.')
  await mkdir(archiveRoot, { recursive: true })
  const canonicalArchiveRoot = await canonicalEvidenceDirectory(archiveRoot, 'benchmark results root')
  const liveRoot = resolve(canonicalArchiveRoot, 'live-duo')
  await mkdir(liveRoot, { recursive: true })
  const canonicalLiveRoot = await canonicalEvidenceDirectory(liveRoot, 'live benchmark results root')
  const outputDirectory = resolve(canonicalLiveRoot, id)
  await mkdir(outputDirectory)
  return await canonicalEvidenceDirectory(outputDirectory, 'benchmark archive directory')
}

async function copyEvidenceTree(sourceRoot, destinationRoot, { excludeGit = false } = {}) {
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (sourcePath) => {
      const info = await lstat(sourcePath)
      // Evidence archives never follow or reproduce links. This prevents a
      // generated workspace from smuggling external files into the archive,
      // and makes later cleanup independent of link semantics on Windows.
      if (info.isSymbolicLink()) return false
      if (excludeGit && basename(sourcePath).toLowerCase() === '.git') return false
      return true
    }
  })
}

async function preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot }) {
  await canonicalEvidenceDirectory(outputDirectory, 'benchmark archive directory')
  const preservedWorkspace = resolve(outputDirectory, 'preserved-workspace')
  const sourceWorkspace = typeof snapshot?.workspacePath === 'string' ? resolve(snapshot.workspacePath) : workspaceRoot
  const canonicalWorkspaceRoot = await canonicalEvidenceDirectory(workspaceRoot, 'isolated workspace root')
  const canonicalSourceWorkspace = await canonicalEvidenceDirectory(sourceWorkspace, 'source workspace')
  if (!pathInside(canonicalWorkspaceRoot, canonicalSourceWorkspace)) {
    fail('The live benchmark refused to preserve a workspace outside its isolated root.')
  }
  await copyEvidenceTree(canonicalSourceWorkspace, preservedWorkspace, { excludeGit: true })

  const runtimeRoot = resolve(userData, 'runs')
  const supervisorRuntime = resolve(outputDirectory, 'supervisor-runtime')
  try {
    await access(runtimeRoot)
  } catch (error) {
    if (missingPath(error)) return
    throw error
  }
  const canonicalRuntimeRoot = await canonicalEvidenceDirectory(runtimeRoot, 'supervisor runtime root')
  await copyEvidenceTree(canonicalRuntimeRoot, supervisorRuntime)
}

async function runLive(fixture, jsonOutput) {
  await access(ELECTRON_ENTRY).catch(() => fail('Build output is missing. Run npm run build before the live benchmark. No provider call was made.'))
  const id = executionId()
  const outputDirectory = await prepareLiveOutputDirectory(id)
  const userData = await mkdtemp(resolve(tmpdir(), 'duo-live-userdata-'))
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'duo-live-workspace-'))
  let electronApp
  let snapshot
  let report
  let caughtError
  let evidencePreserved = false
  try {
    const { _electron } = await import('@playwright/test')
    electronApp = await _electron.launch({
      args: [ELECTRON_ENTRY],
      env: sanitizedElectronEnvironment({
        DUO_CHAOS_E2E: '1',
        DUO_CHAOS_E2E_USER_DATA: userData,
        DUO_CHAOS_E2E_DEFAULT_WORKSPACE: workspaceRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      })
    })
    const page = await electronApp.firstWindow()
    const runId = await page.evaluate(async ({ condition, prompt, workspaceRoot: isolatedWorkspaceRoot }) => {
      const bootstrap = await window.duo.getBootstrap()
      await window.duo.saveSettings({
        ...bootstrap.settings,
        defaultWorkspaceRoot: isolatedWorkspaceRoot,
        defaultExecutionMode: condition.executionMode,
        defaultVisibilityMode: condition.visibilityMode,
        defaultMissionProfile: condition.missionProfile,
        saveRawLogs: false,
        maxTurns: condition.maxTurns,
        maxRepairLoops: condition.maxRepairLoops,
        turnTimeoutSeconds: condition.turnTimeoutSeconds,
        runTimeoutSeconds: condition.runTimeoutSeconds,
        workInferenceLimit: condition.workInferenceLimit,
        codexModel: condition.codexModel,
        codexEffort: condition.codexEffort,
        claudeModel: condition.claudeModel,
        claudeEffort: condition.claudeEffort,
        codexCustomizationProfile: condition.customizationProfile,
        claudeCustomizationProfile: condition.customizationProfile,
        qualityRoutingProfile: condition.qualityRoutingProfile,
        trustedLocalCapabilitiesConfirmed: false
      })
      const started = await window.duo.startRun({
        prompt,
        workspaceRoot: isolatedWorkspaceRoot,
        executionMode: condition.executionMode,
        visibilityMode: condition.visibilityMode,
        missionProfile: condition.missionProfile,
        maxTurns: condition.maxTurns,
        maxRepairLoops: condition.maxRepairLoops,
        turnTimeoutSeconds: condition.turnTimeoutSeconds,
        runTimeoutSeconds: condition.runTimeoutSeconds,
        workInferenceLimit: condition.workInferenceLimit,
        dangerousModeConfirmed: false,
        unsafeWorkspaceRootConfirmed: true,
        codexCustomizationProfile: condition.customizationProfile,
        claudeCustomizationProfile: condition.customizationProfile,
        trustedLocalCapabilitiesConfirmed: false,
        qualityRoutingProfile: condition.qualityRoutingProfile,
        codexModel: condition.codexModel,
        codexEffort: condition.codexEffort,
        claudeModel: condition.claudeModel,
        claudeEffort: condition.claudeEffort
      })
      return started.runId
    }, { condition: fixture.condition, prompt: fixture.prompt, workspaceRoot })

    const terminal = await waitForTerminalSnapshot({
      timeoutMs: fixture.condition.runTimeoutSeconds * 1_000 + 120_000,
      readSnapshot: async () => {
        const current = await page.evaluate(async (activeRunId) => {
          const bootstrap = await window.duo.getBootstrap()
          return bootstrap.runs.find((run) => run.runId === activeRunId)
        }, runId)
        if (current) snapshot = current
        return current
      },
      stopRun: () => page.evaluate(async (activeRunId) => {
        await window.duo.stopRun(activeRunId)
      }, runId)
    })
    snapshot = terminal.snapshot ?? snapshot
    if (terminal.timedOut) throw new HarnessTimeoutError()
    if (!snapshot) fail('The live benchmark ended without a supervisor snapshot.')

    report = judgeSnapshot(snapshot, fixture)
    await writeFile(resolve(outputDirectory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    caughtError = error
    const failureKind = error instanceof HarnessTimeoutError ? 'harness-timeout' : 'harness-error'
    report = failureReceipt(fixture, snapshot, failureKind)
    await writeFile(resolve(outputDirectory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
  } finally {
    if (electronApp) {
      try {
        await closeElectronApplication(electronApp)
      } catch (error) {
        report = failureReceipt(fixture, snapshot, 'harness-shutdown-failed')
        await writeFile(resolve(outputDirectory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
        caughtError = caughtError ?? error
      }
    }
    try {
      await preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot })
      evidencePreserved = true
    } catch (error) {
      report = failureReceipt(fixture, snapshot, 'evidence-preservation-failed')
      caughtError = caughtError ?? (error instanceof Error
        ? error
        : new Error('Live benchmark evidence preservation failed with a non-Error value.'))
      await writeFile(resolve(outputDirectory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
      await writeFile(resolve(outputDirectory, 'preservation-failure.json'), `${JSON.stringify({
        schemaVersion: 1,
        benchmark: 'duo-live-exact-condition',
        failureKind: 'evidence-preservation-failed',
        temporaryEvidenceRetained: true,
        temporaryWorkspaceRoot: workspaceRoot,
        temporaryUserDataRoot: userData
      }, null, 2)}\n`, 'utf8').catch(() => undefined)
    }
    if (evidencePreserved) {
      await Promise.all([
        rm(userData, { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true })
      ])
    }
  }

  if (caughtError instanceof Error) throw caughtError
  if (caughtError !== undefined) throw new Error('The live benchmark failed with a non-Error value.')
  const summary = {
    benchmark: report.benchmark,
    evidenceKind: report.evidenceKind,
    status: report.result.status,
    verdict: report.judge.verdict,
    providerCallsMade: report.providerCallsMade,
    receipt: relative(REPOSITORY_ROOT, resolve(outputDirectory, 'receipt.json')).replaceAll('\\', '/'),
    preservedWorkspace: evidencePreserved
  }
  process.stdout.write(jsonOutput ? `${JSON.stringify(summary, null, 2)}\n` : `${JSON.stringify(summary)}\n`)
  if (report.judge.verdict !== 'pass') process.exitCode = 3
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(`Usage: npm run benchmark:live -- [--json] [${LIVE_FLAG} ${QUOTA_FLAG}]\nDry-run is the default. Live mode executes one fixed local-CLI condition.\n`)
      return
    }
    if (options.live !== options.quotaAcknowledged) {
      process.stderr.write(`Both ${LIVE_FLAG} and ${QUOTA_FLAG} are required. No provider or direct API call was made.\n`)
      process.exitCode = 2
      return
    }
    const fixture = await loadFixture()
    if (!options.live) {
      const report = dryReport(fixture)
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : humanDry(report))
      return
    }
    await runLive(fixture, options.json)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Live benchmark failed.'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

export {
  closeElectronApplication,
  failureReceipt,
  judgeSnapshot,
  loadFixture,
  prepareLiveOutputDirectory,
  preserveLiveEvidence,
  sanitizedElectronEnvironment,
  terminateElectronProcessTree,
  waitForTerminalSnapshot
}
