import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ExecutionMode, MissionProfile, RunSnapshot, VisibilityMode } from '@shared/types'
import { scanRecentBuilds, type RecentBuildScanOptions } from '@main/history/run-history'
import { writeSeriousMissionContract, writeSeriousMissionGuard } from './serious-mission-contract'

export interface CreateRunWorkspaceInput {
  root: string
  /** Supervisor-owned storage outside the generated workspace. Omit only for legacy callers. */
  runtimeRoot?: string
  runId: string
  prompt: string
  executionMode: ExecutionMode
  visibilityMode: VisibilityMode
  missionProfile?: MissionProfile
}

export interface RunWorkspace {
  workspacePath: string
  appPath: string
  duoPath: string
  /** Runtime telemetry and supervisor state. Equal to duoPath only for legacy callers. */
  runtimePath: string
}

function agentRules(missionProfile: MissionProfile): string {
  const missionRule = missionProfile === 'serious'
    ? '- The human brief is a binding product contract. Preserve every stated requirement; debate architecture, UX, and implementation without replacing the requested product.'
    : '- The human brief is creative direction. Secretly choose the product while keeping it compact, surprising, and buildable.'
  return `# Duo Chaos generated workspace

You are one of two equal AI coding agents collaborating inside a disposable workspace.

- Stay inside this workspace. Never inspect parent or sibling directories.
- Supervisor telemetry is intentionally outside this workspace. Do not search for run logs, prompts, transcripts, or raw streams.
- Keep app-specific details in \`.duo/private/\` and public, spoiler-safe events in \`.duo/public/\`.
- Criticize technical and product decisions, never personalities.
- Both Claude and Codex may pitch, plan, code, review, repair, and polish.
- Mission profile: **${missionProfile}**.
${missionRule}
- Respect \`.duo/locks.json\` and the current task claim.
- Do not ask the human to choose the app idea, stack, layout, or feature scope.
- Push toward a runnable app and record a useful opinion before ending each turn.
- Use the exact canonical public event types requested by the current turn prompt; do not invent type names.
- Put concise, spoiler-safe agent speech in \`.duo/public/dispatches.jsonl\` using \`type: "agent.dispatch"\`.
- Every dispatch needs a stable \`id\`, \`agent\`, \`round\`, \`dispatchKind\`, \`claimKey\`, and \`publicText\`; use \`replyTo\` when answering another dispatch.
- Supported dispatch kinds are \`opening\`, \`position\`, \`challenge\`, \`counter\`, \`reaction\`, \`evidence\`, \`prediction\`, \`concession\`, \`decision\`, \`repair\`, \`verdict\`, \`closing\`, and \`update\`.
- Copy the private counterpart to \`.duo/private/dispatches.jsonl\`; never place app names, hidden mechanics, paths, secrets, or private implementation details in public dispatches.
- Keep \`.duo/board.json\` current whenever tasks are created, claimed, completed, blocked, or rejected as no defect.
`
}

const CLAUDE_RULES = `@AGENTS.md

# Claude Code notes

You are an equal collaborator, not a permanent planner or reviewer. Keep public text spoiler-safe and use private files for app-specific details.
`

const GENERATED_GITIGNORE = `# All Duo coordination is runtime state. Agents can write it, so no .duo file
# is ever promoted into a supervisor Git checkpoint.
.duo/

# Local credentials, dependencies, and generated output
.env
.env.*
!.env.example
node_modules/
dist/
build/
coverage/
*.log
`

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(runId)) {
    throw new Error('Invalid run identifier. Use letters, numbers, hyphens, and underscores only.')
  }
}

function comparisonPath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

function pathIsInside(candidate: string, parent: string): boolean {
  const comparableCandidate = comparisonPath(candidate)
  const comparableParent = comparisonPath(parent)
  return comparableCandidate === comparableParent || comparableCandidate.startsWith(`${comparableParent}${sep}`)
}

async function runtimeAliasesWorkspace(root: string, runtimeRoot: string, runId: string): Promise<boolean> {
  try {
    const [canonicalRoot, canonicalRuntimeRoot] = await Promise.all([
      realpath(root),
      realpath(runtimeRoot)
    ])
    return pathIsInside(resolve(canonicalRuntimeRoot, runId), resolve(canonicalRoot, runId))
  } catch {
    return false
  }
}

async function touch(path: string): Promise<void> {
  await writeFile(path, '', { flag: 'a' })
}

