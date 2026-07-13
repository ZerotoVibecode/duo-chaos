import type { DuoEvent } from '@shared/types'

interface VisibleActivityBudgetOptions {
  maxVisible?: number
  maxRepeated?: number
  maxErrors?: number
  windowMs?: number
  now?: () => number
}

/** Keeps raw process logs intact while bounding the spoiler-safe spectator stream. */
export class VisibleActivityBudget {
  private readonly counts = new Map<string, number>()
  private visible = 0
  private errors = 0
  private readonly maxVisible: number
  private readonly maxRepeated: number
  private readonly maxErrors: number
  private readonly windowMs: number
  private readonly now: () => number
  private windowStartedAt: number

  constructor(options: VisibleActivityBudgetOptions = {}) {
    this.maxVisible = options.maxVisible ?? 48
    this.maxRepeated = options.maxRepeated ?? 3
    this.maxErrors = options.maxErrors ?? 2
    this.windowMs = Math.max(1_000, options.windowMs ?? 60_000)
    this.now = options.now ?? Date.now
    this.windowStartedAt = this.now()
  }

  private resetWindowWhenDue(): void {
    const current = this.now()
    if (current >= this.windowStartedAt && current - this.windowStartedAt < this.windowMs) return
    this.windowStartedAt = current
    this.counts.clear()
    this.visible = 0
    this.errors = 0
  }

  accept(event: DuoEvent): boolean {
    if (event.type !== 'cli.log' && event.type !== 'agent.activity') return true
    if (
      event.type === 'agent.activity' &&
      (event.metadata?.verificationPassed === true || event.metadata?.verificationFailed === true)
    ) return true
    this.resetWindowWhenDue()
    if (this.visible >= this.maxVisible) return false

    const isError = event.category === 'error'
    const key = `${event.type}:${event.category ?? 'unknown'}:${event.publicText}`
    const count = this.counts.get(key) ?? 0
    const repeatedLimit = isError ? 1 : this.maxRepeated
    if (count >= repeatedLimit || isError && this.errors >= this.maxErrors) return false

    this.counts.set(key, count + 1)
    this.visible += 1
    if (isError) this.errors += 1
    return true
  }
}
