#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import crossSpawn from 'cross-spawn'
import {
  closeElectronApplication,
  preserveLiveEvidence,
  sanitizedElectronEnvironment,
  terminateElectronProcessTree,
  waitForTerminalSnapshot
} from './benchmark-live-duo.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCHMARK_RESULTS_ROOT = resolve(REPOSITORY_ROOT, 'benchmark-results')
const SHORT_MATRIX_ROOT = resolve(BENCHMARK_RESULTS_ROOT, 'short-matrix')
const LIVE_FIXTURE_ROOT = resolve(REPOSITORY_ROOT, 'tests', 'fixtures', 'benchmarks', 'live')
const ELECTRON_ENTRY = resolve(REPOSITORY_ROOT, 'out', 'main', 'index.js')
const LIVE_FLAG = '--live'
const QUOTA_FLAG = '--i-understand-this-uses-local-cli-quota'
const MAX_MANIFEST_BYTES = 64_000
const MAX_SOURCE_BYTES = 512_000
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .()+-]{0,119}$/u
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const TERMINAL_STATUSES = new Set(['paused', 'reveal-ready', 'complete', 'failed', 'cancelled'])
const EXPECTED_REQUIRED_FILES = ['index.html', 'app.js', 'logic.js', 'logic.test.mjs']
const EXPECTED_STABLE_HOOKS = ['options-input', 'start', 'choose-left', 'choose-right', 'ranking-item', 'reset', 'status']
const EXPECTED_PROMPT_SHA256 = 'd5603bd7c0b78bd302f1aa971a70c2645e76139fbfead998415ae0a95da2c657'
const ALLOWED_SOLO_ENVIRONMENT_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR'
])
const DEFAULT_SUITE = 'low-diagnostic'
const LOW_DIAGNOSTIC_ARMS = [
  {
    id: 'codex-terra-low-solo',
    label: 'Codex Terra Low solo',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-terra', effort: 'low' }
  },
  {
    id: 'claude-sonnet-low-solo',
    label: 'Claude Sonnet Low solo',
    kind: 'solo',
    agent: 'claude',
    claude: { model: 'sonnet', effort: 'low' }
  },
  {
    id: 'duo-terra-low-sonnet-low',
    label: 'Duo Terra Low plus Sonnet Low',
    kind: 'duo',
    codex: { model: 'gpt-5.6-terra', effort: 'low' },
    claude: { model: 'sonnet', effort: 'low' }
  },
  {
    id: 'duo-terra-low-sonnet-medium',
    label: 'Duo Terra Low plus Sonnet Medium',
    kind: 'duo',
    codex: { model: 'gpt-5.6-terra', effort: 'low' },
    claude: { model: 'sonnet', effort: 'medium' }
  }
]
const PREMIUM_MEDIUM_ARMS = [
  {
    id: 'codex-sol-medium-solo',
    label: 'Codex Sol Medium solo',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' }
  },
  {
    id: 'claude-fable-medium-solo',
    label: 'Claude Fable Medium solo',
    kind: 'solo',
    agent: 'claude',
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'claude-opus-medium-solo',
    label: 'Claude Opus Medium solo',
    kind: 'solo',
    agent: 'claude',
    claude: { model: 'opus', effort: 'medium' }
  },
  {
    id: 'duo-sol-medium-fable-medium',
    label: 'Duo Sol Medium plus Fable Medium',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'duo-sol-medium-opus-medium',
    label: 'Duo Sol Medium plus Opus Medium',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'opus', effort: 'medium' }
  }
]
const PREMIUM_MEDIUM_OPEN_ARMS = [
  {
    id: 'duo-sol-medium-opus-medium',
    label: 'Duo Sol Medium plus Opus Medium open work',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'opus', effort: 'medium' }
  }
]
const CODEX_EFFORT_OPEN_V1_ARMS = [
  {
    id: 'codex-sol-medium-solo-open-v1',
    label: 'Codex Sol Medium solo open v1',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' }
  },
  {
    id: 'codex-sol-low-solo-open-v1',
    label: 'Codex Sol Low solo open v1',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-sol', effort: 'low' }
  },
  {
    id: 'codex-terra-medium-solo-open-v1',
    label: 'Codex Terra Medium solo open v1',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-terra', effort: 'medium' }
  },
  {
    id: 'codex-sol-max-solo-open-v1',
    label: 'Codex Sol Max solo open v1',
    kind: 'solo',
    agent: 'codex',
    codex: { model: 'gpt-5.6-sol', effort: 'max' }
  }
]
const SOL_FABLE_2X2_OPEN_V1_ARMS = [
  {
    id: 'duo-sol-medium-fable-medium-open-v1',
    label: 'Duo Sol Medium plus Fable Medium open v1',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'duo-sol-medium-fable-max-open-v1',
    label: 'Duo Sol Medium plus Fable Max open v1',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'fable', effort: 'max' }
  },
  {
    id: 'duo-sol-max-fable-medium-open-v1',
    label: 'Duo Sol Max plus Fable Medium open v1',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'max' },
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'duo-sol-max-fable-max-open-v1',
    label: 'Duo Sol Max plus Fable Max open v1',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'max' },
    claude: { model: 'fable', effort: 'max' }
  }
]
const SOL_FABLE_2X2_OPEN_V2_ARMS = [
  {
    id: 'duo-sol-medium-fable-medium-open-v2',
    label: 'Duo Sol Medium plus Fable Medium open v2',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'duo-sol-medium-fable-max-open-v2',
    label: 'Duo Sol Medium plus Fable Max open v2',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    claude: { model: 'fable', effort: 'max' }
  },
  {
    id: 'duo-sol-max-fable-medium-open-v2',
    label: 'Duo Sol Max plus Fable Medium open v2',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'max' },
    claude: { model: 'fable', effort: 'medium' }
  },
  {
    id: 'duo-sol-max-fable-max-open-v2',
    label: 'Duo Sol Max plus Fable Max open v2',
    kind: 'duo',
    codex: { model: 'gpt-5.6-sol', effort: 'max' },
    claude: { model: 'fable', effort: 'max' }
  }
]
const CAPPED_DUO_RUNTIME = {
  executionMode: 'chaos',
  visibilityMode: 'spoiler-shield',
  missionProfile: 'serious',
  customizationProfile: 'core',
  qualityRoutingProfile: 'balanced',
  maxTurns: 7,
  maxRepairLoops: 0,
  workInferenceLimit: 8,
  turnTimeoutSeconds: 900,
  runTimeoutSeconds: 900
}
const OPEN_DUO_RUNTIME = {
  ...CAPPED_DUO_RUNTIME,
  turnTimeoutSeconds: 28_800,
  runTimeoutSeconds: 86_400
}
const FIXED_SUITES = {
  [DEFAULT_SUITE]: {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-decision-deck.json'),
    expectedArms: LOW_DIAGNOSTIC_ARMS,
    maxActiveSeconds: 900,
    expectedRuntime: CAPPED_DUO_RUNTIME
  },
  'premium-medium': {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-premium-medium.json'),
    expectedArms: PREMIUM_MEDIUM_ARMS,
    maxActiveSeconds: 900,
    expectedRuntime: CAPPED_DUO_RUNTIME
  },
  'premium-medium-open': {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-premium-medium-open.json'),
    expectedArms: PREMIUM_MEDIUM_OPEN_ARMS,
    maxActiveSeconds: null,
    expectedRuntime: OPEN_DUO_RUNTIME
  },
  'codex-effort-open-v1': {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-codex-effort-open-v1.json'),
    expectedArms: CODEX_EFFORT_OPEN_V1_ARMS,
    maxActiveSeconds: null,
    expectedRuntime: OPEN_DUO_RUNTIME
  },
  'sol-fable-2x2-open-v1': {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-sol-fable-2x2-open-v1.json'),
    expectedArms: SOL_FABLE_2X2_OPEN_V1_ARMS,
    maxActiveSeconds: null,
    expectedRuntime: OPEN_DUO_RUNTIME
  },
  'sol-fable-2x2-open-v2': {
    manifestPath: resolve(LIVE_FIXTURE_ROOT, 'short-matrix-sol-fable-2x2-open-v2.json'),
    expectedArms: SOL_FABLE_2X2_OPEN_V2_ARMS,
    maxActiveSeconds: null,
    expectedRuntime: OPEN_DUO_RUNTIME
  }
}