export async function createRunWorkspace(input: CreateRunWorkspaceInput): Promise<RunWorkspace> {
  assertRunId(input.runId)
  const missionProfile = input.missionProfile ?? 'surprise'
  const root = resolve(input.root)
  const workspacePath = resolve(root, input.runId)
  if (workspacePath !== root && !workspacePath.startsWith(`${root}${sep}`)) {
    throw new Error('Resolved workspace escaped the selected root.')
  }

  const duoPath = resolve(workspacePath, '.duo')
  const appPath = resolve(workspacePath, 'app')
  const runtimeRoot = input.runtimeRoot?.trim()
  const externalRuntime = Boolean(runtimeRoot)
  const runtimePath = runtimeRoot ? resolve(runtimeRoot, input.runId) : duoPath
  if (externalRuntime && (
    pathIsInside(runtimePath, workspacePath) ||
    await runtimeAliasesWorkspace(root, resolve(runtimeRoot!), input.runId)
  )) {
    throw new Error('Runtime storage must stay outside the generated workspace.')
  }
  const workspaceDirectories = [
    workspacePath,
    appPath,
    resolve(duoPath, 'public'),
    resolve(duoPath, 'private'),
    resolve(duoPath, 'sealed'),
    resolve(duoPath, 'patches')
  ]
  const runtimeDirectories = externalRuntime
    ? [
        runtimePath,
        resolve(runtimePath, 'public'),
        resolve(runtimePath, 'private', 'raw'),
        resolve(runtimePath, 'prompts'),
        resolve(runtimePath, 'logs')
      ]
    : [
        resolve(runtimePath, 'public'),
        resolve(runtimePath, 'private', 'raw'),
        resolve(runtimePath, 'prompts'),
        resolve(runtimePath, 'logs')
  ]
  await Promise.all([...workspaceDirectories, ...runtimeDirectories].map((directory) => mkdir(directory, { recursive: true })))

  const now = new Date().toISOString()
  if (missionProfile === 'serious') {
    await Promise.all([
      writeSeriousMissionContract(resolve(duoPath, 'sealed'), input.prompt, now),
      writeSeriousMissionGuard(runtimePath, input.prompt, now)
    ])
  }

  await Promise.all([
    writeFile(
      resolve(runtimePath, 'run.json'),
      `${JSON.stringify(
        {
          runId: input.runId,
          createdAt: now,
          status: 'running',
          prompt: input.prompt,
          executionMode: input.executionMode,
          visibilityMode: input.visibilityMode,
          missionProfile,
          round: 0,
          workspacePath,
          appPath
        },
        null,
        2
      )}\n`
    ),
    writeFile(resolve(duoPath, 'board.json'), '{\n  "tasks": []\n}\n'),
    writeFile(resolve(duoPath, 'claims.json'), '{\n  "claims": []\n}\n'),
    writeFile(resolve(duoPath, 'locks.json'), '{\n  "locks": []\n}\n'),
    writeFile(resolve(workspacePath, 'AGENTS.md'), agentRules(missionProfile)),
    writeFile(resolve(workspacePath, 'CLAUDE.md'), CLAUDE_RULES),
    writeFile(resolve(workspacePath, '.gitignore'), GENERATED_GITIGNORE)
  ])

  const compactProtocolFiles = [
    'public/dispatches.jsonl',
    'public/opinions.jsonl',
    'public/conflicts.jsonl',
    'public/decisions.jsonl',
    'public/tasks.jsonl',
    'public/build.jsonl',
    'private/dispatches.jsonl',
    'private/opinions.jsonl',
    'private/pitches.jsonl',
    'private/conflicts.jsonl',
    'private/tasks.jsonl'
  ]
  const runtimeFiles = [
    'public/timeline.jsonl',
    'private/transcript.jsonl',
    'private/raw/claude.jsonl',
    'private/raw/codex.jsonl',
    'logs/orchestrator.log'
  ]
  await Promise.all(compactProtocolFiles.map((file) => touch(resolve(duoPath, file))))
  await Promise.all(runtimeFiles.map((file) => touch(resolve(runtimePath, file))))

  return { workspacePath, appPath, duoPath, runtimePath }
}

/** Compatibility recovery surface for callers that need restart-safe RunSnapshots. */
export async function recoverRecentRuns(
  workspaceRoot: string,
  limit = 8,
  options: RecentBuildScanOptions = {}
): Promise<RunSnapshot[]> {
  const summaries = await scanRecentBuilds(workspaceRoot, limit, options)
  return summaries.map((summary) => {
    const interrupted = summary.status === 'interrupted'
    let status: RunSnapshot['status']
    switch (summary.status) {
      case 'interrupted': status = 'failed'; break
      default: status = summary.status
    }
    return {
      runId: summary.runId,
      prompt: summary.prompt,
      executionMode: summary.executionMode,
      visibilityMode: summary.visibilityMode,
      missionProfile: summary.missionProfile ?? 'surprise',
      phase: interrupted ? 'failed' : summary.phase,
      status,
      round: 0,
      startedAt: summary.startedAt,
      ...(summary.finishedAt || interrupted ? { finishedAt: summary.finishedAt ?? summary.startedAt } : {}),
      workspacePath: summary.workspacePath,
      appPath: resolve(summary.workspacePath, 'app'),
      tasks: [],
      events: []
    }
  })
}
