interface PreviewIpcEventLike {
  sender: unknown
  senderFrame: unknown
}

interface StudioWindowLike {
  webContents: {
    mainFrame: unknown
  }
}

export function assertArtifactPreviewSender(
  event: PreviewIpcEventLike,
  studioWindow: StudioWindowLike | null
): void {
  if (
    !studioWindow ||
    event.sender !== studioWindow.webContents ||
    event.senderFrame !== studioWindow.webContents.mainFrame
  ) {
    throw new Error('Artifact preview requests must come from the trusted Studio main frame.')
  }
}
