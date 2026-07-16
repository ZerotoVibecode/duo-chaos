import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadArchivedCompleteRunSnapshot } from '../../src/main/history/run-history'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

describe('archived complete run snapshots', () => {
  it('reopens a completed run from supervisor history without exposing private protocol fields', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'duo-archived-complete-'))
    const changedDefaultRoot = await mkdtemp(join(tmpdir(), 'duo-archived-new-default-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-archived-runtime-'))
    const runId = 'duo-run-archive-complete'
    const workspacePath = join(workspaceRoot, runId)
    const duoPath = join(workspacePath, '.duo')
    const runtimePath = join(runtimeRoot, runId)
    await Promise.all([
      mkdir(join(workspacePath, 'app'), { recursive: true }),
      mkdir(join(duoPath, 'sealed'), { recursive: true }),
      mkdir(join(runtimePath, 'public'), { recursive: true })
    ])
    await writeFile(join(workspacePath, 'app', 'index.html'), '<h1>Archive</h1>', 'utf8')
    await writeJson(join(runtimePath, 'run.json'), {
      runId,
      createdAt: '2026-07-13T09:00:00.000Z',
      updatedAt: '2026-07-13T09:30:00.000Z',
      finishedAt: '2026-07-13T09:29:59.000Z',
      status: 'complete',
      phase: 'complete',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      missionProfile: 'surprise',
      prompt: 'Build a private surprise.',
      workspacePath,
      round: 7,
      totalTurns: 8,
      activeTimeMs: 1_234,
      providerRuntimes: {
        claude: {
          model: 'claude-opus-4-8',
          effort: 'high',
          source: 'claude-system-init',
          recordedAt: '2026-07-13T09:01:00.000Z'
        },
        codex: {
          source: 'codex-thread-started',
          recordedAt: '2026-07-13T09:01:05.000Z',
          message: { model: 'nested-must-not-load' }
        }
      },
      releaseStatus: 'ready'
    })
    await writeJson(join(duoPath, 'board.json'), {
      tasks: [{
        id: 'task-one',
        publicTitle: 'Finish the interaction',
        privateTitle: 'PRIVATE TASK TITLE',
        publicDescription: 'Recorded public work.',
        privateDescription: 'PRIVATE TASK DESCRIPTION',
        status: 'done',
        claimedBy: 'claude',
        risk: 'low',
        files: ['app/index.html'],
        privateFiles: ['secret.txt']
      }]
    })
    await writeJson(join(duoPath, 'sealed', 'reveal_packet.json'), {
      appName: 'Archive Atlas',
      idea: 'A revealed local artifact.',
      summary: 'The archived build is ready.',
      features: ['One finished interaction'],
      runCommand: 'Open app/index.html',
      appPath: 'app/index.html',
      status: 'ready',
      whatWorked: ['The artifact opens'],
      knownIssues: [],
      agentDramaSummary: ['Claude and Codex converged.'],
      gitCheckpoints: ['abc1234'],
      agentQuotes: { claude: 'Ready.', codex: 'Verified.' }
    })
    await writeFile(join(runtimePath, 'public', 'timeline.jsonl'), `${JSON.stringify({
      id: 'event-public',
      type: 'run.completed',
      runId,
      round: 7,
      timestamp: '2026-07-13T09:30:00.000Z',
      agent: 'director',
      publicText: 'Archive Atlas is revealed.',
      privateText: 'PRIVATE EVENT TEXT',
      privateTopic: 'PRIVATE EVENT TOPIC',
      spoilerRisk: 0,
      severity: 'high'
    })}\n`, 'utf8')

    const snapshot = await loadArchivedCompleteRunSnapshot(changedDefaultRoot, runId, { runtimeRoot })

    expect(snapshot).toMatchObject({
      runId,
      status: 'complete',
      phase: 'complete',
      round: 7,
      totalTurns: 8,
      activeTimeMs: 1_234,
      providerRuntimes: {
        claude: {
          model: 'claude-opus-4-8',
          effort: 'high',
          source: 'claude-system-init'
        }
      },
      workspacePath,
      appPath: join(workspacePath, 'app'),
      releaseStatus: 'ready',
      revealPacket: { appName: 'Archive Atlas', appPath: 'app/index.html' }
    })
    expect(snapshot?.events).toHaveLength(1)
    expect(snapshot?.events[0]).not.toHaveProperty('privateText')
    expect(snapshot?.events[0]).not.toHaveProperty('privateTopic')
    expect(snapshot?.tasks).toEqual([expect.objectContaining({
      id: 'task-one',
      publicTitle: 'Finish the interaction'
    })])
    expect(snapshot?.tasks[0]).not.toHaveProperty('privateTitle')
    expect(snapshot?.tasks[0]).not.toHaveProperty('privateDescription')
    expect(snapshot?.tasks[0]).not.toHaveProperty('privateFiles')
  })

  it('rejects a supervisor record whose external workspace basename does not match its run id', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'duo-archive-root-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'duo-archive-outside-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'duo-archive-record-'))
    const runId = 'duo-run-outside-root'
    const workspacePath = join(outsideRoot, 'unrelated-directory')
    const runtimePath = join(runtimeRoot, runId)
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(join(runtimePath, 'public'), { recursive: true })
    ])
    await writeJson(join(runtimePath, 'run.json'), {
      runId,
      createdAt: '2026-07-13T09:00:00.000Z',
      status: 'complete',
      phase: 'complete',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      prompt: 'Do not trust this path.',
      workspacePath
    })
    await writeFile(join(runtimePath, 'public', 'timeline.jsonl'), '', 'utf8')

    await expect(loadArchivedCompleteRunSnapshot(workspaceRoot, runId, { runtimeRoot }))
      .resolves.toBeUndefined()
  })
})
