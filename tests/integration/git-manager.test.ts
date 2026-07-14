import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitManager } from '../../src/main/git/git-manager'
import { createRunWorkspace } from '../../src/main/workspace/workspace-manager'

const execFileAsync = promisify(execFile)

function repositoryPath(metadataRoot: string, workspacePath: string): string {
  const key = createHash('sha256').update(workspacePath).digest('hex').slice(0, 24)
  return join(metadataRoot, `${key}.git`)
}

async function supervisorGit(metadataRoot: string, workspacePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('git', [
    `--git-dir=${repositoryPath(metadataRoot, workspacePath)}`,
    `--work-tree=${workspacePath}`,
    ...args
  ], { cwd: workspacePath })
}

async function plantEmbeddedGit(workspacePath: string): Promise<void> {
  await execFileAsync('git', ['init', '.'], { cwd: workspacePath })
  await writeFile(join(workspacePath, '.git', 'hooks', 'pre-commit'), 'agent-owned hook\n', 'utf8')
}

describe('git checkpoints', () => {
  it('initializes a generated workspace and records a local checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-test-'))
    const git = new GitManager('git')
    const initialized = await git.initialize(root)
    expect(initialized.ok).toBe(true)
    await writeFile(join(root, 'proof.txt'), 'checkpoint proof\n', 'utf8')
    const checkpoint = await git.checkpoint(root, 'chore(duo): checkpoint proof')
    expect(checkpoint.ok).toBe(true)
    expect(checkpoint.commit).toMatch(/^[a-f0-9]{7,40}$/)
    await expect(git.checkpoint(root, 'chore(duo): no changes')).resolves.toMatchObject({ ok: true, detail: 'No changes to checkpoint.' })
  })

  it('reopens the authoritative supervisor repository after an agent plants embedded Git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-planted-metadata-'))
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-git-authoritative-meta-'))
    const first = new GitManager('git', metadataRoot)
    expect((await first.initialize(root)).ok).toBe(true)
    await writeFile(join(root, 'proof.txt'), 'authoritative checkpoint\n', 'utf8')
    expect((await first.checkpoint(root, 'chore(duo): authoritative checkpoint')).ok).toBe(true)

    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    await writeFile(join(root, '.git', 'config'), '[core]\n\tbare = false\n', 'utf8')
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), 'provider planted metadata\n', 'utf8')

    const reopened = new GitManager('git', metadataRoot)
    await expect(reopened.initialize(root)).resolves.toMatchObject({ ok: true })
    await expect(stat(join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(reopened.appStateFingerprint(root)).resolves.toMatch(/^sha256:/u)
  })

  it('scrubs agent-created Git metadata before checkpointing an initialized workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-late-shadow-checkpoint-'))
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-git-late-shadow-meta-'))
    const git = new GitManager('git', metadataRoot)
    expect((await git.initialize(root)).ok).toBe(true)

    await plantEmbeddedGit(root)
    await writeFile(join(root, 'proof.txt'), 'supervisor-owned checkpoint\n', 'utf8')

    expect((await git.checkpoint(root, 'chore(duo): shadow-safe checkpoint')).ok).toBe(true)
    await expect(stat(join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    const tree = await supervisorGit(metadataRoot, root, ['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(tree.stdout).toContain('proof.txt')
    expect(tree.stdout).not.toMatch(/(^|\r?\n)\.git(?:\/|$)/u)
  })

  it('scrubs agent-created Git metadata before calculating an app fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-late-shadow-fingerprint-'))
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-late-shadow-fingerprint',
      prompt: 'Build privately.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-git-late-shadow-fingerprint-meta-'))
    const git = new GitManager('git', metadataRoot)
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    await writeFile(join(workspace.appPath, 'index.html'), '<!doctype html><title>Shadow safe</title>', 'utf8')

    await plantEmbeddedGit(workspace.workspacePath)

    await expect(git.appStateFingerprint(workspace.workspacePath)).resolves.toMatch(/^sha256:/u)
    await expect(stat(join(workspace.workspacePath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns a useful failure when Git is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-missing-'))
    const git = new GitManager('definitely-missing-git')
    await expect(git.initialize(root)).resolves.toMatchObject({ ok: false })
  })

  it('summarizes only bounded app changes for supervisor contribution receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-receipt-'))
    const git = new GitManager('git')
    expect((await git.initialize(root)).ok).toBe(true)
    await mkdir(join(root, 'app', 'src'), { recursive: true })
    await writeFile(join(root, 'app', 'src', 'first.ts'), 'export const first = 1\n', 'utf8')
    await writeFile(join(root, 'outside.txt'), 'not app evidence\n', 'utf8')

    const summary = await git.summarizeAppChanges(root)

    expect(summary.changed).toBe(true)
    expect(summary.files).toEqual(['app/src/first.ts'])
    expect(summary.files).not.toContain('outside.txt')
    expect(summary.fileCount).toBe(1)
    expect(summary.insertions).toBeGreaterThanOrEqual(1)
    expect(summary.truncated).toBe(false)
  })

  it('never checkpoints raw telemetry or transient prompt files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-telemetry-'))
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-git-ignore',
      prompt: 'Build privately.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-git-telemetry-meta-'))
    const git = new GitManager('git', metadataRoot)
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    await writeFile(join(workspace.duoPath, 'private', 'raw', 'claude.jsonl'), '{"secret":"raw"}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'private', 'transcript.jsonl'), '{"secret":"transcript"}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'public', 'timeline.jsonl'), '{"type":"signal"}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'prompts', 'current_claude_prompt.md'), 'transient prompt', 'utf8')
    await writeFile(join(workspace.appPath, 'proof.txt'), 'tracked app output\n', 'utf8')
    expect((await git.checkpoint(workspace.workspacePath, 'chore(duo): privacy checkpoint')).ok).toBe(true)

    const { stdout } = await supervisorGit(metadataRoot, workspace.workspacePath, ['ls-files'])
    expect(stdout).toContain('app/proof.txt')
    expect(stdout).not.toMatch(/private\/raw|private\/transcript|public\/timeline|prompts\/current/)
  })

  it('keeps every sealed and private coordination file out of the repository and its history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-secret-history-'))
    const uniqueSecret = 'SERIOUS_BRIEF_SECRET_7ef1f5c5'
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-secret-history',
      prompt: `Build the requested product with ${uniqueSecret}.`,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      missionProfile: 'serious'
    })
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-git-secret-meta-'))
    const git = new GitManager('git', metadataRoot)
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    await writeFile(join(workspace.duoPath, 'private', 'dispatches.jsonl'), `${uniqueSecret}\n`, 'utf8')
    await writeFile(join(workspace.duoPath, 'board.json'), JSON.stringify({ tasks: [{ privateTitle: uniqueSecret, privateDescription: uniqueSecret }] }), 'utf8')
    await writeFile(join(workspace.duoPath, 'claims.json'), JSON.stringify({ claims: [{ privateClaim: uniqueSecret }] }), 'utf8')
    await writeFile(join(workspace.duoPath, 'locks.json'), JSON.stringify({ locks: [{ privatePath: uniqueSecret }] }), 'utf8')
    await writeFile(join(workspace.duoPath, 'reveal_packet.json'), JSON.stringify({ privateIdea: uniqueSecret }), 'utf8')
    await writeFile(join(workspace.duoPath, 'public', 'build.jsonl'), '{"publicText":"Safe checkpoint evidence."}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'public', 'debug.json'), JSON.stringify({ privateText: uniqueSecret }), 'utf8')
    await writeFile(join(workspace.appPath, 'proof.txt'), 'tracked app output\n', 'utf8')

    // A provider may try to force-stage every coordination file. The supervisor checkpoint
    // must still retain only spoiler-safe public protocol evidence before writing a commit.
    await supervisorGit(metadataRoot, workspace.workspacePath, [
      'add', '-f', '--', '.duo', '.agents', '.claude', 'AGENTS.md', 'CLAUDE.md'
    ])
    expect((await git.checkpoint(workspace.workspacePath, 'chore(duo): privacy boundary')).ok).toBe(true)

    const tree = await supervisorGit(metadataRoot, workspace.workspacePath, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const history = await supervisorGit(metadataRoot, workspace.workspacePath, ['log', '--all', '-p', '--format=fuller'])
    expect(tree.stdout).toContain('app/proof.txt')
    const trackedDuoFiles = tree.stdout
      .split(/\r?\n/u)
      .map((path) => path.trim().replaceAll('\\', '/'))
      .filter((path) => path.startsWith('.duo/'))
    expect(trackedDuoFiles).toEqual([])
    expect(tree.stdout).not.toMatch(/(?:^|\n)(?:\.agents|\.claude)\//u)
    expect(tree.stdout).not.toMatch(/(?:^|\n)(?:AGENTS|CLAUDE)\.md(?:\n|$)/u)
    expect(history.stdout).not.toContain(uniqueSecret)
  })

  it('never executes provider-planted Git hooks while creating a supervisor checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-hooks-'))
    const git = new GitManager('git')
    expect((await git.initialize(root)).ok).toBe(true)
    const sentinel = join(root, 'hook-ran.txt')
    const hooks = join(root, '.git', 'hooks')
    await mkdir(hooks, { recursive: true })
    for (const hook of ['pre-commit', 'post-commit']) {
      const path = join(hooks, hook)
      await writeFile(path, `#!/bin/sh\nprintf compromised > "${sentinel.replaceAll('\\', '/')}"\n`, 'utf8')
      await chmod(path, 0o755)
    }
    await writeFile(join(root, 'proof.txt'), 'safe checkpoint\n', 'utf8')

    expect((await git.checkpoint(root, 'chore(duo): hook-safe checkpoint')).ok).toBe(true)
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('distinguishes durable generated app work from coordination-only changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-durable-'))
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-git-durable',
      prompt: 'Build privately.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const git = new GitManager('git')
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    expect((await git.checkpoint(workspace.workspacePath, 'chore(duo): baseline')).ok).toBe(true)

    await writeFile(join(workspace.duoPath, 'board.json'), '{"tasks":[]}\n', 'utf8')
    await expect(git.hasDurableAppChanges(workspace.workspacePath)).resolves.toBe(false)

    await writeFile(join(workspace.appPath, 'index.html'), '<!doctype html><title>Durable</title>', 'utf8')
    await expect(git.hasDurableAppChanges(workspace.workspacePath)).resolves.toBe(true)
  })

  it('captures a per-stage app fingerprint and ignores coordination-only writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-fingerprint-'))
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-git-fingerprint',
      prompt: 'Build privately.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const git = new GitManager('git')
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    expect((await git.checkpoint(workspace.workspacePath, 'chore(duo): baseline')).ok).toBe(true)

    const baseline = await git.appStateFingerprint(workspace.workspacePath)
    await writeFile(join(workspace.duoPath, 'board.json'), '{"tasks":[]}\n', 'utf8')
    await expect(git.appStateFingerprint(workspace.workspacePath)).resolves.toBe(baseline)

    await writeFile(join(workspace.appPath, 'index.html'), '<!doctype html><title>Delta</title>', 'utf8')
    const firstDirtyFingerprint = await git.appStateFingerprint(workspace.workspacePath)
    expect(firstDirtyFingerprint).not.toBe(baseline)
    expect((await git.checkpoint(workspace.workspacePath, 'feat: seal exact app state')).ok).toBe(true)
    await expect(git.appStateFingerprint(workspace.workspacePath)).resolves.toBe(firstDirtyFingerprint)

    await writeFile(join(workspace.appPath, 'index.html'), '<!doctype html><title>Different delta</title>', 'utf8')
    await expect(git.appStateFingerprint(workspace.workspacePath)).resolves.not.toBe(firstDirtyFingerprint)
  })

  it('fingerprints a large binary without buffering a binary patch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-git-large-fingerprint-'))
    const workspace = await createRunWorkspace({
      root,
      runId: 'duo-run-git-large-fingerprint',
      prompt: 'Build privately.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const git = new GitManager('git')
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    await writeFile(join(workspace.appPath, 'large.bin'), Buffer.alloc(12 * 1024 * 1024, 0xa5))

    const fingerprint = await git.appStateFingerprint(workspace.workspacePath)
    expect(fingerprint).toMatch(/^sha256:/u)
  })
})