function fail(message) {
  throw new Error(message)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`Invalid short-matrix manifest: ${label} must be an object.`)
  return value
}

function exactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`Invalid short-matrix manifest: ${label} fields do not match the fixed contract.`)
  }
}

function safeString(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) fail(`Invalid short-matrix manifest: ${label} is unsafe.`)
  return value
}

function boundedPrompt(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 200 || value.length > 8_000) {
    fail('Invalid short-matrix manifest: prompt must be a bounded exact task.')
  }
  if (/(?:[A-Za-z]:\\|\\\\|Bearer\s|\bsk-|\bgh[pousr]_)/iu.test(value)) {
    fail('Invalid short-matrix manifest: prompt contains private or credential-like text.')
  }
  return value
}

function assertCanonicalPrompt(value) {
  const prompt = boundedPrompt(value)
  const promptSha256 = createHash('sha256').update(prompt).digest('hex')
  if (promptSha256 !== EXPECTED_PROMPT_SHA256) {
    fail('Invalid short-matrix manifest: canonical prompt hash changed from the preregistered task.')
  }
  return { prompt, promptSha256 }
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

async function canonicalDirectory(path, label) {
  const resolvedPath = resolve(path)
  const info = await lstat(resolvedPath)
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`The short matrix refused a linked or non-directory ${label}.`)
  const canonical = await realpath(resolvedPath)
  if (!samePath(canonical, resolvedPath)) fail(`The short matrix refused a noncanonical ${label}.`)
  return canonical
}

function normalizeRuntime(value, expected) {
  const runtime = record(value, 'duoRuntime')
  exactKeys(runtime, [
    'executionMode', 'visibilityMode', 'missionProfile', 'customizationProfile', 'qualityRoutingProfile',
    'maxTurns', 'maxRepairLoops', 'workInferenceLimit', 'turnTimeoutSeconds', 'runTimeoutSeconds'
  ], 'duoRuntime')
  if (JSON.stringify(runtime) !== JSON.stringify(expected)) fail('Invalid short-matrix manifest: Duo runtime must match its immutable suite contract.')
  return expected
}

function normalizeModel(value, label) {
  const model = record(value, label)
  exactKeys(model, ['model', 'effort'], label)
  return {
    model: safeString(model.model, SAFE_MODEL, `${label}.model`),
    effort: safeString(model.effort, /^[a-z][a-z-]{1,31}$/u, `${label}.effort`)
  }
}

