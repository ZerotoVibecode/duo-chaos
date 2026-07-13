import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DuoEvent } from '@shared/types'

interface EventStorePaths {
  publicPath: string
  privatePath: string
}

function publicRecord(event: DuoEvent): Omit<DuoEvent, 'privateText' | 'metadata'> {
  const safe = { ...event }
  delete safe.privateText
  delete safe.metadata
  return safe
}

export async function appendRunEvent(
  paths: EventStorePaths,
  event: DuoEvent,
  projectedPublicEvent: DuoEvent = event
): Promise<void> {
  await Promise.all([mkdir(dirname(paths.publicPath), { recursive: true }), mkdir(dirname(paths.privatePath), { recursive: true })])
  await Promise.all([
    appendFile(paths.publicPath, `${JSON.stringify(publicRecord(projectedPublicEvent))}\n`, 'utf8'),
    appendFile(paths.privatePath, `${JSON.stringify(event)}\n`, 'utf8')
  ])
}
