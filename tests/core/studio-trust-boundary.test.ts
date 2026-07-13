import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertTrustedStudioSender,
  isTrustedStudioNavigation
} from '../../src/main/security/studio-trust-boundary'

describe('Studio renderer trust boundary', () => {
  const rendererFilePath = resolve('test-fixtures', 'Duo Chaos', 'out', 'renderer', 'index.html')

  it('accepts only the exact production renderer file', () => {
    const policy = { rendererFilePath }
    const rendererUrl = pathToFileURL(rendererFilePath)
    const hashedRendererUrl = new URL(rendererUrl)
    hashedRendererUrl.hash = 'reveal'
    const siblingUrl = pathToFileURL(join(dirname(rendererFilePath), 'other.html'))
    const foreignUrl = pathToFileURL(resolve('test-fixtures', 'foreign', 'other.html'))

    expect(isTrustedStudioNavigation(rendererUrl.toString(), policy)).toBe(true)
    expect(isTrustedStudioNavigation(hashedRendererUrl.toString(), policy)).toBe(true)
    expect(isTrustedStudioNavigation(siblingUrl.toString(), policy)).toBe(false)
    expect(isTrustedStudioNavigation(foreignUrl.toString(), policy)).toBe(false)
  })

  it('accepts an exact development origin and rejects localhost prefix tricks', () => {
    const policy = { rendererFilePath, developmentUrl: 'http://localhost:5173/' }
    expect(isTrustedStudioNavigation('http://localhost:5173/settings', policy)).toBe(true)
    expect(isTrustedStudioNavigation('http://localhost:5174/', policy)).toBe(false)
    expect(isTrustedStudioNavigation('http://localhost.evil.example/', policy)).toBe(false)
    expect(isTrustedStudioNavigation('http://localhost:5173@evil.example/', policy)).toBe(false)
    expect(isTrustedStudioNavigation('https://localhost:5173/', policy)).toBe(false)
  })

  it('accepts only the trusted Studio main frame as an IPC sender', () => {
    const mainFrame = { id: 'main-frame' }
    const webContents = { mainFrame }
    const window = { webContents }

    expect(() => assertTrustedStudioSender({ sender: webContents, senderFrame: mainFrame }, window)).not.toThrow()
    expect(() => assertTrustedStudioSender({ sender: webContents, senderFrame: { id: 'subframe' } }, window)).toThrow(/trusted studio/i)
    expect(() => assertTrustedStudioSender({ sender: { mainFrame }, senderFrame: mainFrame }, window)).toThrow(/trusted studio/i)
    expect(() => assertTrustedStudioSender({ sender: webContents, senderFrame: mainFrame }, null)).toThrow(/trusted studio/i)
  })
})
