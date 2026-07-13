import type { ArtifactPreviewResult } from '@shared/types'

type PreviewFactory = () => Promise<ArtifactPreviewResult>

/** Keeps a small LRU of successful screenshots while allowing failed captures to be retried. */
export class ArtifactPreviewCache {
  private readonly entries = new Map<string, Promise<ArtifactPreviewResult>>()

  constructor(private readonly maxEntries = 4) {}

  get size(): number {
    return this.entries.size
  }

  async getOrCreate(runId: string, factory: PreviewFactory): Promise<ArtifactPreviewResult> {
    const existing = this.entries.get(runId)
    if (existing) {
      this.entries.delete(runId)
      this.entries.set(runId, existing)
      return await existing
    }

    const pending = factory()
    this.entries.set(runId, pending)
    try {
      const result = await pending
      if (result.status !== 'ready') {
        if (this.entries.get(runId) === pending) this.entries.delete(runId)
        return result
      }

      if (this.entries.get(runId) === pending) {
        this.entries.delete(runId)
        this.entries.set(runId, pending)
        while (this.entries.size > Math.max(1, this.maxEntries)) {
          const oldest = this.entries.keys().next().value
          if (!oldest) break
          this.entries.delete(oldest)
        }
      }
      return result
    } catch (error) {
      if (this.entries.get(runId) === pending) this.entries.delete(runId)
      throw error
    }
  }
}
