import type { RunSnapshot } from '@shared/types'
import { scanRecentBuilds, type RecentBuildScanOptions } from './run-history'

const OPENABLE_LIVE_STATUSES = new Set<RunSnapshot['status']>([
  'complete',
  'paused'
])

interface OpenableRunWorkspaceInput {
  runId: string
  snapshot?: RunSnapshot
  workspaceRoot: string
  scanOptions?: RecentBuildScanOptions
}

/**
 * Resolves only supervisor-known live runs or validated archive records. The
 * renderer never gets to provide an arbitrary host path to Electron shell.
 */
export async function resolveOpenableRunWorkspace(
  input: OpenableRunWorkspaceInput
): Promise<string | undefined> {
  if (
    input.snapshot?.runId === input.runId &&
    OPENABLE_LIVE_STATUSES.has(input.snapshot.status)
  ) {
    return input.snapshot.workspacePath
  }
  if (input.snapshot) return undefined
  const archived = (await scanRecentBuilds(input.workspaceRoot, 50, input.scanOptions))
    .find((build) =>
      build.runId === input.runId && (build.status === 'complete' || build.status === 'paused')
    )
  return archived?.workspacePath
}