function normalizeArm(value, index) {
  const input = record(value, `arms[${String(index)}]`)
  const kind = input.kind
  if (kind === 'solo' && input.agent === 'codex') {
    exactKeys(input, ['id', 'label', 'kind', 'agent', 'codex'], `arms[${String(index)}]`)
    return {
      id: safeString(input.id, SAFE_ID, `arms[${String(index)}].id`),
      label: safeString(input.label, SAFE_LABEL, `arms[${String(index)}].label`),
      kind,
      agent: 'codex',
      codex: normalizeModel(input.codex, `arms[${String(index)}].codex`)
    }
  }
  if (kind === 'solo' && input.agent === 'claude') {
    exactKeys(input, ['id', 'label', 'kind', 'agent', 'claude'], `arms[${String(index)}]`)
    return {
      id: safeString(input.id, SAFE_ID, `arms[${String(index)}].id`),
      label: safeString(input.label, SAFE_LABEL, `arms[${String(index)}].label`),
      kind,
      agent: 'claude',
      claude: normalizeModel(input.claude, `arms[${String(index)}].claude`)
    }
  }
  if (kind === 'duo') {
    exactKeys(input, ['id', 'label', 'kind', 'codex', 'claude'], `arms[${String(index)}]`)
    return {
      id: safeString(input.id, SAFE_ID, `arms[${String(index)}].id`),
      label: safeString(input.label, SAFE_LABEL, `arms[${String(index)}].label`),
      kind,
      codex: normalizeModel(input.codex, `arms[${String(index)}].codex`),
      claude: normalizeModel(input.claude, `arms[${String(index)}].claude`)
    }
  }
  fail(`Invalid short-matrix manifest: arms[${String(index)}] is not a supported fixed arm.`)
}

async function loadManifest(suiteId = DEFAULT_SUITE) {
  if (typeof suiteId !== 'string' || !SAFE_ID.test(suiteId) || !Object.hasOwn(FIXED_SUITES, suiteId)) {
    fail(`Unknown benchmark suite: ${String(suiteId)}`)
  }
  const suite = FIXED_SUITES[suiteId]
  const info = await lstat(suite.manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_MANIFEST_BYTES) {
    fail('Invalid short-matrix manifest: expected a bounded regular JSON file.')
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(suite.manifestPath, 'utf8'))
  } catch {
    fail('Invalid short-matrix manifest: file is not valid JSON.')
  }
  const input = record(parsed, 'root')
  exactKeys(input, ['schemaVersion', 'id', 'label', 'prompt', 'maxActiveSeconds', 'trials', 'duoRuntime', 'arms', 'judge'], 'root')
  if (input.schemaVersion !== 1) fail('Invalid short-matrix manifest: expected schemaVersion 1.')
  if (input.maxActiveSeconds !== suite.maxActiveSeconds) fail('Invalid short-matrix manifest: maxActiveSeconds must match its immutable suite contract.')
  if (!Array.isArray(input.trials) || JSON.stringify(input.trials) !== '[1,2]') fail('Invalid short-matrix manifest: trials must remain exactly 1 and 2.')
  if (!Array.isArray(input.arms) || input.arms.length !== suite.expectedArms.length) fail(`Invalid short-matrix manifest: exactly ${String(suite.expectedArms.length)} arms are required for ${suiteId}.`)
  const arms = input.arms.map(normalizeArm)
  if (JSON.stringify(arms) !== JSON.stringify(suite.expectedArms)) fail('Invalid short-matrix manifest: arms or loadouts changed from the predeclared comparison.')
  const judge = record(input.judge, 'judge')
  exactKeys(judge, ['requiredFiles', 'stableHooks'], 'judge')
  if (JSON.stringify(judge.requiredFiles) !== JSON.stringify(EXPECTED_REQUIRED_FILES) || JSON.stringify(judge.stableHooks) !== JSON.stringify(EXPECTED_STABLE_HOOKS)) {
    fail('Invalid short-matrix manifest: hidden-judge files or hooks changed.')
  }
  const canonicalPrompt = assertCanonicalPrompt(input.prompt)
  return {
    schemaVersion: 1,
    suite: suiteId,
    id: safeString(input.id, SAFE_ID, 'id'),
    label: safeString(input.label, SAFE_LABEL, 'label'),
    prompt: canonicalPrompt.prompt,
    promptSha256: canonicalPrompt.promptSha256,
    maxActiveSeconds: suite.maxActiveSeconds,
    trials: [1, 2],
    duoRuntime: normalizeRuntime(input.duoRuntime, suite.expectedRuntime),
    arms,
    judge: { requiredFiles: EXPECTED_REQUIRED_FILES, stableHooks: EXPECTED_STABLE_HOOKS }
  }
}

function activeWallMilliseconds(manifest) {
  return manifest.maxActiveSeconds === null ? undefined : manifest.maxActiveSeconds * 1_000
}

function parseArgs(args) {
  const options = { json: false, help: false, live: false, quotaAcknowledged: false, suiteId: undefined, armId: undefined, trial: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      if (options.json) fail('Duplicate --json argument.')
      options.json = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === LIVE_FLAG) {
      if (options.live) fail(`Duplicate ${LIVE_FLAG} argument.`)
      options.live = true
      continue
    }
    if (argument === QUOTA_FLAG) {
      if (options.quotaAcknowledged) fail(`Duplicate ${QUOTA_FLAG} argument.`)
      options.quotaAcknowledged = true
      continue
    }
    if (argument === '--suite') {
      if (options.suiteId !== undefined) fail('Duplicate --suite argument.')
      const next = args[index + 1]
      if (!next || next.startsWith('--')) fail('Missing suite identifier after --suite.')
      options.suiteId = next
      index += 1
      continue
    }
    if (argument === '--arm') {
      if (options.armId !== undefined) fail('Duplicate --arm argument.')
      const next = args[index + 1]
      if (!next || next.startsWith('--')) fail('Missing arm identifier after --arm.')
      options.armId = next
      index += 1
      continue
    }
    if (argument === '--trial') {
      if (options.trial !== undefined) fail('Duplicate --trial argument.')
      const next = args[index + 1]
      if (!next || next.startsWith('--')) fail('Missing trial after --trial; only 1 or 2 is allowed.')
      if (next !== '1' && next !== '2') fail('Invalid trial; only 1 or 2 is allowed.')
      options.trial = Number(next)
      index += 1
      continue
    }
    fail(`Unknown argument: ${argument}`)
  }
  return options
}

