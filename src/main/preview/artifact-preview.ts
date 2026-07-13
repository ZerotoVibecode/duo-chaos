import type { ArtifactPreviewResult } from '@shared/types'
import { prepareArtifactPreviewTarget, type ReadyArtifactPreviewTarget } from './artifact-preview-target'

export interface ArtifactPixelCaptureResult {
  imageDataUrl: string
  width: number
  height: number
  capturedAt: string
}

export type ArtifactPixelCapture = (target: ReadyArtifactPreviewTarget) => Promise<ArtifactPixelCaptureResult>

export interface CreateArtifactPreviewInput {
  workspacePath: string
  configuredTarget: string
}

export async function createArtifactPreview(
  input: CreateArtifactPreviewInput,
  capture: ArtifactPixelCapture
): Promise<ArtifactPreviewResult> {
  let target
  try {
    target = await prepareArtifactPreviewTarget(input.workspacePath, input.configuredTarget)
  } catch {
    return {
      status: 'failed',
      reason: 'unsafe-artifact',
      message: 'The generated artifact did not resolve to a safe workspace target.'
    }
  }
  if (target.status === 'unavailable') return target

  try {
    return { status: 'ready', ...await capture(target) }
  } catch {
    return {
      status: 'failed',
      reason: 'capture-failed',
      message: 'The generated artifact could not be rendered safely.'
    }
  }
}
