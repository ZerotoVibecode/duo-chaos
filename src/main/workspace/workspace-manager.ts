import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { ExecutionMode, MissionProfile, RunSnapshot, VisibilityMode } from '@shared/types'
import { scanRecentBuilds, type RecentBuildScanOptions } from '@main/history/run-history'
import { safeReadProtocolText, safeWriteProtocolText, UnsafeProtocolPathError } from './safe-protocol-files'
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

const DUO_QUALITY_SKILL = `---
name: duo-quality
description: Focused acceptance-driven implementation and evidence review for a Duo Chaos source turn.
---

# Duo quality turn

- Treat the frozen hard constraints and acceptance checks as binding. Do not trade them away for novelty or speed.
- Start from the supervisor FOCUS BATON and owned task. Do not inventory the repository; broaden inspection only when evidence requires it.
- Preserve accepted teammate work and land one distinct, complete owned contribution. Do not spawn subagents.
- For UI work, choose one signature interaction, a deliberate visual hierarchy, readable type, responsive compact and full-screen layouts, and accessible controls instead of generic filler.
- Use only the brokered skill, plugin, or MCP shortlist, and only when it materially reduces uncertainty or strengthens evidence. Do not inventory the toolbelt.
- Batch independent reads. After editing, run the smallest useful direct, unpiped verification command (no pipes, tail, semicolons, or swallowed failures) so the supervisor can trust the real exit status.
- Before stopping, mark the owned task done or explicitly blocked, record verification evidence, and write a concise reply-linked handoff to the teammate. Proof beats prose.
- Never reveal hidden nouns in public files.
`

const GENERATED_GITIGNORE = `# All Duo coordination is runtime state. Agents can write it, so no .duo file
# is ever promoted into a supervisor Git checkpoint.
.duo/
.agents/
.claude/
AGENTS.md
AGENTS.override.md
CLAUDE.md
.codex/
.mcp.json

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

const SUPERVISOR_IGNORE_RULES = [
  '.duo/', '.agents/', '.claude/', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.codex/', '.mcp.json'
] as const
const PROJECT_POLICY_DIRECTORIES = new Set(['.agents', '.claude', '.codex'])
const PROJECT_POLICY_FILES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.mcp.json'])
const POLICY_SCAN_SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
const MAX_POLICY_SCAN_ENTRIES = 20_000
const MAX_GITIGNORE_BYTES = 1024 * 1024

async function assertCanonicalWorkspaceDirectory(path: string, workspaceRoot = path): Promise<void> {
  const root = resolve(workspaceRoot)
  const target = resolve(path)
  if (!pathIsInside(target, root)) throw new UnsafeProtocolPathError()
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafeProtocolPathError()
  const canonical = await realpath(target)
  if (comparisonPath(canonical) !== comparisonPath(target)) throw new UnsafeProtocolPathError()
}

async function ensureCanonicalWorkspaceDirectory(path: string, workspaceRoot: string): Promise<void> {
  const root = resolve(workspaceRoot)
  const target = resolve(path)
  await assertCanonicalWorkspaceDirectory(root)
  await assertCanonicalWorkspaceDirectory(dirname(target), root)
  try {
    await assertCanonicalWorkspaceDirectory(target, root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(target)
    await assertCanonicalWorkspaceDirectory(target, root)
  }
}

async function safelyRemoveWorkspaceEntry(workspaceRoot: string, path: string): Promise<void> {
  const root = resolve(workspaceRoot)
  const target = resolve(path)
  if (!pathIsInside(target, root) || target === root) throw new UnsafeProtocolPathError()
  await assertCanonicalWorkspaceDirectory(root)
  await assertCanonicalWorkspaceDirectory(dirname(target), root)
  try {
    const info = await lstat(target)
    // `rm` removes a link itself. Recursive traversal is reserved for a real
    // directory whose entire parent chain was just proven canonical.
    await rm(target, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function scrubNestedProjectPolicy(root: string): Promise<void> {
  let visited = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_POLICY_SCAN_ENTRIES) {
        throw new Error('Generated app policy scan exceeded its safety boundary.')
      }
      const path = resolve(directory, entry.name)
      if (PROJECT_POLICY_DIRECTORIES.has(entry.name) || PROJECT_POLICY_FILES.has(entry.name)) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !POLICY_SCAN_SKIP_DIRECTORIES.has(entry.name)) {
        await visit(path)
      }
    }
  }
  await visit(root)
}

async function enforceSupervisorIgnoreRules(workspacePath: string): Promise<void> {
  const path = resolve(workspacePath, '.gitignore')
  await assertCanonicalWorkspaceDirectory(workspacePath)
  let current = ''
  try {
    const info = await lstat(path)
    // Never read through links or preserve a multiply-linked inode. Removing
    // the entry first below makes the replacement workspace-local.
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_GITIGNORE_BYTES) {
      current = await safeReadProtocolText(workspacePath, path, MAX_GITIGNORE_BYTES) ?? ''
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const missing = SUPERVISOR_IGNORE_RULES.filter((rule) =>
    !current.split(/\r?\n/u).some((line) => line.trim() === rule)
  )
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  const content = missing.length === 0
    ? current
    : `${current}${separator}\n# Duo supervisor policy (restored between turns)\n${missing.join('\n')}\n`
  await safelyRemoveWorkspaceEntry(workspacePath, path)
  await safeWriteProtocolText(workspacePath, path, content)
}