function publicArm(arm) {
  return {
    id: arm.id,
    label: arm.label,
    kind: arm.kind,
    ...(arm.agent ? { agent: arm.agent } : {}),
    ...(arm.codex ? { codex: arm.codex } : {}),
    ...(arm.claude ? { claude: arm.claude } : {})
  }
}

function dryReport(manifest, arm, trial) {
  const suiteSelector = manifest.suite === DEFAULT_SUITE ? '' : ` --suite ${manifest.suite}`
  return {
    schemaVersion: 1,
    benchmark: 'short-live-matrix',
    mode: 'dry-run',
    evidenceKind: 'fixed-manifest-preview',
    providerCallsMade: 0,
    directApiCallsMade: 0,
    suite: manifest.suite,
    task: { id: manifest.id, label: manifest.label, promptSha256: manifest.promptSha256 },
    maxActiveSeconds: manifest.maxActiveSeconds,
    trials: manifest.trials,
    arms: arm ? [publicArm(arm)] : manifest.arms.map(publicArm),
    ...(arm && trial ? { selection: { arm: arm.id, trial } } : {}),
    liveAuthorization: `Live execution requires${suiteSelector} ${LIVE_FLAG} ${QUOTA_FLAG} --arm <id> --trial <1|2>.`
  }
}

function buildSoloCommand(arm, workspacePath, prompt) {
  if (arm?.kind !== 'solo' || (arm.agent !== 'codex' && arm.agent !== 'claude')) fail('Solo command requires a fixed solo arm.')
  const cwd = resolve(workspacePath)
  const spawnOptions = { shell: false, windowsHide: true, detached: process.platform !== 'win32' }
  if (arm.agent === 'codex') {
    return {
      bin: 'codex',
      args: [
        '--ask-for-approval', 'never',
        '--sandbox', 'workspace-write',
        '--disable', 'plugins',
        '--disable', 'apps',
        '--disable', 'multi_agent',
        '--disable', 'hooks',
        '-c', 'skills.include_instructions=false',
        '-c', 'mcp_servers={}',
        '--model', arm.codex.model,
        '-c', `model_reasoning_effort="${arm.codex.effort}"`,
        '--cd', cwd,
        'exec',
        '--skip-git-repo-check',
        '--json',
        '--ephemeral',
        '-'
      ],
      cwd,
      stdin: prompt,
      spawnOptions
    }
  }
  return {
    bin: 'claude',
    args: [
      '--print',
      '--input-format', 'text',
      '--output-format', 'stream-json',
      '--verbose',
      '--safe-mode',
      '--disable-slash-commands',
      '--exclude-dynamic-system-prompt-sections',
      '--prompt-suggestions', 'false',
      '--permission-mode', 'acceptEdits',
      '--no-session-persistence',
      '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
      '--model', arm.claude.model,
      '--effort', arm.claude.effort
    ],
    cwd,
    stdin: prompt,
    spawnOptions
  }
}

function buildSoloEnvironment(source) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([name, value]) => {
        const normalized = name.toUpperCase()
        return value !== undefined && (ALLOWED_SOLO_ENVIRONMENT_NAMES.has(normalized) || normalized.startsWith('LC_'))
      })
    ),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1'
  }
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function providerUsageLine(agent, line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  const input = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  const usage = input && typeof input.usage === 'object' && input.usage !== null && !Array.isArray(input.usage) ? input.usage : undefined
  if (!input || !usage) return undefined
  if (agent === 'codex' && input.type === 'turn.completed') {
    return {
      processedInputTokens: nonNegativeNumber(usage.input_tokens),
      cachedInputTokens: nonNegativeNumber(usage.cached_input_tokens),
      outputTokens: nonNegativeNumber(usage.output_tokens),
      reasoningTokens: nonNegativeNumber(usage.reasoning_output_tokens),
      calls: 1
    }
  }
  if (agent === 'claude' && input.type === 'result') {
    return {
      processedInputTokens: nonNegativeNumber(usage.input_tokens) + nonNegativeNumber(usage.cache_creation_input_tokens) + nonNegativeNumber(usage.cache_read_input_tokens),
      cachedInputTokens: nonNegativeNumber(usage.cache_read_input_tokens),
      outputTokens: nonNegativeNumber(usage.output_tokens),
      reasoningTokens: 0,
      calls: 1
    }
  }
  return undefined
}

function providerRuntimeLine(agent, line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  const input = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  if (!input || typeof input.model !== 'string' || !SAFE_MODEL.test(input.model)) return undefined
  const isClaudeInit = agent === 'claude' && input.type === 'system' && input.subtype === 'init'
  const isCodexInit = agent === 'codex' && input.type === 'thread.started'
  if (!isClaudeInit && !isCodexInit) return undefined
  return { model: input.model, evidence: 'provider-stream-init' }
}

function emptyUsage() {
  return { processedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0 }
}

function addUsage(total, next) {
  for (const key of Object.keys(total)) total[key] += next[key]
}

async function regularBoundedText(path) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_SOURCE_BYTES) return undefined
  return await readFile(path, 'utf8')
}

