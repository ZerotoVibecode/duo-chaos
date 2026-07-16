import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts', 'benchmark-short-matrix.mjs')
const fixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'short-matrix-decision-deck.json')
const mediumFixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'short-matrix-premium-medium.json')
const openMediumFixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'short-matrix-premium-medium-open.json')
const codexEffortOpenFixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'short-matrix-codex-effort-open-v1.json')
const solFableOpenFixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'short-matrix-sol-fable-2x2-open-v1.json')

interface MatrixArm {
  id: string
  kind: 'solo' | 'duo'
  agent?: 'codex' | 'claude'
  codex?: { model: string; effort: string }
  claude?: { model: string; effort: string }
}

interface MatrixHarness {
  assertCanonicalPrompt: (prompt: string) => { prompt: string; promptSha256: string }
  activeWallMilliseconds: (manifest: { maxActiveSeconds: number | null }) => number | undefined
  buildSoloEnvironment: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  buildSoloCommand: (arm: MatrixArm, workspacePath: string, prompt: string) => {
    bin: string
    args: string[]
    cwd: string
    stdin: string
    spawnOptions: { shell: false; windowsHide: true }
  }
  loadManifest: (suiteId?: string) => Promise<{
    suite: string
    prompt: string
    maxActiveSeconds: number | null
    trials: number[]
    duoRuntime: { turnTimeoutSeconds: number; runTimeoutSeconds: number }
    arms: MatrixArm[]
    judge: { requiredFiles: string[]; stableHooks: string[] }
  }>
  providerUsageLine: (agent: 'claude' | 'codex', line: string) => {
    processedInputTokens: number
    cachedInputTokens: number
    outputTokens: number
    reasoningTokens: number
    calls: number
  } | undefined
  providerRuntimeLine: (agent: 'claude' | 'codex', line: string) => { model: string; evidence: string } | undefined
  inspectArtifact: (workspacePath: string, snapshot: undefined, judge: { requiredFiles: string[]; stableHooks: string[] }) => Promise<{
    gates: { dependencyFree: boolean }
    verdict: 'pass' | 'fail'
  }>
  prepareLiveExecution: (
    manifest: Awaited<ReturnType<MatrixHarness['loadManifest']>>,
    arm: MatrixArm,
    trial: 1 | 2,
    dependencies: {
      preflight: (arm: MatrixArm) => Promise<void>
      reserve: (manifest: unknown, armId: string, trial: 1 | 2) => Promise<string>
    }
  ) => Promise<string>
  executeReservedArm: (
    manifest: Awaited<ReturnType<MatrixHarness['loadManifest']>>,
    arm: MatrixArm,
    trial: 1 | 2,
    outputDirectory: string,
    runner: () => Promise<never>
  ) => Promise<{ receipt: { status: string; providerCallsMade: number }; evidencePreserved: boolean }>
}

async function harness(): Promise<MatrixHarness> {
  return await import('../../scripts/benchmark-short-matrix.mjs') as unknown as MatrixHarness
}

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

