import { describe, expect, test } from 'vitest'
import { IPC } from '@shared/electron-api'

describe('artifact preview IPC contract', () => {
  test('uses a dedicated invoke channel rather than exposing generated content events', () => {
    expect(IPC.runArtifactPreview).toBe('run:artifact-preview')
  })
})
