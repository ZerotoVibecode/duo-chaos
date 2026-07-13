import { describe, expect, it, vi } from 'vitest'
import { ArtifactPreviewCache } from '../../src/main/preview/artifact-preview-cache'
import type { ArtifactPreviewResult } from '../../src/shared/types'

const ready = (id: string): ArtifactPreviewResult => ({
  status: 'ready',
  imageDataUrl: `data:image/png;base64,${id}`,
  width: 1280,
  height: 720,
  capturedAt: '2026-07-11T12:00:00.000Z'
})

describe('artifact preview cache', () => {
  it('retries unavailable or failed captures instead of caching them forever', async () => {
    const cache = new ArtifactPreviewCache(2)
    const factory = vi.fn<() => Promise<ArtifactPreviewResult>>()
      .mockResolvedValueOnce({ status: 'failed', reason: 'capture-failed', message: 'Transient capture failure.' })
      .mockResolvedValueOnce(ready('recovered'))

    await expect(cache.getOrCreate('run-a', factory)).resolves.toMatchObject({ status: 'failed' })
    await expect(cache.getOrCreate('run-a', factory)).resolves.toMatchObject({ status: 'ready' })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('bounds successful preview pixels and evicts the oldest run', async () => {
    const cache = new ArtifactPreviewCache(2)
    const first = vi.fn().mockResolvedValue(ready('first'))
    await cache.getOrCreate('run-a', first)
    await cache.getOrCreate('run-b', () => Promise.resolve(ready('second')))
    await cache.getOrCreate('run-c', () => Promise.resolve(ready('third')))
    await cache.getOrCreate('run-a', first)

    expect(first).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(2)
  })
})
