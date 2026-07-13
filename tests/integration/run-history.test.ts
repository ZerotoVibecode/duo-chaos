import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanRecentBuilds } from '../../src/main/history/run-history'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function seedRun(
  root: string,
  runId: string,
  status: string,
  createdAt: string,
  options: { appName?: string; privateSecret?: string; releaseStatus?: 'ready' | 'partial' | 'failed' } = {}
): Promise<string> {
  const workspacePath = join(root, runId)
  const duoPath = join(workspacePath, '.duo')
  await mkdir(join(duoPath, 'public'), { recursive: true })
  await mkdir(join(duoPath, 'private'), { recursive: true })
  await mkdir(join(duoPath, 'sealed'), { recursive: true })
  await writeJson(join(duoPath, 'run.json'), {
    runId,
    createdAt,
    updatedAt: createdAt,
    status,
    phase: status === 'complete' ? 'complete' : 'round.code',
    prompt: `Original prompt for ${runId}`,
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    round: status === 'complete' ? 12 : 5,
    totalTurns: 12,
    ...(options.releaseStatus ? { releaseStatus: options.releaseStatus } : {}),
    workspacePath,
    appPath: join(workspacePath, 'app')
  })
  await writeJson(join(duoPath, 'board.json'), {
    tasks: [
      { id: 'one', publicTitle: 'First task', status: 'done', claimedBy: 'claude', risk: 'low', files: [] },
      { id: 'two', publicTitle: 'Second task', status: status === 'complete' ? 'done' : 'in-progress', claimedBy: 'codex', risk: 'medium', files: [] }
    ]
  })
  await writeFile(join(duoPath, 'public', 'timeline.jsonl'), [
    { id: 'turn-c', type: 'agent.started', agent: 'claude', category: 'status' },
    { id: 'turn-x', type: 'agent.started', agent: 'codex', category: 'status' },
    { id: 'edit-c', type: 'file.changed', agent: 'claude', category: 'file' },
    { id: 'message-c', type: 'agent.dispatch', agent: 'claude', category: 'message' },
    { id: 'message-x', type: 'opinion', agent: 'codex', category: 'message' },
    { id: 'verify', type: 'build.passed', agent: 'codex', category: 'command' },
    { id: 'checkpoint', type: 'git.checkpoint', agent: 'director', category: 'status' }
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  await writeJson(join(duoPath, 'sealed', 'reveal_packet.json'), {
    appName: options.appName ?? 'SECRET APP NAME',
    status: options.releaseStatus ?? 'ready'
  })
  await writeFile(join(duoPath, 'private', 'sealed_idea.md'), options.privateSecret ?? 'PRIVATE SECRET IDEA')
  return workspacePath
}

describe('run history scanner', () => {
  it('returns only public proof and unlocks an app name only after reveal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-'))
    await seedRun(root, 'duo-run-complete', 'complete', '2026-07-10T10:00:00.000Z', { appName: 'Public Launch' })
    await seedRun(root, 'duo-run-interrupted', 'running', '2026-07-10T11:00:00.000Z', {
      appName: 'DO NOT LEAK THIS',
      privateSecret: 'DO NOT LEAK PRIVATE IDEA'
    })

    const builds = await scanRecentBuilds(root)
    expect(builds.map((build) => build.runId)).toEqual(['duo-run-interrupted', 'duo-run-complete'])

    const complete = builds.find((build) => build.runId === 'duo-run-complete')
    expect(complete).toMatchObject({
      status: 'complete',
      appName: 'Public Launch',
      sealed: false,
      recoverable: false,
      proof: {
        tasksDone: 2,
        tasksTotal: 2,
        checkpoints: 1,
        buildPasses: 1,
        claude: { turns: 1, edits: 1, messages: 1, tasksDone: 1 },
        codex: { turns: 1, edits: 0, messages: 1, tasksDone: 1 }
      }
    })

    const interrupted = builds.find((build) => build.runId === 'duo-run-interrupted')
    expect(interrupted).toMatchObject({
      status: 'interrupted',
      sealed: true,
      recoverable: true,
      appName: undefined
    })
    expect(JSON.stringify(interrupted)).not.toContain('DO NOT LEAK')
  })

  it('ignores malformed folders without breaking the remaining history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-'))
    await seedRun(root, 'duo-run-valid', 'complete', '2026-07-10T10:00:00.000Z', { appName: 'Valid App' })
    await mkdir(join(root, 'duo-run-broken', '.duo'), { recursive: true })
    await writeFile(join(root, 'duo-run-broken', '.duo', 'run.json'), '{not-json')

    await expect(scanRecentBuilds(root)).resolves.toEqual([
      expect.objectContaining({ runId: 'duo-run-valid', appName: 'Valid App' })
    ])
  })

  it('keeps a durable paused battle sealed and recoverable without promising an unrestored resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-paused-'))
    await seedRun(root, 'duo-run-paused', 'paused', '2026-07-10T12:00:00.000Z', {
      appName: 'NEVER SHOW WHILE PAUSED'
    })

    const [paused] = await scanRecentBuilds(root)
    expect(paused).toMatchObject({
      runId: 'duo-run-paused',
      status: 'paused',
      sealed: true,
      recoverable: true,
      resumable: false,
      appName: undefined
    })
    expect(JSON.stringify(paused)).not.toContain('NEVER SHOW')
  })

  it('uses the latest typed verification outcome instead of preserving a stale pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-'))
    const workspace = await seedRun(root, 'duo-run-typed-verification', 'complete', '2026-07-10T10:00:00.000Z', { appName: 'Typed Proof' })
    await writeFile(join(workspace, '.duo', 'public', 'timeline.jsonl'), [
      { id: 'typed-pass', type: 'agent.activity', agent: 'claude', category: 'command', metadata: { verificationPassed: true } },
      { id: 'typed-failure', type: 'agent.activity', agent: 'codex', category: 'error', metadata: { verificationFailed: true } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')

    const [build] = await scanRecentBuilds(root)
    expect(build?.proof.buildPasses).toBe(0)
  })

  it('projects one verified pass from an authoritative ready runtime record without a public pass event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-ready-'))
    const workspace = await seedRun(root, 'duo-run-ready-without-public-pass', 'complete', '2026-07-10T10:00:00.000Z', {
      appName: 'Ready Artifact',
      releaseStatus: 'ready'
    })
    await writeFile(join(workspace, '.duo', 'public', 'timeline.jsonl'), '', 'utf8')

    const [build] = await scanRecentBuilds(root)
    expect(build).toMatchObject({ releaseStatus: 'ready', proof: { buildPasses: 1 } })
  })

  it('does not present a revealed partial result as a fully complete build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-partial-'))
    await seedRun(root, 'duo-run-partial', 'complete', '2026-07-10T10:00:00.000Z', {
      appName: 'Partial Artifact',
      releaseStatus: 'partial'
    })

    await expect(scanRecentBuilds(root)).resolves.toEqual([
      expect.objectContaining({ status: 'complete', releaseStatus: 'partial', appName: 'Partial Artifact' })
    ])
  })

  it('preserves the serious mission profile in supervisor-owned runtime history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-serious-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-history-serious-runtime-'))
    const runId = 'duo-run-serious-history'
    const workspacePath = join(root, runId)
    const runtimePath = join(runtimeRoot, runId)
    await mkdir(join(workspacePath, '.duo'), { recursive: true })
    await mkdir(join(runtimePath, 'public'), { recursive: true })
    await writeJson(join(runtimePath, 'run.json'), {
      runId,
      createdAt: '2026-07-12T01:00:00.000Z',
      status: 'paused',
      phase: 'paused',
      missionProfile: 'serious',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      prompt: 'A binding serious brief.',
      workspacePath
    })
    await writeFile(join(runtimePath, 'public', 'timeline.jsonl'), '', 'utf8')

    await expect(scanRecentBuilds(root, 8, { runtimeRoot })).resolves.toEqual([
      expect.objectContaining({ runId, missionProfile: 'serious' })
    ])
  })

  it('rejects an external runtime fallback whose workspace folder was replaced by a link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-history-link-root-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-history-link-runtime-'))
    const attacker = await mkdtemp(join(tmpdir(), 'duo-history-link-target-'))
    const runId = 'duo-run-linked-history'
    const runtimePath = join(runtimeRoot, runId)
    await mkdir(join(attacker, '.duo', 'sealed'), { recursive: true })
    await mkdir(join(runtimePath, 'public'), { recursive: true })
    await symlink(attacker, join(root, runId), process.platform === 'win32' ? 'junction' : 'dir')
    await writeJson(join(runtimePath, 'run.json'), {
      runId,
      createdAt: '2026-07-12T01:00:00.000Z',
      status: 'complete',
      phase: 'complete',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      prompt: 'Do not follow the swapped workspace.',
      workspacePath: join(root, runId)
    })
    await writeFile(join(runtimePath, 'public', 'timeline.jsonl'), '', 'utf8')

    await expect(scanRecentBuilds(root, 8, { runtimeRoot })).resolves.toEqual([])
  })
})