async function artifactRoot(workspacePath, snapshot) {
  const canonicalWorkspace = await canonicalDirectory(workspacePath, 'isolated arm workspace')
  const candidates = []
  if (typeof snapshot?.appPath === 'string' && snapshot.appPath.trim()) {
    const appTarget = resolve(canonicalWorkspace, snapshot.appPath)
    if (pathInside(canonicalWorkspace, appTarget)) {
      try {
        const info = await lstat(appTarget)
        if (!info.isSymbolicLink()) candidates.push(info.isFile() ? dirname(appTarget) : appTarget)
      } catch {
        // The fixed fallback roots below remain available.
      }
    }
  }
  candidates.push(resolve(canonicalWorkspace, 'app'), canonicalWorkspace)
  for (const candidate of [...new Set(candidates)]) {
    if (!pathInside(canonicalWorkspace, candidate)) continue
    try {
      const canonicalCandidate = await canonicalDirectory(candidate, 'artifact root')
      if (!pathInside(canonicalWorkspace, canonicalCandidate)) continue
      const info = await lstat(resolve(canonicalCandidate, 'index.html'))
      if (info.isFile() && !info.isSymbolicLink()) return canonicalCandidate
    } catch {
      // Try the next fixed artifact root.
    }
  }
  return canonicalWorkspace
}

