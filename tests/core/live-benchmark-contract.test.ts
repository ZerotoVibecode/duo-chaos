import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../src/shared/types'

const script = resolve('scripts', 'benchmark-live-duo.mjs')
const fixture = resolve('tests', 'fixtures', 'benchmarks', 'live', 'terra-low-sonnet-low.json')

interface LiveBenchmarkHarness {
  closeElectronApplication: (application: {
    close: () => Promise<void>
    process: () => unknown
  }, graceMs?: number, terminateTree?: (child: unknown) => Promise<void>) => Promise<void>
  judgeSnapshot: (snapshot: RunSnapshot, fixtureValue: unknown) => { judge: { verdict: string } }
  loadFixture: () => Promise<unknown>
  prepareLiveOutputDirectory: (id: string, archiveRoot?: string) => Promise<string>
  preserveLiveEvidence: (options: {
    outputDirectory: string
    userData: string
    workspaceRoot: string
    snapshot: { workspacePath?: string } | undefined
  }) => Promise<void>
  sanitizedElectronEnvironment: (overrides: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  terminateElectronProcessTree: (
    child: { pid: number; killed: boolean; exitCode: number | null; signalCode: string | null; kill: () => boolean },
    spawnProcess: (command: string, args: string[], options: { windowsHide: boolean; stdio: string }) => {
      once: (event: string, handler: (...args: unknown[]) => void) => unknown
      kill: () => boolean
    },
    helperTimeoutMs: number,
    platform: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>
  waitForTerminalSnapshot: (options: {
    timeoutMs: number
    pollMs?: number
    readSnapshot: () => Promise<RunSnapshot | undefined>
    stopRun: () => Promise<unknown>
  }) => Promise<{ snapshot: RunSnapshot | undefined; timedOut: boolean }>
}

async function harness(): Promise<LiveBenchmarkHarness> {
  return await import('../../scripts/benchmark-live-duo.mjs') as unknown as LiveBenchmarkHarness
}

function passingSnapshot(): RunSnapshot {
  return {
    runId: 'run-live-benchmark',
    status: 'complete',
    phase: 'complete',
    round: 7,
    prompt: 'Fixed public benchmark brief.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    startedAt: '2026-07-15T00:00:00.000Z',
    activeTimeMs: 100,
    workspacePath: 'C:\\isolated\\workspace',
    appPath: 'app/index.html',
    releaseStatus: 'ready',
    tasks: [
      { id: 'task-claude', publicTitle: 'Claude slice', status: 'done', risk: 'medium', files: [], claimedBy: 'claude' },
      { id: 'task-codex', publicTitle: 'Codex slice', status: 'done', risk: 'medium', files: [], claimedBy: 'codex' }
    ],
    events: [
      { id: 'claude-contribution', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:00.000Z', round: 5, type: 'decision', agent: 'director', publicText: 'Recorded.', spoilerRisk: 0, severity: 'low', proof: { kind: 'contribution', agent: 'claude', accepted: true } },
      { id: 'codex-contribution', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:01.000Z', round: 6, type: 'decision', agent: 'director', publicText: 'Recorded.', spoilerRisk: 0, severity: 'low', proof: { kind: 'contribution', agent: 'codex', accepted: true } },
      { id: 'claude-review', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:02.000Z', round: 7, type: 'decision', agent: 'director', publicText: 'Recorded.', spoilerRisk: 0, severity: 'low', proof: { kind: 'review', agent: 'claude', accepted: true } },
      { id: 'codex-review', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:03.000Z', round: 7, type: 'decision', agent: 'director', publicText: 'Recorded.', spoilerRisk: 0, severity: 'low', proof: { kind: 'review', agent: 'codex', accepted: true } },
      { id: 'claude-edit', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:04.000Z', round: 5, type: 'file.changed', agent: 'claude', publicText: 'Changed source.', spoilerRisk: 0, severity: 'low' },
      { id: 'codex-edit', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:05.000Z', round: 6, type: 'file.changed', agent: 'codex', publicText: 'Changed source.', spoilerRisk: 0, severity: 'low' },
      { id: 'verified', runId: 'run-live-benchmark', timestamp: '2026-07-15T00:00:06.000Z', round: 7, type: 'build.passed', agent: 'director', publicText: 'Verification passed.', spoilerRisk: 0, severity: 'low' }
    ]
  } as unknown as RunSnapshot
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

describe('opt-in live Duo benchmark contract', () => {
  it('is a deterministic dry-run by default and describes one exact condition', async () => {
    const result = await execute(['--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      benchmark: 'duo-live-exact-condition',
      mode: 'dry-run',
      providerCallsMade: 0,
      directApiCallsMade: 0,
      condition: {
        id: 'terra-low-sonnet-low-serious',
        executionMode: 'chaos',
        visibilityMode: 'spoiler-shield',
        missionProfile: 'serious',
        codex: { model: 'gpt-5.6-terra', effort: 'low' },
        claude: { model: 'sonnet', effort: 'low' }
      }
    })
    expect(result.stdout).not.toMatch(/generatedAt|timestamp|C:\\Users|workspacePath|prompt/iu)
  })

  it.each([
    ['live flag alone', ['--live']],
    ['quota acknowledgement alone', ['--i-understand-this-uses-local-cli-quota']]
  ])('refuses %s without launching Electron or a provider', async (_label, args) => {
    const result = await execute(args)

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/both.*--live.*--i-understand-this-uses-local-cli-quota/iu)
    expect(result.stderr).toMatch(/no provider/iu)
  })

  it('rejects overrides so a live sample remains one predeclared condition', async () => {
    const result = await execute(['--fixture', 'other.json'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/unknown argument/iu)
  })

  it('uses a data-only fixed fixture and a restricted supervisor-evidence judge', async () => {
    const [source, fixtureSource] = await Promise.all([
      readFile(script, 'utf8'),
      readFile(fixture, 'utf8')
    ])
    const value = JSON.parse(fixtureSource) as Record<string, unknown>

    expect(Object.keys(value).sort()).toEqual(['condition', 'id', 'judge', 'label', 'prompt', 'schemaVersion'])
    expect(fixtureSource).not.toMatch(/"(?:script|shell|command|javascript|module|url)"\s*:/iu)
    expect(source).toContain("saveRawLogs: false")
    expect(source).toContain("'benchmark-results'")
    expect(source).not.toMatch(/resolve\(REPOSITORY_ROOT,\s*['"]test-results['"]\)/u)
    expect(source).toContain('mkdtemp')
    expect(source).toContain('DUO_CHAOS_E2E_USER_DATA')
    expect(source).toContain('DUO_CHAOS_E2E_DEFAULT_WORKSPACE')
    expect(source).toContain("resolve(outputDirectory, 'preserved-workspace')")
    expect(source).toContain('preservedWorkspace: evidencePreserved')
    expect(source).toContain("failureReceipt(fixture, snapshot, 'evidence-preservation-failed')")
    expect(source).toContain('temporaryWorkspaceRoot: workspaceRoot')
    expect(source).toContain('temporaryUserDataRoot: userData')
    expect(source).toContain("status === 'paused'")
    expect(source).toContain("status === 'failed'")
    expect(source).toContain('runTimeoutSeconds * 1_000 + 120_000')
    expect(source).not.toMatch(/\.resumeRun\s*\(|retry|node:child_process|\bexec(?:File)?\s*\(|\bfetch\s*\(|new\s+Function|\beval\s*\(/u)
    expect(source).toContain("win32Path.join(windowsRoot, 'System32', 'taskkill.exe')")
    expect(source).toContain('spawnProcess(taskkillPath')
    expect(source).not.toMatch(/crossSpawn\(\s*['"]taskkill/iu)
    expect(source).not.toMatch(/crossSpawn\(\s*['"](?:codex|claude)['"]/iu)
  })

  it('requires a successful terminal status and an actual current supervisor verification event', async () => {
    const { judgeSnapshot, loadFixture } = await harness()
    const condition = await loadFixture()
    const complete = passingSnapshot()

    expect(judgeSnapshot(complete, condition).judge.verdict).toBe('pass')
    for (const status of ['paused', 'failed', 'cancelled'] as const) {
      expect(judgeSnapshot({ ...complete, status }, condition).judge.verdict).not.toBe('pass')
    }
    expect(judgeSnapshot({
      ...complete,
      events: complete.events.filter((event) => event.type !== 'build.passed')
    }, condition).judge.verdict).not.toBe('pass')
  })

  it('stops through an independent watchdog instead of waiting forever', async () => {
    const { waitForTerminalSnapshot } = await harness()
    let stopped = false
    const result = await waitForTerminalSnapshot({
      timeoutMs: 15,
      pollMs: 1,
      readSnapshot: () => Promise.resolve(undefined),
      stopRun: () => {
        stopped = true
        return Promise.resolve()
      }
    })

    expect(result).toEqual({ snapshot: undefined, timedOut: true })
    expect(stopped).toBe(true)
  })

  it('force-terminates the Electron process tree when graceful benchmark shutdown exceeds its deadline', async () => {
    const { closeElectronApplication } = await harness()
    let killed = false
    let resolveClose: (() => void) | undefined
    const closing = new Promise<void>((resolveClosing) => { resolveClose = resolveClosing })

    await closeElectronApplication({
      close: () => closing,
      process: () => ({ pid: 424_242 })
    }, 5, () => {
      killed = true
      resolveClose?.()
      return Promise.resolve()
    })

    expect(killed).toBe(true)
  })

  it('uses an absolute System32 taskkill and falls back when the helper never resolves', async () => {
    const { terminateElectronProcessTree } = await harness()
    let launchedCommand = ''
    let helperKilled = false
    let childKilled = false
    const helper = {
      once: () => helper,
      kill: () => {
        helperKilled = true
        return true
      }
    }

    await terminateElectronProcessTree({
      pid: 424_242,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => {
        childKilled = true
        return true
      }
    }, (command) => {
      launchedCommand = command
      return helper
    }, 5, 'win32', { SystemRoot: 'D:\\Windows' })

    expect(launchedCommand).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(helperKilled).toBe(true)
    expect(childKilled).toBe(true)
  })

  it('removes development renderer and Node injection variables case-insensitively from Electron launch', async () => {
    const { sanitizedElectronEnvironment } = await harness()
    const previous = {
      renderer: process.env.ELECTRON_RENDERER_URL,
      nodeOptions: process.env.NODE_OPTIONS,
      viteProbe: process.env.VITE_BENCHMARK_PROBE
    }
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173'
    process.env.NODE_OPTIONS = '--require unsafe-probe'
    process.env.VITE_BENCHMARK_PROBE = 'private'
    try {
      const environment = sanitizedElectronEnvironment({
        DUO_CHAOS_E2E: '1',
        electron_run_as_node: '1',
        Electron_Renderer_Url: 'http://attacker.invalid',
        Node_Options: '--require mixed-case-probe',
        vItE_mixed_case_probe: 'private'
      })
      expect(environment).not.toHaveProperty('ELECTRON_RENDERER_URL')
      expect(environment).not.toHaveProperty('NODE_OPTIONS')
      expect(environment).not.toHaveProperty('VITE_BENCHMARK_PROBE')
      expect(Object.keys(environment).map((key) => key.toUpperCase())).not.toEqual(expect.arrayContaining([
        'ELECTRON_RENDERER_URL',
        'ELECTRON_RUN_AS_NODE',
        'NODE_OPTIONS',
        'VITE_MIXED_CASE_PROBE'
      ]))
      expect(environment).toMatchObject({ DUO_CHAOS_E2E: '1' })
    } finally {
      if (previous.renderer === undefined) delete process.env.ELECTRON_RENDERER_URL
      else process.env.ELECTRON_RENDERER_URL = previous.renderer
      if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous.nodeOptions
      if (previous.viteProbe === undefined) delete process.env.VITE_BENCHMARK_PROBE
      else process.env.VITE_BENCHMARK_PROBE = previous.viteProbe
    }
  })

  it('rejects linked workspace roots before preserving live evidence', async () => {
    const { preserveLiveEvidence } = await harness()
    const sandbox = await mkdtemp(join(tmpdir(), 'duo-live-linked-root-'))
    const canonicalRoot = join(sandbox, 'canonical-workspace-root')
    const linkedRoot = join(sandbox, 'linked-workspace-root')
    const outputDirectory = join(sandbox, 'output')
    const userData = join(sandbox, 'user-data')
    await Promise.all([
      mkdir(canonicalRoot, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(join(userData, 'runs'), { recursive: true })
    ])
    await symlink(canonicalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await expect(preserveLiveEvidence({
        outputDirectory,
        userData,
        workspaceRoot: linkedRoot,
        snapshot: { workspacePath: linkedRoot }
      })).rejects.toThrow(/linked|noncanonical/iu)
      await expect(access(join(outputDirectory, 'preserved-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('rejects a benchmark archive reached through a linked ancestor', async () => {
    const { prepareLiveOutputDirectory, preserveLiveEvidence } = await harness()
    const sandbox = await mkdtemp(join(tmpdir(), 'duo-live-linked-archive-'))
    const workspaceRoot = join(sandbox, 'workspace-root')
    const sourceWorkspace = join(workspaceRoot, 'run-safe')
    const archiveTarget = join(sandbox, 'archive-target')
    const archiveLink = join(sandbox, 'archive-link')
    const outputDirectory = join(archiveLink, 'execution')
    const userData = join(sandbox, 'user-data')
    await Promise.all([
      mkdir(sourceWorkspace, { recursive: true }),
      mkdir(archiveTarget, { recursive: true }),
      mkdir(join(userData, 'runs'), { recursive: true })
    ])
    await symlink(archiveTarget, archiveLink, process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(outputDirectory, { recursive: true })

    try {
      await expect(prepareLiveOutputDirectory('new-execution', archiveLink))
        .rejects.toThrow(/(?:linked|noncanonical).*benchmark results root/iu)
      await expect(access(join(archiveTarget, 'live-duo', 'new-execution'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot: { workspacePath: sourceWorkspace } }))
        .rejects.toThrow(/noncanonical benchmark archive/iu)
      await expect(access(join(archiveTarget, 'execution', 'preserved-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('never copies or removes an external Git directory through a workspace junction', async () => {
    const { preserveLiveEvidence } = await harness()
    const sandbox = await mkdtemp(join(tmpdir(), 'duo-live-external-git-'))
    const workspaceRoot = join(sandbox, 'workspace-root')
    const sourceWorkspace = join(workspaceRoot, 'run-safe')
    const externalGit = join(sandbox, 'external-git')
    const marker = join(externalGit, 'keep.txt')
    const outputDirectory = join(sandbox, 'output')
    const userData = join(sandbox, 'user-data')
    await Promise.all([
      mkdir(sourceWorkspace, { recursive: true }),
      mkdir(externalGit, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(join(userData, 'runs'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(sourceWorkspace, 'artifact.txt'), 'workspace evidence', 'utf8'),
      writeFile(marker, 'must survive', 'utf8')
    ])
    await symlink(externalGit, join(sourceWorkspace, '.git'), process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await preserveLiveEvidence({ outputDirectory, userData, workspaceRoot, snapshot: { workspacePath: sourceWorkspace } })
      await expect(readFile(marker, 'utf8')).resolves.toBe('must survive')
      await expect(readFile(join(outputDirectory, 'preserved-workspace', 'artifact.txt'), 'utf8')).resolves.toBe('workspace evidence')
      await expect(access(join(outputDirectory, 'preserved-workspace', '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
