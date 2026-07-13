import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitManager } from '../../src/main/git/git-manager'
import * as workspaceModule from '../../src/main/workspace/workspace-manager'
import type { RunSnapshot } from '../../src/shared/types'

const execFileAsync = promisify(execFile)

function repositoryPath(metadataRoot: string, workspacePath: string): string {
  const key = createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 24)
  return join(metadataRoot, `${key}.git`)
}

async function supervisorGit(metadataRoot: string, workspacePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('git', [
    `--git-dir=${repositoryPath(metadataRoot, workspacePath)}`,
    `--work-tree=${workspacePath}`,
    ...args
  ], { cwd: workspacePath })
}

describe('generated workspace hygiene and recovery contracts', () => {
  it('creates ignore rules for every secret-bearing coordination and supervisor path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-ignore-contract-'))
    const workspace = await workspaceModule.createRunWorkspace({
      root,
      runId: 'duo-run-ignore-contract',
      prompt: 'Build something private.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })

    const ignore = await readFile(join(workspace.workspacePath, '.gitignore'), 'utf8')
    expect(ignore).toContain('.duo/')
  })

  it('checkpoints app work without committing changing telemetry files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-checkpoint-contract-'))
    const workspace = await workspaceModule.createRunWorkspace({
      root,
      runId: 'duo-run-checkpoint-contract',
      prompt: 'Build something private.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    const metadataRoot = await mkdtemp(join(tmpdir(), 'duo-checkpoint-contract-meta-'))
    const git = new GitManager('git', metadataRoot)
    expect((await git.initialize(workspace.workspacePath)).ok).toBe(true)
    expect((await git.checkpoint(workspace.workspacePath, 'initial generated workspace')).ok).toBe(true)

    await writeFile(join(workspace.appPath, 'index.html'), '<!doctype html><title>App</title>\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'private', 'transcript.jsonl'), '{"private":"large transcript"}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'private', 'raw', 'claude.jsonl'), '{"raw":"large stream"}\n', 'utf8')
    await writeFile(join(workspace.duoPath, 'public', 'timeline.jsonl'), '{"public":"rolling feed"}\n', 'utf8')
    expect((await git.checkpoint(workspace.workspacePath, 'app source checkpoint')).ok).toBe(true)

    const { stdout } = await supervisorGit(metadataRoot, workspace.workspacePath, ['show', '--name-only', '--format=', 'HEAD'])
    const committed = stdout.split(/\r?\n/).map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean)
    expect(committed).toContain('app/index.html')
    expect(committed).not.toContain('.duo/private/transcript.jsonl')
    expect(committed).not.toContain('.duo/private/raw/claude.jsonl')
    expect(committed).not.toContain('.duo/public/timeline.jsonl')
  })

  it('recovers recent runs after restart without loading sealed text into unrevealed summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-recovery-contract-'))
    const workspace = await workspaceModule.createRunWorkspace({
      root,
      runId: 'duo-run-stale-private',
      prompt: 'A private human request that may be restored only when selected.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield'
    })
    await writeFile(
      join(workspace.duoPath, 'run.json'),
      `${JSON.stringify({
        runId: 'duo-run-stale-private',
        createdAt: '2026-07-10T09:00:00.000Z',
        updatedAt: '2026-07-10T09:10:00.000Z',
        status: 'running',
        phase: 'round.code',
        prompt: 'A private human request that may be restored only when selected.',
        executionMode: 'chaos',
        visibilityMode: 'spoiler-shield',
        round: 7,
        totalTurns: 12,
        workspacePath: workspace.workspacePath,
        appPath: workspace.appPath
      }, null, 2)}\n`,
      'utf8'
    )
    await writeFile(join(workspace.duoPath, 'private', 'sealed_idea.md'), 'SEALED_PRIVATE_NOUN_MUST_NOT_LEAK\n', 'utf8')

    const recoverRecentRuns = (
      workspaceModule as typeof workspaceModule & {
        recoverRecentRuns?: (workspaceRoot: string, limit?: number) => Promise<RunSnapshot[]>
      }
    ).recoverRecentRuns
    expect(typeof recoverRecentRuns).toBe('function')
    if (!recoverRecentRuns) return

    const recovered = await recoverRecentRuns(root, 8)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.runId).toBe('duo-run-stale-private')
    expect(['failed', 'cancelled']).toContain(recovered[0]?.status)
    expect(JSON.stringify(recovered)).not.toContain('SEALED_PRIVATE_NOUN_MUST_NOT_LEAK')
    expect(recovered[0]?.revealPacket).toBeUndefined()
  })
})