async function inspectArtifact(workspacePath, snapshot, judge) {
  const root = await artifactRoot(workspacePath, snapshot)
  const files = {}
  let combinedSource = ''
  for (const name of judge.requiredFiles) {
    try {
      const source = await regularBoundedText(resolve(root, name))
      files[name] = source !== undefined
      if (source !== undefined) combinedSource += `\n${source}`
    } catch {
      files[name] = false
    }
  }
  const hooks = Object.fromEntries(judge.stableHooks.map((hook) => [
    hook,
    new RegExp(
      `(?:data-testid\\s*=\\s*["']${hook}["']|dataset\\.testid\\s*=\\s*["']${hook}["']|setAttribute\\(\\s*["']data-testid["']\\s*,\\s*["']${hook}["']\\s*\\))`,
      'u'
    ).test(combinedSource)
  ]))
  let dependencyFree = true
  try {
    const packageSource = await regularBoundedText(resolve(root, 'package.json'))
    if (packageSource !== undefined) {
      const packageValue = JSON.parse(packageSource)
      const dependencies = typeof packageValue.dependencies === 'object' && packageValue.dependencies !== null ? Object.keys(packageValue.dependencies) : []
      const devDependencies = typeof packageValue.devDependencies === 'object' && packageValue.devDependencies !== null ? Object.keys(packageValue.devDependencies) : []
      dependencyFree = dependencies.length === 0 && devDependencies.length === 0
    }
  } catch {
    dependencyFree = false
  }
  const offlineSourceTrace = !/(?:https?:\/\/|<script[^>]+src\s*=\s*["']\/\/|\bfetch\s*\()/iu.test(combinedSource)
  const gates = {
    requiredFiles: Object.values(files).every(Boolean),
    stableHooks: Object.values(hooks).every(Boolean),
    dependencyFree,
    offlineSourceTrace
  }
  return {
    kind: 'arm-neutral-static-contract',
    artifactRoot: basename(root),
    files,
    hooks,
    gates,
    verdict: Object.values(gates).every(Boolean) ? 'pass' : 'fail',
    limitation: 'Static artifact contract only. It does not execute generated code or replace blinded product review.'
  }
}

async function inspectArtifactOrFailure(workspacePath, snapshot, judge) {
  try {
    return await inspectArtifact(workspacePath, snapshot, judge)
  } catch {
    return {
      kind: 'arm-neutral-static-contract',
      gates: { requiredFiles: false, stableHooks: false, dependencyFree: false, offlineSourceTrace: false },
      verdict: 'fail',
      limitation: 'Artifact inspection failed; no generated code was executed.'
    }
  }
}

function snapshotUsage(snapshot, agent) {
  const input = snapshot?.agentUsage?.[agent]
  if (typeof input !== 'object' || input === null) return emptyUsage()
  return {
    processedInputTokens: nonNegativeNumber(input.processedInputTokens),
    cachedInputTokens: nonNegativeNumber(input.cachedInputTokens),
    outputTokens: nonNegativeNumber(input.outputTokens),
    reasoningTokens: nonNegativeNumber(input.reasoningTokens),
    calls: Math.floor(nonNegativeNumber(input.calls))
  }
}

async function prepareOutputDirectory(manifest, armId, trial) {
  if (!SAFE_ID.test(armId) || (trial !== 1 && trial !== 2)) fail('The short matrix refused an unsafe execution selection.')
  await mkdir(BENCHMARK_RESULTS_ROOT, { recursive: true })
  const canonicalResults = await canonicalDirectory(BENCHMARK_RESULTS_ROOT, 'benchmark results root')
  await mkdir(resolve(canonicalResults, 'short-matrix'), { recursive: true })
  const canonicalMatrix = await canonicalDirectory(SHORT_MATRIX_ROOT, 'short-matrix results root')
  const slotsRoot = resolve(canonicalMatrix, '.slots')
  await mkdir(slotsRoot, { recursive: true })
  const canonicalSlots = await canonicalDirectory(slotsRoot, 'short-matrix trial slots')
  // Preserve the original Low slot keys while namespacing every added suite independently.
  const slotIdentity = manifest.suite === DEFAULT_SUITE ? manifest.id : `${manifest.suite}\n${manifest.id}`
  const slotId = createHash('sha256').update(`${slotIdentity}\n${armId}\n${String(trial)}`).digest('hex').slice(0, 32)
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'z').toLowerCase()
  const id = `run-${timestamp}-${randomUUID().slice(0, 8)}`
  const outputDirectory = resolve(canonicalMatrix, id)
  await mkdir(outputDirectory)
  const canonicalOutput = await canonicalDirectory(outputDirectory, 'short-matrix execution archive')
  const slotDirectory = resolve(canonicalSlots, slotId)
  let slotCreated = false
  try {
    await mkdir(slotDirectory)
    slotCreated = true
    await writeFile(resolve(slotDirectory, 'reservation.json'), `${JSON.stringify({
      suite: manifest.suite,
      taskId: manifest.id,
      armId,
      trial,
      runId: id,
      receipt: `${id}/receipt.json`
    }, null, 2)}\n`, 'utf8')
  } catch (error) {
    await rm(canonicalOutput, { recursive: true, force: true })
    if (slotCreated) await rm(slotDirectory, { recursive: true, force: true })
    if (error?.code === 'EEXIST') fail('This predeclared arm and trial slot was already attempted; the short matrix refuses replacement runs.')
    throw error
  }
  return canonicalOutput
}

function armDescriptor(arm, trial) {
  return {
    id: arm.id,
    label: arm.label,
    kind: arm.kind,
    trial,
    ...(arm.agent ? { agent: arm.agent } : {}),
    ...(arm.codex ? { codex: arm.codex } : {}),
    ...(arm.claude ? { claude: arm.claude } : {})
  }
}

function receiptBase(manifest, arm, trial) {
  return {
    schemaVersion: 1,
    benchmark: 'short-live-matrix',
    evidenceKind: 'live-local-cli',
    suite: manifest.suite,
    task: { id: manifest.id, label: manifest.label, promptSha256: manifest.promptSha256 },
    arm: armDescriptor(arm, trial),
    maxActiveSeconds: manifest.maxActiveSeconds,
    directApiCallsMade: 0,
    rawLogsSaved: false
  }
}

async function writeReceipt(outputDirectory, receipt) {
  await writeFile(resolve(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

async function preflightLive(arm, electronEntryPath = ELECTRON_ENTRY) {
  if (arm?.kind !== 'duo') return
  await access(electronEntryPath).catch(() => fail('Build output is missing. Run npm run build before reserving a live Duo matrix trial.'))
}

async function prepareLiveExecution(manifest, arm, trial, dependencies = {}) {
  const preflight = dependencies.preflight ?? preflightLive
  const reserve = dependencies.reserve ?? prepareOutputDirectory
  await preflight(arm)
  return await reserve(manifest, arm.id, trial)
}

function reservedFailureJudge() {
  return {
    kind: 'arm-neutral-static-contract',
    gates: { requiredFiles: false, stableHooks: false, dependencyFree: false, offlineSourceTrace: false },
    verdict: 'fail',
    limitation: 'Reserved execution failed before an artifact receipt could be produced.'
  }
}

async function executeReservedArm(manifest, arm, trial, outputDirectory, runner) {
  try {
    return await runner()
  } catch {
    const receipt = {
      ...receiptBase(manifest, arm, trial),
      status: 'harness-error',
      activeTimeMs: 0,
      providerCallsMade: 0,
      providerUsage: { codex: emptyUsage(), claude: emptyUsage(), evidence: 'unavailable' },
      judge: reservedFailureJudge(),
      preservedWorkspace: false,
      failureCode: 'reserved-execution-failed',
      qualityClaim: 'No product-quality claim is possible because the reserved harness execution failed.'
    }
    await writeReceipt(outputDirectory, receipt)
    return { receipt, evidencePreserved: false }
  }
}

async function runSolo(manifest, arm, trial, outputDirectory) {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'duo-short-matrix-solo-'))
  const workspacePath = resolve(workspaceRoot, 'workspace')
  const userData = await mkdtemp(resolve(tmpdir(), 'duo-short-matrix-solo-runtime-'))
  await mkdir(workspacePath)
  const command = buildSoloCommand(arm, workspacePath, manifest.prompt)
  const usage = emptyUsage()
  let usageRecords = 0
  let observedRuntime
  let child
  let exitCode = null
  let signal = null
  let spawnFailed = false
  let timedOut = false
  let evidencePreserved = false
  const startedAt = Date.now()
  const activeWallMs = activeWallMilliseconds(manifest)
  try {
    child = crossSpawn(command.bin, command.args, {
      ...command.spawnOptions,
      cwd: command.cwd,
      env: buildSoloEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(command.stdin)
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      const parsed = providerUsageLine(arm.agent, line)
      if (parsed) {
        addUsage(usage, parsed)
        usageRecords += 1
      }
      observedRuntime ??= providerRuntimeLine(arm.agent, line)
    })
    child.stderr.resume()
    const exit = new Promise((resolveExit) => {
      child.once('error', () => {
        spawnFailed = true
        resolveExit()
      })
      child.once('close', (code, nextSignal) => {
        exitCode = code
        signal = nextSignal
        resolveExit()
      })
    })
    if (activeWallMs === undefined) {
      await exit
    } else {
      const watchdog = new Promise((resolveTimeout) => {
        const timer = setTimeout(() => {
          timedOut = true
          void terminateElectronProcessTree(child)
            .catch(() => child.kill())
            .finally(resolveTimeout)
        }, activeWallMs)
        exit.finally(() => clearTimeout(timer)).catch(() => undefined)
      })
      await Promise.race([exit, watchdog])
    }
    if (timedOut) await Promise.race([exit, new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))])
    lines.close()
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await terminateElectronProcessTree(child).catch(() => child.kill())
  }

  const elapsedMs = Date.now() - startedAt
  const activeTimeMs = activeWallMs === undefined ? elapsedMs : Math.min(elapsedMs, activeWallMs)
  const status = timedOut ? 'timed-out' : spawnFailed || exitCode !== 0 ? 'failed' : 'complete'
  const judge = await inspectArtifactOrFailure(workspacePath, undefined, manifest.judge)
  let receipt = {
    ...receiptBase(manifest, arm, trial),
    status,
    activeTimeMs,
    providerCallsMade: usage.calls,
    providerUsage: {
      codex: arm.agent === 'codex' ? usage : emptyUsage(),
      claude: arm.agent === 'claude' ? usage : emptyUsage(),
      evidence: usageRecords > 0 ? 'provider-reported' : 'unavailable'
    },
    runtimeEvidence: {
      [arm.agent]: {
        requestedModel: arm[arm.agent].model,
        requestedEffort: arm[arm.agent].effort,
        ...(observedRuntime
          ? { observedModel: observedRuntime.model, evidence: observedRuntime.evidence }
          : { evidence: 'requested-only' })
      }
    },
    process: { exitCode, signal: typeof signal === 'string' ? signal : undefined },
    judge,
    preservedWorkspace: false,
    qualityClaim: 'One fixed arm and trial. Compare preserved artifacts blindly; this receipt alone does not prove product quality.'
  }
  try {
    await preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot: { workspacePath } })
    evidencePreserved = true
    receipt = { ...receipt, preservedWorkspace: true }
    await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })])
  } catch {
    receipt = { ...receipt, status: 'harness-error', preservationFailure: true }
  }
  await writeReceipt(outputDirectory, receipt)
  return { receipt, evidencePreserved }
}

