import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type {
  AgentContributionSummary,
  ExecutionMode,
  MissionProfile,
  RecentBuildProof,
  RecentBuildStatus,
  RecentBuildSummary,
  RunPhase,
  VisibilityMode
} from '@shared/types'
import { releaseVerificationPassCount } from '@shared/verification-evidence'
import { safeReadProtocolText } from '@main/workspace/safe-protocol-files'

const MAX_JSON_BYTES = 512_000
const MAX_TIMELINE_BYTES = 4_000_000
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/

export interface RecentBuildScanOptions {
  /** Supervisor-owned run records. Legacy in-workspace records are still scanned as a fallback. */
  runtimeRoot?: string
}

type JsonRecord = Record<string, unknown>

function recordOf(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

async function safeRecordedWorkspacePath(value: unknown, runId: string): Promise<string | undefined> {
  const stored = stringOf(value)
  if (!stored || !isAbsolute(stored) || basename(stored) !== runId) return undefined
  const candidate = resolve(stored)
  try {
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    const canonical = await realpath(candidate)
    return comparablePath(canonical) === comparablePath(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function executionModeOf(value: unknown): ExecutionMode {
  return value === 'simulation' || value === 'safe' || value === 'chaos' || value === 'yolo-sandbox'
    ? value
    : 'safe'
}

function visibilityModeOf(value: unknown): VisibilityMode {
  return value === 'blind' || value === 'spoiler-shield' || value === 'full-chaos'
    ? value
    : 'spoiler-shield'
}

function missionProfileOf(value: unknown): MissionProfile {
  return value === 'serious' ? 'serious' : 'surprise'
}

function phaseOf(value: unknown): RunPhase {
  const supported = new Set<RunPhase>([
    'idle', 'preflight', 'workspace.create', 'workspace.seed', 'round.pitch', 'round.critique',
    'round.conflict', 'round.consensus', 'round.tasking', 'round.claim', 'round.code',
    'round.cross-review', 'round.repair', 'round.verify', 'reveal.prepare', 'reveal.ready',
    'paused', 'complete', 'failed', 'cancelled'
  ])
  return supported.has(value as RunPhase) ? value as RunPhase : 'failed'
}

function historyStatusOf(value: unknown): RecentBuildStatus {
  if (value === 'complete' || value === 'paused' || value === 'reveal-ready' || value === 'cancelled' || value === 'failed') return value
  return 'interrupted'
}

async function readBoundedJson(path: string, limit = MAX_JSON_BYTES): Promise<JsonRecord | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return undefined
    return recordOf(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

async function readWorkspaceJson(workspacePath: string, path: string): Promise<JsonRecord | undefined> {
  try {
    const content = await safeReadProtocolText(resolve(workspacePath, '.duo'), path, MAX_JSON_BYTES)
    return content === undefined ? undefined : recordOf(JSON.parse(content) as unknown)
  } catch {
    return undefined
  }
}

async function readPublicTimeline(path: string, protocolRoot?: string): Promise<JsonRecord[]> {
  try {
    const content = protocolRoot
      ? await safeReadProtocolText(protocolRoot, path, MAX_TIMELINE_BYTES)
      : await (async () => {
          const stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TIMELINE_BYTES) return undefined
          return await readFile(path, 'utf8')
        })()
    if (content === undefined) return []
    return content
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [recordOf(JSON.parse(line) as unknown)]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function emptyContribution(): AgentContributionSummary {
  return { turns: 0, edits: 0, messages: 0, tasksDone: 0 }
}

function buildProof(
  board: JsonRecord | undefined,
  events: JsonRecord[],
  releaseStatus?: unknown
): RecentBuildProof {
  const tasks = Array.isArray(board?.tasks) ? board.tasks.map(recordOf) : []
  const proof: RecentBuildProof = {
    tasksDone: tasks.filter((task) => task.status === 'done').length,
    tasksTotal: tasks.length,
    checkpoints: events.filter((event) => event.type === 'git.checkpoint').length,
    buildPasses: releaseVerificationPassCount(events, releaseStatus),
    claude: emptyContribution(),
    codex: emptyContribution()
  }

  for (const agent of ['claude', 'codex'] as const) {
    const contribution = proof[agent]
    contribution.turns = events.filter((event) => event.agent === agent && event.type === 'agent.started').length
    contribution.edits = events.filter((event) => event.agent === agent && (
      event.type === 'file.changed' || (event.type === 'agent.activity' && event.category === 'file')
    )).length
    contribution.messages = events.filter((event) => event.agent === agent && (
      event.type === 'agent.dispatch' || event.type === 'opinion'
    )).length
    contribution.tasksDone = tasks.filter((task) => task.status === 'done' && task.claimedBy === agent).length
  }
  return proof
}

async function summaryFromPaths(
  root: string,
  workspacePath: string,
  runPath: string,
  timelinePath: string
): Promise<RecentBuildSummary | undefined> {
  const run = await readBoundedJson(runPath)
  if (!run) return undefined
  const runId = stringOf(run.runId)
  const startedAt = stringOf(run.createdAt)
  if (!runId || runId !== basename(workspacePath) || !RUN_ID.test(runId) || !startedAt) return undefined

  const status = historyStatusOf(run.status)
  const board = await readWorkspaceJson(workspacePath, resolve(workspacePath, '.duo', 'board.json'))
  const workspaceProtocolRoot = resolve(workspacePath, '.duo')
  const comparableTimeline = comparablePath(timelinePath)
  const comparableProtocolRoot = comparablePath(workspaceProtocolRoot)
  const events = await readPublicTimeline(
    timelinePath,
    comparableTimeline === comparableProtocolRoot || comparableTimeline.startsWith(`${comparableProtocolRoot}${sep}`)
      ? workspaceProtocolRoot
      : undefined
  )
  const reveal = status === 'complete'
    ? await readWorkspaceJson(workspacePath, resolve(workspacePath, '.duo', 'sealed', 'reveal_packet.json'))
    : undefined
  const appName = status === 'complete' ? stringOf(reveal?.appName)?.slice(0, 160) : undefined
  const supervisorReleaseStatus = run.releaseStatus === 'ready' || run.releaseStatus === 'partial' || run.releaseStatus === 'failed'
    ? run.releaseStatus
    : undefined
  const releaseStatus = supervisorReleaseStatus ?? (
    reveal?.status === 'partial' || reveal?.status === 'failed' ? reveal.status : undefined
  )
  const proof = buildProof(board, events, supervisorReleaseStatus)
  const finishedAt = status === 'complete' || status === 'cancelled' || status === 'failed'
    ? stringOf(run.updatedAt)
    : undefined

  return {
    runId,
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    status,
    phase: phaseOf(run.phase),
    executionMode: executionModeOf(run.executionMode),
    visibilityMode: visibilityModeOf(run.visibilityMode),
    missionProfile: missionProfileOf(run.missionProfile),
    prompt: stringOf(run.prompt)?.slice(0, 8_000) ?? '',
    workspacePath,
    workspaceRoot: root,
    appName,
    ...(releaseStatus ? { releaseStatus } : {}),
    sealed: status !== 'complete',
    recoverable: status === 'paused' || status === 'interrupted' || status === 'cancelled' || status === 'failed',
    resumable: false,
    proof
  }
}

async function scanLegacyWorkspaceRecords(root: string): Promise<RecentBuildSummary[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map((entry) => {
        const workspacePath = resolve(root, entry.name)
        return summaryFromPaths(
          root,
          workspacePath,
          resolve(workspacePath, '.duo', 'run.json'),
          resolve(workspacePath, '.duo', 'public', 'timeline.jsonl')
        )
      }))
    return summaries.filter((summary): summary is RecentBuildSummary => Boolean(summary))
  } catch {
    return []
  }
}

async function scanExternalRuntimeRecords(root: string, runtimeRoot: string): Promise<RecentBuildSummary[]> {
  try {
    const entries = await readdir(runtimeRoot, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
      .map(async (entry) => {
        const runtimePath = resolve(runtimeRoot, entry.name)
        const runPath = resolve(runtimePath, 'run.json')
        const run = await readBoundedJson(runPath)
        const workspacePath = await safeRecordedWorkspacePath(run?.workspacePath, entry.name) ??
          await safeRecordedWorkspacePath(resolve(root, entry.name), entry.name)
        if (!workspacePath) return undefined
        return summaryFromPaths(
          dirname(workspacePath),
          workspacePath,
          runPath,
          resolve(runtimePath, 'public', 'timeline.jsonl')
        )
      }))
    return summaries.filter((summary): summary is RecentBuildSummary => Boolean(summary))
  } catch {
    return []
  }
}

export async function scanRecentBuilds(
  workspaceRoot: string,
  limit = 8,
  options: RecentBuildScanOptions = {}
): Promise<RecentBuildSummary[]> {
  const root = resolve(workspaceRoot)
  const legacy = await scanLegacyWorkspaceRecords(root)
  const external = options.runtimeRoot?.trim()
    ? await scanExternalRuntimeRecords(root, resolve(options.runtimeRoot))
    : []
  const summaries = new Map<string, RecentBuildSummary>()
  for (const summary of external) summaries.set(summary.runId, summary)
  for (const summary of legacy) {
    if (!summaries.has(summary.runId)) summaries.set(summary.runId, summary)
  }
  return [...summaries.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(0, Math.min(50, Math.trunc(limit))))
}
