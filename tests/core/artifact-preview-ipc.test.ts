import { describe, expect, test } from 'vitest'
import { assertArtifactPreviewSender } from '@main/preview/artifact-preview-ipc'

describe('artifact preview IPC sender validation', () => {
  test('accepts only the Studio main frame', () => {
    const mainFrame = { id: 'main-frame' }
    const webContents = { mainFrame }
    const window = { webContents }

    expect(() => assertArtifactPreviewSender({ sender: webContents, senderFrame: mainFrame }, window)).not.toThrow()
  })

  test('rejects subframes, foreign web contents, and a missing Studio window', () => {
    const mainFrame = { id: 'main-frame' }
    const webContents = { mainFrame }
    const window = { webContents }

    expect(() => assertArtifactPreviewSender({ sender: webContents, senderFrame: { id: 'subframe' } }, window)).toThrow(/trusted studio/i)
    expect(() => assertArtifactPreviewSender({ sender: { mainFrame }, senderFrame: mainFrame }, window)).toThrow(/trusted studio/i)
    expect(() => assertArtifactPreviewSender({ sender: webContents, senderFrame: mainFrame }, null)).toThrow(/trusted studio/i)
  })
})
