import { createHash } from 'node:crypto'
import type { DuoEvent, DuoTask, TaskStatus } from '@shared/types'
import { normalizeEvent } from '@main/events/normalizer'

interface ProtocolContext {
  runId: string
  round: number
  sourceKey: string
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stableProtocolId(sourceKey: string, line: string): string {
  return `protocol-${createHash('sha256').update(`${sourceKey}\0${line}`).digest('hex').slice(0, 24)}`
}

export function parseProtocolJsonl(content: string, context: ProtocolContext): DuoEvent[] {
  const events: DuoEvent[] = []
  for (const line of content.split(/\r?\n/).filter((candidate) => candidate.trim())) {
    try {
      const value = recordOf(JSON.parse(line) as unknown)
      const event = normalizeEvent(
        { ...value, id: textOf(value.id) ?? stableProtocolId(context.sourceKey, line) },
        { runId: context.runId, round: context.round }
      )
      events.push({
        ...event,
        metadata: {
          ...event.metadata,
          // Workspace protocol records are authored by an untrusted agent.
          // Own this marker after normalization so an agent cannot opt out of
          // the final Spoiler Shield projection by spoofing its provenance.
          protocolOrigin: 'workspace-public-protocol',
          protocolSourceKey: context.sourceKey
        }
      })
    } catch {
      // A partially written line is retried on the next protocol poll.
    }
  }
  return events
}

function normalizeStatus(value: unknown): TaskStatus {
  const status = textOf(value)?.toLowerCase().replaceAll('_', '-')
  if (status === 'completed' || status === 'closed' || status === 'closed-no-defect' || status === 'done') return 'done'
  if (status === 'working' || status === 'in-progress') return 'in-progress'
  if (status === 'claimed' || status === 'review' || status === 'blocked' || status === 'open') return status
  return 'open'
}

function taskKind(input: Record<string, unknown>): string {
  const value = textOf(input.type)?.toLowerCase()
  if (value === 'implementation' || value === 'design' || value === 'verification' || value === 'repair') return value
  const title = `${textOf(input.publicTitle) ?? ''} ${textOf(input.title) ?? ''}`.toLowerCase()
  if (title.includes('repair') || title.includes('fix')) return 'repair'
  if (title.includes('verify') || title.includes('test') || title.includes('check')) return 'verification'
  if (title.includes('design') || title.includes('copy') || title.includes('ux')) return 'design'
  return 'implementation'
}

function publicTaskTitle(kind: string): string {
  return {
    repair: 'Repair investigation',
    verification: 'Verification pass',
    design: 'Design challenge',
    implementation: '[FEATURE] implementation'
  }[kind] ?? 'Shared build task'
}

function claimedBy(value: unknown): DuoTask['claimedBy'] | undefined {
  return value === 'claude' || value === 'codex' || value === 'director' || value === 'both' || value === 'none'
    ? value
    : value === null ? 'none' : undefined
}

export function normalizeBoard(value: unknown): DuoTask[] {
  const input = recordOf(value)
  if (!Array.isArray(input.tasks)) return []
  return input.tasks.flatMap((candidate, index) => {
    const task = recordOf(candidate)
    const id = textOf(task.id) ?? `task-${String(index + 1)}`
    const kind = taskKind(task)
    const explicitPublicTitle = textOf(task.publicTitle)
    const privateTitle = textOf(task.privateTitle) ?? textOf(task.title)
    const privateDescription = textOf(task.privateDescription) ?? textOf(task.description) ?? textOf(task.summary)
    const explicitFiles = Array.isArray(task.files)
      ? task.files.map(textOf).filter((file): file is string => Boolean(file))
      : textOf(task.file) ? [textOf(task.file)!]
        : textOf(task.sourceScope) ? [textOf(task.sourceScope)!] : []
    const risk = task.risk === 'low' || task.risk === 'medium' || task.risk === 'high'
      ? task.risk
      : kind === 'repair' ? 'high' : 'medium'
    const owner = claimedBy(task.claimedBy) ?? claimedBy(task.owner)
    return [{
      id,
      publicTitle: explicitPublicTitle ?? publicTaskTitle(kind),
      ...(privateTitle ? { privateTitle } : {}),
      ...(textOf(task.publicDescription) ? { publicDescription: textOf(task.publicDescription) } : {}),
      ...(privateDescription ? { privateDescription } : {}),
      status: normalizeStatus(task.status),
      ...(owner ? { claimedBy: owner } : {}),
      risk,
      files: explicitFiles.map(() => '[WORKSPACE_FILE]'),
      ...(explicitFiles.length > 0 ? { privateFiles: explicitFiles } : {})
    }]
  })
}
