import { stat } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { resolveGeneratedAppLaunchTarget } from '@main/generated-app-launch-target'

export interface ReadyArtifactPreviewTarget {
  status: 'ready'
  entryPath: string
  resourceRoot: string
}

export interface UnavailableArtifactPreviewTarget {
  status: 'unavailable'
  reason: 'no-built-artifact'
  message: string
}

export type ArtifactPreviewTarget = ReadyArtifactPreviewTarget | UnavailableArtifactPreviewTarget

const unavailable = (): UnavailableArtifactPreviewTarget => ({
  status: 'unavailable',
  reason: 'no-built-artifact',
  message: 'No built browser artifact is available for preview.'
})

export async function prepareArtifactPreviewTarget(
  workspacePath: string,
  configuredTarget: string
): Promise<ArtifactPreviewTarget> {
  let entryPath: string
  try {
    entryPath = await resolveGeneratedAppLaunchTarget(workspacePath, configuredTarget)
  } catch (error) {
    if (error instanceof Error && /no built html|run command/i.test(error.message)) return unavailable()
    throw error
  }

  try {
    const details = await stat(entryPath)
    if (!details.isFile() || !['.html', '.htm'].includes(extname(entryPath).toLowerCase())) return unavailable()
  } catch {
    return unavailable()
  }
  return { status: 'ready', entryPath, resourceRoot: dirname(entryPath) }
}
