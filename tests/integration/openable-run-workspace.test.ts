import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { resolveOpenableRunWorkspace } from '../../src/main/history/openable-run-workspace'
import type { RunSnapshot } from '../../src/shared/types'

function liveSnapshot(root: string, status: RunSnapshot['status']): RunSnapshot {
  return {
    runId: 'duo-run-live',
    prompt: 'Build something useful.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: status === 'reveal-ready' ? 'reveal.ready' : 'round.code',
    status,
    round: 8,
    totalTurns: 8,
    startedAt: '2026-07-12T01:00:00.000Z',
    workspacePath: join(root, 'duo-run-live'),
    appPath: join(root, 'duo-run-live', 'app'),
    tasks: [],
    events: []
  }
}

describe('openable run workspace', () => {
  it('allows paused recovery and revealed workspaces but keeps sealed reveal-ready work private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-open-live-'))
    await expect(resolveOpenableRunWorkspace({
      runId: 'duo-run-live',
      snapshot: liveSnapshot(root, 'paused'),
      workspaceRoot: root
    })).resolves.toBe(join(root, 'duo-run-live'))
    await expect(resolveOpenableRunWorkspace({
      runId: 'duo-run-live',
      snapshot: liveSnapshot(root, 'reveal-ready'),
      workspaceRoot: root
    })).resolves.toBeUndefined()
  })

  it('recovers a validated completed workspace from persisted history after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-open-history-'))
    const runId = 'duo-run-archive'
    const workspacePath = join(root, runId)
    await mkdir(join(workspacePath, '.duo', 'public'), { recursive: true })
    await writeFile(join(workspacePath, '.duo', 'run.json'), `${JSON.stringify({
      runId,
      createdAt: '2026-07-12T01:00:00.000Z',
      updatedAt: '2026-07-12T02:00:00.000Z',
      status: 'complete',
      phase: 'complete',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      prompt: 'A completed archived run.'
    })}\n`, 'utf8')
    await writeFile(join(workspacePath, '.duo', 'public', 'timeline.jsonl'), '', 'utf8')

    await expect(resolveOpenableRunWorkspace({ runId, workspaceRoot: root }))
      .resolves.toBe(workspacePath)
    await writeFile(join(workspacePath, '.duo', 'run.json'), `${JSON.stringify({
      runId,
      createdAt: '2026-07-12T01:00:00.000Z',
      status: 'reveal-ready',
      phase: 'reveal.ready',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      prompt: 'Still sealed.'
    })}\n`, 'utf8')
    await expect(resolveOpenableRunWorkspace({ runId, workspaceRoot: root }))
      .resolves.toBeUndefined()
    await expect(resolveOpenableRunWorkspace({ runId: 'duo-run-missing', workspaceRoot: root }))
      .resolves.toBeUndefined()
  })
})
