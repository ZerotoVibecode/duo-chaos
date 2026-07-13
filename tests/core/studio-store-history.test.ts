import { afterEach, describe, expect, it } from 'vitest'
import { useStudioStore } from '../../src/renderer/src/store/studio-store'
import type { RunSnapshot } from '../../src/shared/types'

function completedRun(releaseStatus: NonNullable<RunSnapshot['releaseStatus']>): RunSnapshot {
  return {
    runId: 'duo-run-store-ready',
    prompt: 'Build a verified artifact.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield',
    phase: 'complete',
    status: 'complete',
    round: 8,
    startedAt: '2026-07-12T10:00:00.000Z',
    finishedAt: '2026-07-12T10:20:00.000Z',
    workspacePath: 'C:\\DuoChaos\\workspaces\\duo-run-store-ready',
    appPath: 'C:\\DuoChaos\\workspaces\\duo-run-store-ready\\app',
    tasks: [],
    events: [],
    releaseStatus
  }
}

describe('studio recent-build summaries', () => {
  afterEach(() => {
    useStudioStore.setState({ run: undefined, recentBuilds: [] })
  })

  it('retains authoritative ready verification when updating in-memory history', () => {
    useStudioStore.setState({ run: undefined, recentBuilds: [] })

    useStudioStore.getState().applySnapshot(completedRun('ready'))

    expect(useStudioStore.getState().recentBuilds[0]?.proof.buildPasses).toBe(1)
  })

  it('does not project verification into a non-ready in-memory history entry', () => {
    useStudioStore.setState({ run: undefined, recentBuilds: [] })

    useStudioStore.getState().applySnapshot(completedRun('partial'))

    expect(useStudioStore.getState().recentBuilds[0]?.proof.buildPasses).toBe(0)
  })
})
