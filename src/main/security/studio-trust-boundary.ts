import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface StudioIpcEventLike {
  sender: unknown
  senderFrame: unknown
}

interface StudioWindowLike {
  webContents: {
    mainFrame: unknown
  }
}

export interface StudioNavigationPolicy {
  rendererFilePath: string
  developmentUrl?: string
}

export function assertTrustedStudioSender(
  event: StudioIpcEventLike,
  studioWindow: StudioWindowLike | null
): void {
  if (
    !studioWindow ||
    event.sender !== studioWindow.webContents ||
    event.senderFrame !== studioWindow.webContents.mainFrame
  ) {
    throw new Error('This request must come from the trusted Studio main frame.')
  }
}

export function isTrustedStudioNavigation(value: string, policy: StudioNavigationPolicy): boolean {
  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    return false
  }

  if (policy.developmentUrl) {
    try {
      const expected = new URL(policy.developmentUrl)
      return (expected.protocol === 'http:' || expected.protocol === 'https:') &&
        candidate.origin === expected.origin
    } catch {
      return false
    }
  }

  const expected = new URL(pathToFileURL(resolve(policy.rendererFilePath)).toString())
  if (candidate.protocol !== 'file:') return false
  candidate.hash = ''
  candidate.search = ''
  expected.hash = ''
  expected.search = ''
  return candidate.toString() === expected.toString()
}
