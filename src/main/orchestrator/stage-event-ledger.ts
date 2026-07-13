import type { DuoEvent } from '@shared/types'

/**
 * Canonical in-memory evidence for the active process lifetime.
 *
 * The renderer timeline is intentionally retained at a small fixed size. Stage
 * acceptance must never use that retained array as its cursor because an array
 * at capacity does not grow when old entries are evicted.
 */
export class StageEventLedger {
  private readonly events: DuoEvent[]

  constructor(initial: DuoEvent[] = []) {
    this.events = [...initial]
  }

  cursor(): number {
    return this.events.length
  }

  append(event: DuoEvent): void {
    this.events.push(event)
  }

  since(cursor: number): DuoEvent[] {
    return this.events.slice(Math.max(0, cursor))
  }
}