/**
 * Rebuilds the supervisor-authored instruction boundary before and after every
 * provider call. Generated project configuration is never allowed to become
 * configuration for the next authenticated local CLI process.
 */
export async function restoreSupervisorWorkspacePolicy(
  workspace: RunWorkspace,
  missionProfile: MissionProfile
): Promise<void> {
  await assertCanonicalWorkspaceDirectory(workspace.workspacePath)
  await ensureCanonicalWorkspaceDirectory(workspace.appPath, workspace.workspacePath)
  await assertCanonicalWorkspaceDirectory(workspace.duoPath, workspace.workspacePath)
  const removablePaths = [
    resolve(workspace.workspacePath, '.agents'),
    resolve(workspace.workspacePath, '.claude'),
    resolve(workspace.workspacePath, '.codex'),
    resolve(workspace.workspacePath, '.mcp.json'),
    resolve(workspace.workspacePath, 'AGENTS.md'),
    resolve(workspace.workspacePath, 'AGENTS.override.md'),
    resolve(workspace.workspacePath, 'CLAUDE.md'),
    // The complete directory is supervisor-owned. Removing it from its
    // canonical `.duo/private` parent supports pre-skill runs where it is
    // absent and safely unlinks an agent-created junction before rebuilding.
    resolve(workspace.duoPath, 'private', 'skills')
  ]
  await Promise.all([
    ...removablePaths.map((path) => safelyRemoveWorkspaceEntry(workspace.workspacePath, path)),
    scrubNestedProjectPolicy(workspace.appPath)
  ])
  const skillDirectories = [
    resolve(workspace.duoPath, 'private', 'skills', 'duo-quality'),
    resolve(workspace.workspacePath, '.agents', 'skills', 'duo-quality'),
    resolve(workspace.workspacePath, '.claude', 'skills', 'duo-quality')
  ]
  await Promise.all(skillDirectories.map((directory) => mkdir(directory, { recursive: true })))
  await Promise.all(skillDirectories.map((directory) =>
    assertCanonicalWorkspaceDirectory(directory, workspace.workspacePath)
  ))
  await Promise.all([
    safeWriteProtocolText(workspace.workspacePath, resolve(workspace.workspacePath, 'AGENTS.md'), agentRules(missionProfile)),
    safeWriteProtocolText(workspace.workspacePath, resolve(workspace.workspacePath, 'CLAUDE.md'), CLAUDE_RULES),
    ...skillDirectories.map((directory) =>
      safeWriteProtocolText(workspace.workspacePath, resolve(directory, 'SKILL.md'), DUO_QUALITY_SKILL)
    ),
    enforceSupervisorIgnoreRules(workspace.workspacePath)
  ])
}

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
    resolve(duoPath, 'patches'),
    resolve(duoPath, 'private', 'skills', 'duo-quality'),
    resolve(workspacePath, '.agents', 'skills', 'duo-quality'),
    resolve(workspacePath, '.claude', 'skills', 'duo-quality')
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
    writeFile(resolve(workspacePath, '.gitignore'), GENERATED_GITIGNORE),
    writeFile(resolve(duoPath, 'private', 'skills', 'duo-quality', 'SKILL.md'), DUO_QUALITY_SKILL),
    writeFile(resolve(workspacePath, '.agents', 'skills', 'duo-quality', 'SKILL.md'), DUO_QUALITY_SKILL),
    writeFile(resolve(workspacePath, '.claude', 'skills', 'duo-quality', 'SKILL.md'), DUO_QUALITY_SKILL)
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