describe('short live matrix benchmark contract', () => {
  it('is a zero-call dry run by default and declares the fixed four-arm matrix', async () => {
    const result = await execute(['--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'short-live-matrix',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      suite: 'low-diagnostic',
      maxActiveSeconds: 900,
      trials: [1, 2],
      arms: [
        { id: 'codex-terra-low-solo', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-terra', effort: 'low' } },
        { id: 'claude-sonnet-low-solo', kind: 'solo', agent: 'claude', claude: { model: 'sonnet', effort: 'low' } },
        { id: 'duo-terra-low-sonnet-low', kind: 'duo', codex: { model: 'gpt-5.6-terra', effort: 'low' }, claude: { model: 'sonnet', effort: 'low' } },
        { id: 'duo-terra-low-sonnet-medium', kind: 'duo', codex: { model: 'gpt-5.6-terra', effort: 'low' }, claude: { model: 'sonnet', effort: 'medium' } }
      ]
    })
    expect(result.stdout).not.toMatch(/generatedAt|timestamp|workspacePath|C:\\Users/iu)
  })

  it('declares a separate preregistered Medium suite without changing the Low diagnostic suite', async () => {
    const result = await execute(['--suite', 'premium-medium', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'short-live-matrix',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      suite: 'premium-medium',
      maxActiveSeconds: 900,
      trials: [1, 2],
      arms: [
        { id: 'codex-sol-medium-solo', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-sol', effort: 'medium' } },
        { id: 'claude-fable-medium-solo', kind: 'solo', agent: 'claude', claude: { model: 'fable', effort: 'medium' } },
        { id: 'claude-opus-medium-solo', kind: 'solo', agent: 'claude', claude: { model: 'opus', effort: 'medium' } },
        { id: 'duo-sol-medium-fable-medium', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'medium' }, claude: { model: 'fable', effort: 'medium' } },
        { id: 'duo-sol-medium-opus-medium', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'medium' }, claude: { model: 'opus', effort: 'medium' } }
      ]
    })
    const preview = JSON.parse(result.stdout) as { liveAuthorization: string }
    expect(preview.liveAuthorization).toContain('--suite premium-medium')
    expect(result.stdout).not.toMatch(/terra|sonnet/iu)
  })

  it('declares a separate open-work Sol plus Opus Medium suite without reopening historical slots', async () => {
    const result = await execute(['--suite', 'premium-medium-open', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'short-live-matrix',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      suite: 'premium-medium-open',
      maxActiveSeconds: null,
      trials: [1, 2],
      arms: [
        { id: 'duo-sol-medium-opus-medium', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'medium' }, claude: { model: 'opus', effort: 'medium' } }
      ]
    })
    const preview = JSON.parse(result.stdout) as { liveAuthorization: string }
    expect(preview.liveAuthorization).toContain('--suite premium-medium-open')
    expect(result.stdout).not.toMatch(/fable|terra|sonnet/iu)
  })

  it('declares the uncapped Codex effort ladder in its preregistered execution order', async () => {
    const result = await execute(['--suite', 'codex-effort-open-v1', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'short-live-matrix',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      suite: 'codex-effort-open-v1',
      maxActiveSeconds: null,
      trials: [1, 2],
      arms: [
        { id: 'codex-sol-medium-solo-open-v1', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-sol', effort: 'medium' } },
        { id: 'codex-sol-low-solo-open-v1', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-sol', effort: 'low' } },
        { id: 'codex-terra-medium-solo-open-v1', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-terra', effort: 'medium' } },
        { id: 'codex-sol-max-solo-open-v1', kind: 'solo', agent: 'codex', codex: { model: 'gpt-5.6-sol', effort: 'max' } }
      ]
    })
  })

  it('declares the uncapped Sol and Fable 2x2 in its preregistered execution order', async () => {
    const result = await execute(['--suite', 'sol-fable-2x2-open-v1', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'short-live-matrix',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      suite: 'sol-fable-2x2-open-v1',
      maxActiveSeconds: null,
      trials: [1, 2],
      arms: [
        { id: 'duo-sol-medium-fable-medium-open-v1', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'medium' }, claude: { model: 'fable', effort: 'medium' } },
        { id: 'duo-sol-medium-fable-max-open-v1', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'medium' }, claude: { model: 'fable', effort: 'max' } },
        { id: 'duo-sol-max-fable-medium-open-v1', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'max' }, claude: { model: 'fable', effort: 'medium' } },
        { id: 'duo-sol-max-fable-max-open-v1', kind: 'duo', codex: { model: 'gpt-5.6-sol', effort: 'max' }, claude: { model: 'fable', effort: 'max' } }
      ]
    })
  })

  it.each([
    ['live without quota acknowledgement', ['--live', '--arm', 'codex-terra-low-solo', '--trial', '1']],
    ['quota acknowledgement without live', ['--i-understand-this-uses-local-cli-quota', '--arm', 'codex-terra-low-solo', '--trial', '1']],
    ['live without a selected arm', ['--live', '--i-understand-this-uses-local-cli-quota', '--trial', '1']],
    ['live without a selected trial', ['--live', '--i-understand-this-uses-local-cli-quota', '--arm', 'codex-terra-low-solo']]
  ])('refuses %s before any provider starts', async (_label, args) => {
    const result = await execute(args)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/no provider/iu)
  })

  it.each([
    [['--model', 'gpt-5.6-sol'], /unknown argument/iu],
    [['--arm', 'codex-terra-low-solo;calc', '--trial', '1'], /unknown arm/iu],
    [['--arm', 'codex-terra-low-solo', '--trial', '3'], /trial.*1.*2/iu],
    [['--arm', 'codex-terra-low-solo', '--arm', 'claude-sonnet-low-solo', '--trial', '1'], /duplicate.*arm/iu],
    [['--suite', 'unknown-suite'], /unknown.*suite/iu],
    [['--suite', 'premium-medium', '--suite', 'low-diagnostic'], /duplicate.*suite/iu],
    [['--suite', 'premium-medium', '--arm', 'codex-terra-low-solo', '--trial', '1'], /unknown arm/iu]
  ])('rejects unsafe or non-comparable selectors without a provider call', async (args, pattern) => {
    const result = await execute(args)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(pattern)
    expect(result.stderr).toMatch(/no provider/iu)
  })

  it('pins the exact dependency-free Decision Deck task and hidden-judge hooks', async () => {
    const { assertCanonicalPrompt, loadManifest } = await harness()
    const manifest = await loadManifest()
    const source = await readFile(fixture, 'utf8')

    expect(manifest.maxActiveSeconds).toBe(900)
    expect(manifest.trials).toEqual([1, 2])
    expect(manifest.judge.requiredFiles).toEqual(['index.html', 'app.js', 'logic.js', 'logic.test.mjs'])
    expect(manifest.judge.stableHooks).toEqual([
      'options-input',
      'start',
      'choose-left',
      'choose-right',
      'ranking-item',
      'reset',
      'status'
    ])
    expect(manifest.prompt).toContain('dependency-free')
    expect(manifest.prompt).toContain('work completely offline')
    for (const file of manifest.judge.requiredFiles) expect(manifest.prompt).toContain(file)
    for (const hook of manifest.judge.stableHooks) expect(manifest.prompt).toContain(`data-testid="${hook}"`)
    expect(assertCanonicalPrompt(manifest.prompt).promptSha256).toBe('d5603bd7c0b78bd302f1aa971a70c2645e76139fbfead998415ae0a95da2c657')
    expect(() => assertCanonicalPrompt(manifest.prompt.replace('polished', 'beautiful')))
      .toThrow(/canonical.*prompt.*hash|prompt.*hash.*canonical/iu)
    expect(source).not.toMatch(/"(?:script|shell|command|url)"\s*:/iu)
  })

  it('preflights a Duo arm before reserving its immutable trial slot', async () => {
    const { loadManifest, prepareLiveExecution } = await harness()
    const manifest = await loadManifest('premium-medium-open')
    const arm = manifest.arms[0]
    if (!arm) throw new Error('Expected the fixed open-work Duo arm.')
    let reservationAttempted = false

    await expect(prepareLiveExecution(manifest, arm, 1, {
      preflight: () => Promise.reject(new Error('missing Electron build')),
      reserve: () => {
        reservationAttempted = true
        return Promise.resolve('must-not-exist')
      }
    })).rejects.toThrow(/missing Electron build/iu)
    expect(reservationAttempted).toBe(false)
  })

  it('writes a terminal receipt when an already-reserved executor fails unexpectedly', async () => {
    const { executeReservedArm, loadManifest } = await harness()
    const manifest = await loadManifest('premium-medium-open')
    const arm = manifest.arms[0]
    if (!arm) throw new Error('Expected the fixed open-work Duo arm.')
    const outputDirectory = resolve('benchmark-results', 'reserved-execution-contract')
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    try {
      const execution = await executeReservedArm(manifest, arm, 1, outputDirectory, () => {
        throw new Error('synthetic executor failure')
      })
      const saved = JSON.parse(await readFile(resolve(outputDirectory, 'receipt.json'), 'utf8')) as {
        status: string
        providerCallsMade: number
        failureCode: string
      }

      expect(execution).toMatchObject({ receipt: { status: 'harness-error', providerCallsMade: 0 }, evidencePreserved: false })
      expect(saved).toMatchObject({
        status: 'harness-error',
        providerCallsMade: 0,
        failureCode: 'reserved-execution-failed'
      })
      expect(JSON.stringify(saved)).not.toContain('synthetic executor failure')
    } finally {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  it('keeps both historical suites pinned to the same task, runtime ceiling, and hidden judge', async () => {
    const { loadManifest } = await harness()
    const low = await loadManifest()
    const medium = await loadManifest('premium-medium')
    const source = await readFile(mediumFixture, 'utf8')

    expect(low.suite).toBe('low-diagnostic')
    expect(medium.suite).toBe('premium-medium')
    expect(medium.prompt).toBe(low.prompt)
    expect(medium.maxActiveSeconds).toBe(low.maxActiveSeconds)
    expect(medium.trials).toEqual(low.trials)
    expect(medium.judge).toEqual(low.judge)
    expect(source).not.toMatch(/"(?:script|shell|command|url)"\s*:/iu)
  })

  it('pins open-work execution to the same task and judge without a harness active wall', async () => {
    const { activeWallMilliseconds, loadManifest } = await harness()
    const historical = await loadManifest('premium-medium')
    const open = await loadManifest('premium-medium-open')
    const source = await readFile(openMediumFixture, 'utf8')

    expect(open.prompt).toBe(historical.prompt)
    expect(open.maxActiveSeconds).toBeNull()
    expect(activeWallMilliseconds(open)).toBeUndefined()
    expect(activeWallMilliseconds(historical)).toBe(900_000)
    expect(open.duoRuntime).toMatchObject({
      turnTimeoutSeconds: 28_800,
      runTimeoutSeconds: 86_400
    })
    expect(open.trials).toEqual(historical.trials)
    expect(open.judge).toEqual(historical.judge)
    expect(source).not.toMatch(/"(?:script|shell|command|url)"\s*:/iu)
  })

  it.each([
    ['codex-effort-open-v1', codexEffortOpenFixture],
    ['sol-fable-2x2-open-v1', solFableOpenFixture]
  ])('pins %s to the canonical task, improved judge, and open supervisor runtime', async (suiteId, fixturePath) => {
    const { activeWallMilliseconds, assertCanonicalPrompt, loadManifest } = await harness()
    const canonical = await loadManifest('premium-medium-open')
    const manifest = await loadManifest(suiteId)
    const source = await readFile(fixturePath, 'utf8')

    expect(manifest.prompt).toBe(canonical.prompt)
    expect(assertCanonicalPrompt(manifest.prompt).promptSha256).toBe('d5603bd7c0b78bd302f1aa971a70c2645e76139fbfead998415ae0a95da2c657')
    expect(manifest.maxActiveSeconds).toBeNull()
    expect(activeWallMilliseconds(manifest)).toBeUndefined()
    expect(manifest.duoRuntime).toEqual(canonical.duoRuntime)
    expect(manifest.judge).toEqual(canonical.judge)
    expect(manifest.trials).toEqual([1, 2])
    expect(source).not.toMatch(/"(?:script|shell|command|url)"\s*:/iu)
  })

  it('passes Sol Max literally as model_reasoning_effort=max to the Codex CLI', async () => {
    const { buildSoloCommand, loadManifest } = await harness()
    const manifest = await loadManifest('codex-effort-open-v1')
    const arm = manifest.arms.find((entry) => entry.id === 'codex-sol-max-solo-open-v1')
    if (!arm) throw new Error('Expected the fixed Sol Max arm.')

    const command = buildSoloCommand(arm, resolve('benchmark-results', 'sol-max-literal-effort'), manifest.prompt)
    expect(command.args).toEqual(expect.arrayContaining([
      '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="max"'
    ]))
    expect(command.args).not.toEqual(expect.arrayContaining(['model_reasoning_effort="extra-high"']))
  })

  it('builds shell-free, ephemeral Core-only solo commands with the prompt on stdin', async () => {
    const { buildSoloCommand, loadManifest } = await harness()
    const manifest = await loadManifest()
    const workspace = resolve('benchmark-results', 'test-workspace')
    const codexArm = manifest.arms.find((arm) => arm.id === 'codex-terra-low-solo')
    const claudeArm = manifest.arms.find((arm) => arm.id === 'claude-sonnet-low-solo')
    expect(codexArm).toBeDefined()
    expect(claudeArm).toBeDefined()

    const codex = buildSoloCommand(codexArm!, workspace, manifest.prompt)
    expect(codex).toMatchObject({ bin: 'codex', cwd: workspace, stdin: manifest.prompt, spawnOptions: { shell: false, windowsHide: true } })
    expect(codex.args).toEqual(expect.arrayContaining([
      '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'hooks',
      '-c', 'skills.include_instructions=false', '-c', 'mcp_servers={}',
      '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="low"',
      '--cd', workspace, 'exec', '--skip-git-repo-check', '--json', '--ephemeral', '-'
    ]))
    expect(codex.args).not.toEqual(expect.arrayContaining(['--dangerously-bypass-approvals-and-sandbox', manifest.prompt]))

    const claude = buildSoloCommand(claudeArm!, workspace, manifest.prompt)
    expect(claude).toMatchObject({ bin: 'claude', cwd: workspace, stdin: manifest.prompt, spawnOptions: { shell: false, windowsHide: true } })
    expect(claude.args).toEqual(expect.arrayContaining([
      '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--disable-slash-commands', '--permission-mode', 'acceptEdits',
      '--no-session-persistence', '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
      '--model', 'sonnet', '--effort', 'low'
    ]))
    expect(claude.args).not.toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--resume', '--continue', manifest.prompt]))
  })

  it('passes the exact Medium aliases and efforts to the solo CLIs', async () => {
    const { buildSoloCommand, loadManifest } = await harness()
    const manifest = await loadManifest('premium-medium')
    const workspace = resolve('benchmark-results', 'test-workspace-medium')
    const codexArm = manifest.arms.find((arm) => arm.id === 'codex-sol-medium-solo')
    const fableArm = manifest.arms.find((arm) => arm.id === 'claude-fable-medium-solo')
    const opusArm = manifest.arms.find((arm) => arm.id === 'claude-opus-medium-solo')
    expect(codexArm).toBeDefined()
    expect(fableArm).toBeDefined()
    expect(opusArm).toBeDefined()

    expect(buildSoloCommand(codexArm!, workspace, manifest.prompt).args).toEqual(expect.arrayContaining([
      '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="medium"'
    ]))
    expect(buildSoloCommand(fableArm!, workspace, manifest.prompt).args).toEqual(expect.arrayContaining([
      '--model', 'fable', '--effort', 'medium'
    ]))
    expect(buildSoloCommand(opusArm!, workspace, manifest.prompt).args).toEqual(expect.arrayContaining([
      '--model', 'opus', '--effort', 'medium'
    ]))
  })

  it('passes only the local runtime allowlist to solo provider processes', async () => {
    const { buildSoloEnvironment } = await harness()
    const environment = buildSoloEnvironment({
      PATH: 'C:\\Tools',
      APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
      CODEX_HOME: 'C:\\Users\\owner\\.codex',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\owner\\.claude',
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      GH_TOKEN: 'must-not-leak',
      VITE_PRIVATE_VALUE: 'must-not-leak',
      NODE_OPTIONS: '--require malicious.js'
    })

    expect(environment).toMatchObject({
      PATH: 'C:\\Tools',
      APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
      CODEX_HOME: 'C:\\Users\\owner\\.codex',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\owner\\.claude'
    })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(environment).not.toHaveProperty('GH_TOKEN')
    expect(environment).not.toHaveProperty('VITE_PRIVATE_VALUE')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })

  it('counts one terminal CLI invocation per solo result regardless of provider-internal turns', async () => {
    const { providerUsageLine } = await harness()
    const claude = providerUsageLine('claude', JSON.stringify({
      type: 'result',
      num_turns: 9,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40
      }
    }))
    const codex = providerUsageLine('codex', JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 3 }
    }))

    expect(claude).toMatchObject({ processedInputTokens: 60, outputTokens: 40, calls: 1 })
    expect(codex).toMatchObject({ processedInputTokens: 10, outputTokens: 4, calls: 1 })
  })

  it('labels provider-observed runtime evidence separately from the requested alias', async () => {
    const { providerRuntimeLine } = await harness()

    expect(providerRuntimeLine('claude', JSON.stringify({
      type: 'system', subtype: 'init', model: 'claude-sonnet-5-20260701'
    }))).toEqual({ model: 'claude-sonnet-5-20260701', evidence: 'provider-stream-init' })
    expect(providerRuntimeLine('codex', JSON.stringify({
      type: 'thread.started', model: 'gpt-5.6-terra'
    }))).toEqual({ model: 'gpt-5.6-terra', evidence: 'provider-stream-init' })
    expect(providerRuntimeLine('claude', JSON.stringify({ type: 'assistant', model: 'untrusted-nested-value' }))).toBeUndefined()
  })

  it('treats an absent package manifest as dependency-free instead of a failed dependency check', async () => {
    const { inspectArtifact, loadManifest } = await harness()
    const manifest = await loadManifest()
    const workspace = resolve('benchmark-results', 'matrix-static-no-package')
    await rm(workspace, { recursive: true, force: true })
    await mkdir(workspace, { recursive: true })
    try {
      const hooks = manifest.judge.stableHooks
        .filter((id) => id !== 'ranking-item')
        .map((id) => `<div data-testid="${id}"></div>`)
        .join('')
      await Promise.all(manifest.judge.requiredFiles.map((name) => writeFile(
        resolve(workspace, name),
        name === 'index.html'
          ? hooks
          : name === 'app.js' ? "row.dataset.testid = 'ranking-item'\n" : 'export const fixed = true\n',
        'utf8'
      )))

      const result = await inspectArtifact(workspace, undefined, manifest.judge)
      expect(result.gates.dependencyFree).toBe(true)
      expect(result.verdict).toBe('pass')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
