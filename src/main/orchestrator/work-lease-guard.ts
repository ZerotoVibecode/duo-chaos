import { createHash } from 'node:crypto'
import type { ProviderRecord } from '@main/process/provider-envelope'

interface LeaseSnapshot {
  inferenceSteps: number
  durableToolBoundary: boolean
  shouldTimebox: boolean
}

interface LeaseGuardOptions {
  initialInferenceSteps?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function contentOf(providerRecord: ProviderRecord): Record<string, unknown>[] {
  const message = record(providerRecord.message)
  return Array.isArray(message?.content)
    ? message.content.map(record).filter((value): value is Record<string, unknown> => value !== undefined)
    : []
}

/** Counts provider inference messages, not streamed chunks or tool calls. */
export class ClaudeWorkLeaseGuard {
  private readonly messageIds = new Set<string>()
  private readonly anonymousMessageFingerprints = new Set<string>()
  private readonly pendingTools = new Set<string>()
  private readonly durableTools = new Set<string>()
  private anonymousMessages = 0
  private readonly initialInferenceSteps: number
  private durableBoundary = false
  private requested = false

  constructor(private readonly maximumInferenceSteps: number, options: LeaseGuardOptions = {}) {
    if (!Number.isInteger(maximumInferenceSteps) || maximumInferenceSteps < 1) {
      throw new Error('Claude work inference limit must be a positive integer.')
    }
    const initialInferenceSteps = options.initialInferenceSteps ?? 0
    if (!Number.isInteger(initialInferenceSteps) || initialInferenceSteps < 0) {
      throw new Error('Initial Claude inference steps must be a non-negative integer.')
    }
    this.initialInferenceSteps = initialInferenceSteps
  }

  observe(records: readonly ProviderRecord[]): LeaseSnapshot {
    for (const providerRecord of records) {
      if (providerRecord.type === 'assistant') {
        const message = record(providerRecord.message)
        const id = typeof message?.id === 'string' && message.id.trim() ? message.id : undefined
        if (id) this.messageIds.add(id)
        else {
          const fingerprint = createHash('sha256').update(JSON.stringify(message ?? providerRecord)).digest('hex')
          if (!this.anonymousMessageFingerprints.has(fingerprint)) {
            this.anonymousMessageFingerprints.add(fingerprint)
            this.anonymousMessages += 1
          }
        }
        for (const block of contentOf(providerRecord)) {
          if (block.type !== 'tool_use') continue
          const name = typeof block.name === 'string' ? block.name : ''
          const toolId = typeof block.id === 'string' ? block.id : undefined
          if (toolId) {
            // Never terminate Bash, Skill, MCP, or another provider tool while
            // it is in flight. Only completed write-family tools establish a
            // durable source boundary, but every tool blocks cancellation.
            this.pendingTools.add(toolId)
            if (/^(?:edit|write|multiedit|notebookedit)$/iu.test(name)) {
              this.durableTools.add(toolId)
              this.durableBoundary = false
            }
          }
        }
      }
      if (providerRecord.type === 'user') {
        for (const block of contentOf(providerRecord)) {
          const toolId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
          if (block.type === 'tool_result' && toolId && this.pendingTools.delete(toolId)) {
            if (this.durableTools.delete(toolId)) this.durableBoundary = block.is_error !== true
          }
        }
      }
    }
    const steps = this.initialInferenceSteps + this.messageIds.size + this.anonymousMessages
    if (!this.requested && (
      steps >= this.maximumInferenceSteps && this.durableBoundary && this.pendingTools.size === 0 ||
      steps > this.maximumInferenceSteps && this.pendingTools.size === 0
    )) this.requested = true
    return this.snapshot()
  }

  snapshot(): LeaseSnapshot {
    return {
      inferenceSteps: this.initialInferenceSteps + this.messageIds.size + this.anonymousMessages,
      durableToolBoundary: this.durableBoundary,
      shouldTimebox: this.requested
    }
  }
}