async function runDuo(manifest, arm, trial, outputDirectory) {
  await access(ELECTRON_ENTRY).catch(() => fail('Build output is missing. Run npm run build before a live Duo matrix arm.'))
  const userData = await mkdtemp(resolve(tmpdir(), 'duo-short-matrix-userdata-'))
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'duo-short-matrix-workspace-'))
  let application
  let snapshot
  let timedOut = false
  let caughtError
  let shutdownFailed = false
  let evidencePreserved = false
  const activeWallMs = activeWallMilliseconds(manifest)
  try {
    const { _electron } = await import('@playwright/test')
    application = await _electron.launch({
      args: [ELECTRON_ENTRY],
      env: sanitizedElectronEnvironment({
        DUO_CHAOS_E2E: '1',
        DUO_CHAOS_E2E_USER_DATA: userData,
        DUO_CHAOS_E2E_DEFAULT_WORKSPACE: workspaceRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      })
    })
    const page = await application.firstWindow()
    const runId = await page.evaluate(async ({ runtime, selectedArm, prompt, isolatedWorkspaceRoot }) => {
      const bootstrap = await window.duo.getBootstrap()
      await window.duo.saveSettings({
        ...bootstrap.settings,
        defaultWorkspaceRoot: isolatedWorkspaceRoot,
        defaultExecutionMode: runtime.executionMode,
        defaultVisibilityMode: runtime.visibilityMode,
        defaultMissionProfile: runtime.missionProfile,
        saveRawLogs: false,
        maxTurns: runtime.maxTurns,
        maxRepairLoops: runtime.maxRepairLoops,
        turnTimeoutSeconds: runtime.turnTimeoutSeconds,
        runTimeoutSeconds: runtime.runTimeoutSeconds,
        workInferenceLimit: runtime.workInferenceLimit,
        codexModel: selectedArm.codex.model,
        codexEffort: selectedArm.codex.effort,
        claudeModel: selectedArm.claude.model,
        claudeEffort: selectedArm.claude.effort,
        codexCustomizationProfile: runtime.customizationProfile,
        claudeCustomizationProfile: runtime.customizationProfile,
        qualityRoutingProfile: runtime.qualityRoutingProfile,
        trustedLocalCapabilitiesConfirmed: false
      })
      const started = await window.duo.startRun({
        prompt,
        workspaceRoot: isolatedWorkspaceRoot,
        executionMode: runtime.executionMode,
        visibilityMode: runtime.visibilityMode,
        missionProfile: runtime.missionProfile,
        maxTurns: runtime.maxTurns,
        maxRepairLoops: runtime.maxRepairLoops,
        turnTimeoutSeconds: runtime.turnTimeoutSeconds,
        runTimeoutSeconds: runtime.runTimeoutSeconds,
        workInferenceLimit: runtime.workInferenceLimit,
        dangerousModeConfirmed: false,
        unsafeWorkspaceRootConfirmed: true,
        codexCustomizationProfile: runtime.customizationProfile,
        claudeCustomizationProfile: runtime.customizationProfile,
        trustedLocalCapabilitiesConfirmed: false,
        qualityRoutingProfile: runtime.qualityRoutingProfile,
        codexModel: selectedArm.codex.model,
        codexEffort: selectedArm.codex.effort,
        claudeModel: selectedArm.claude.model,
        claudeEffort: selectedArm.claude.effort
      })
      return started.runId
    }, { runtime: manifest.duoRuntime, selectedArm: arm, prompt: manifest.prompt, isolatedWorkspaceRoot: workspaceRoot })
    const terminal = await waitForTerminalSnapshot({
      timeoutMs: activeWallMs === undefined ? undefined : activeWallMs + 30_000,
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
    timedOut = terminal.timedOut
    if (!snapshot) fail('The Duo matrix arm ended without a supervisor snapshot.')
  } catch (error) {
    caughtError = error
  } finally {
    if (application) {
      try {
        await closeElectronApplication(application)
      } catch {
        shutdownFailed = true
      }
    }
  }

  const workspacePath = typeof snapshot?.workspacePath === 'string' ? snapshot.workspacePath : workspaceRoot
  const judge = await inspectArtifactOrFailure(workspacePath, snapshot, manifest.judge)
  const snapshotStatus = typeof snapshot?.status === 'string' && TERMINAL_STATUSES.has(snapshot.status) ? snapshot.status : undefined
  const status = shutdownFailed || caughtError ? 'harness-error' : timedOut ? 'timed-out' : snapshotStatus ?? 'failed'
  const codexUsage = snapshotUsage(snapshot, 'codex')
  const claudeUsage = snapshotUsage(snapshot, 'claude')
  const runtimeEvidence = Object.fromEntries(['codex', 'claude'].map((agent) => {
    const requested = arm[agent]
    const observed = snapshot?.agentRuntimes?.[agent]
    return [agent, {
      requestedModel: requested.model,
      requestedEffort: requested.effort,
      ...(typeof observed?.model === 'string' ? { supervisorModel: observed.model } : {}),
      ...(typeof observed?.effort === 'string' ? { supervisorEffort: observed.effort } : {}),
      evidence: observed ? `supervisor-${observed.source ?? 'runtime'}` : 'requested-only'
    }]
  }))
  let receipt = {
    ...receiptBase(manifest, arm, trial),
    status,
    activeTimeMs: activeWallMs === undefined
      ? nonNegativeNumber(snapshot?.activeTimeMs)
      : Math.min(nonNegativeNumber(snapshot?.activeTimeMs), activeWallMs),
    providerCallsMade: codexUsage.calls + claudeUsage.calls,
    providerUsage: {
      codex: codexUsage,
      claude: claudeUsage,
      evidence: snapshot ? 'supervisor-reported' : 'unavailable'
    },
    runtimeEvidence,
    supervisor: snapshot ? {
      phase: typeof snapshot.phase === 'string' && SAFE_ID.test(snapshot.phase) ? snapshot.phase : undefined,
      releaseStatus: ['ready', 'partial', 'failed'].includes(snapshot.releaseStatus) ? snapshot.releaseStatus : 'unavailable'
    } : undefined,
    judge,
    preservedWorkspace: false,
    qualityClaim: 'One fixed arm and trial. Compare preserved artifacts blindly; this receipt alone does not prove product quality.'
  }
  try {
    await preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot })
    evidencePreserved = true
    receipt = { ...receipt, preservedWorkspace: true }
    await Promise.all([rm(workspaceRoot, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })])
  } catch {
    receipt = { ...receipt, status: 'harness-error', preservationFailure: true }
  }
  await writeReceipt(outputDirectory, receipt)
  return { receipt, evidencePreserved }
}

