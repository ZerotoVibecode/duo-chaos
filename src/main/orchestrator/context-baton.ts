import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const EXCLUDED = new Set(['.duo', '.git', 'node_modules', 'dist', 'build', 'coverage'])

export interface ContextBatonTask {
  id: string
  title: string
  status: string
  claimedBy?: string
  files?: string[]
}

export interface BuildContextBatonInput {
  workspacePath: string
  agent: 'claude' | 'codex'
  mission: string
  tasks: ContextBatonTask[]
  verificationDigest?: string
  hardConstraints?: string[]
  acceptanceChecks?: string[]
  decisionDelta?: string[]
  opponentPosition?: string
  contributionReceipt?: string
  maxCharacters?: number
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

async function appInventory(workspacePath: string, limit = 80): Promise<string[]> {
  const root = join(workspacePath, 'app')
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= limit) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= limit || EXCLUDED.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const info = await stat(path).catch(() => undefined)
        files.push(`${portable(relative(workspacePath, path))}${info ? ` (${String(info.size)}b)` : ''}`)
      }
    }
  }
  await walk(root)
  return files
}

function clean(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
}

export async function buildContextBaton(input: BuildContextBatonInput): Promise<string> {
  const maximum = Math.min(8_000, Math.max(1_000, input.maxCharacters ?? 6_000))
  const inventory = await appInventory(input.workspacePath)
  const owned = input.tasks.filter((task) => task.claimedBy === input.agent || task.claimedBy === 'both')
  const tasks = (owned.length ? owned : input.tasks).slice(0, 6)
  const section = (title: string, values: string[] | undefined, limit: number): string[] => {
    const bounded = (values ?? []).map(clean).filter(Boolean).slice(0, limit)
    return bounded.length ? [title, ...bounded.map((value) => `- ${value}`)] : []
  }
  const lines = [
    'FOCUS BATON (supervisor-compiled; do not rediscover this context unless evidence requires it)',
    `Mission: ${clean(input.mission)}`,
    ...section('Binding constraints:', input.hardConstraints, 6),
    ...section('Acceptance checks for this slice:', input.acceptanceChecks, 6),
    ...section('Relevant decision delta:', input.decisionDelta, 4),
    ...(input.opponentPosition ? [`Latest teammate position: ${clean(input.opponentPosition).slice(0, 900)}`] : []),
    ...(input.contributionReceipt ? [`Previous contribution receipt: ${clean(input.contributionReceipt).slice(0, 900)}`] : []),
    'Current tasks:',
    ...tasks.map((task) => `- ${task.id}: ${clean(task.title)} [${task.status}; ${task.claimedBy ?? 'unclaimed'}]${task.files?.length ? ` files=${task.files.slice(0, 8).join(',')}` : ''}`),
    input.verificationDigest ? `Latest verification: ${clean(input.verificationDigest).slice(0, 1_000)}` : 'Latest verification: no supervisor failure is pending.',
    'App inventory (start here; broaden only when the task proves it necessary):',
    ...(inventory.length ? inventory.map((file) => `- ${file}`) : ['- app/ is empty'])
  ]
  return lines.join('\n').slice(0, maximum)
}
