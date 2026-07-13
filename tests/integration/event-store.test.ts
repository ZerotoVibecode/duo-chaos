import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendRunEvent } from '../../src/main/events/event-store'
import type { DuoEvent } from '../../src/shared/types'

describe('run event store', () => {
  it('writes separate public and private JSONL without leaking private text publicly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-event-store-'))
    const publicPath = join(root, 'public.jsonl')
    const privatePath = join(root, 'private.jsonl')
    const event: DuoEvent = {
      id: 'evt-1',
      type: 'opinion',
      runId: 'run-1',
      round: 1,
      timestamp: '2026-07-09T12:00:00.000Z',
      agent: 'codex',
      publicText: 'Codex objects to the [FEATURE] scope.',
      privateText: 'Codex objects to the memory constellation scope.',
      spoilerRisk: 0.8,
      severity: 'high'
    }

    await appendRunEvent({ publicPath, privatePath }, event)

    const publicLine = await readFile(publicPath, 'utf8')
    const privateLine = await readFile(privatePath, 'utf8')
    expect(publicLine).not.toContain('memory constellation')
    expect(JSON.parse(publicLine)).not.toHaveProperty('privateText')
    expect(privateLine).toContain('memory constellation')
  })
})