async function runLive(manifest, arm, trial, jsonOutput) {
  const outputDirectory = await prepareLiveExecution(manifest, arm, trial)
  const execution = await executeReservedArm(
    manifest,
    arm,
    trial,
    outputDirectory,
    () => arm.kind === 'solo'
      ? runSolo(manifest, arm, trial, outputDirectory)
      : runDuo(manifest, arm, trial, outputDirectory)
  )
  const summary = {
    benchmark: execution.receipt.benchmark,
    suite: manifest.suite,
    arm: arm.id,
    trial,
    status: execution.receipt.status,
    judge: execution.receipt.judge.verdict,
    providerCallsMade: execution.receipt.providerCallsMade,
    receipt: relative(REPOSITORY_ROOT, resolve(outputDirectory, 'receipt.json')).replaceAll('\\', '/'),
    preservedWorkspace: execution.evidencePreserved
  }
  process.stdout.write(jsonOutput ? `${JSON.stringify(summary, null, 2)}\n` : `${JSON.stringify(summary)}\n`)
  if (execution.receipt.status !== 'complete' && execution.receipt.status !== 'reveal-ready') process.exitCode = 3
}

async function main() {
  let enteredLiveExecution = false
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(`Usage: npm run benchmark:matrix -- [--suite <low-diagnostic|premium-medium|premium-medium-open|codex-effort-open-v1|sol-fable-2x2-open-v1|sol-fable-2x2-open-v2>] [--json] [--arm <id> --trial <1|2>] [${LIVE_FLAG} ${QUOTA_FLAG}]\nDry-run is the default. Live mode executes exactly one fixed arm and trial from the selected immutable suite.\n`)
      return
    }
    if (options.live !== options.quotaAcknowledged) {
      process.stderr.write(`Both ${LIVE_FLAG} and ${QUOTA_FLAG} are required. No provider or direct API call was made.\n`)
      process.exitCode = 2
      return
    }
    if (options.live && (!options.armId || !options.trial)) {
      process.stderr.write('Live mode requires one explicit --arm <id> and --trial <1|2>. No provider or direct API call was made.\n')
      process.exitCode = 2
      return
    }
    if ((options.armId === undefined) !== (options.trial === undefined)) {
      fail('Dry-run selection requires both --arm and --trial.')
    }
    const manifest = await loadManifest(options.suiteId ?? DEFAULT_SUITE)
    const arm = options.armId ? manifest.arms.find((entry) => entry.id === options.armId) : undefined
    if (options.armId && !arm) fail(`Unknown arm: ${String(options.armId)}`)
    if (!options.live) {
      const report = dryReport(manifest, arm, options.trial)
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${JSON.stringify(report)}\n`)
      return
    }
    enteredLiveExecution = true
    await runLive(manifest, arm, options.trial, options.json)
  } catch (error) {
    const suffix = enteredLiveExecution ? '' : ' No provider or direct API call was made.'
    process.stderr.write(`${error instanceof Error ? error.message : 'Short live matrix failed.'}${suffix}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

export {
  activeWallMilliseconds,
  assertCanonicalPrompt,
  buildSoloCommand,
  buildSoloEnvironment,
  dryReport,
  inspectArtifact,
  loadManifest,
  parseArgs,
  prepareLiveExecution,
  providerRuntimeLine,
  providerUsageLine,
  executeReservedArm
}
