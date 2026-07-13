import crossSpawn from 'cross-spawn'
import type { AppSettings, ToolHealth } from '@shared/types'
import { buildChildEnvironment, terminateProcessTree } from '../process/process-runner'
import { resolveAgentRuntimeProfiles } from './runtime-profile'
import {
  discoverAgentRuntimeCatalogs,
  buildRuntimeProbeEnvironment,
  parseClaudeHelpCatalog,
  parseCodexModelCatalog
} from './runtime-catalog'

export { buildRuntimeProbeEnvironment, parseClaudeHelpCatalog, parseCodexModelCatalog }

interface ExecutableCheck {
  id: ToolHealth['id']
  label: string
  command: string
  args: string[]
  timeoutMs: number
}

export async function checkExecutable(check: ExecutableCheck): Promise<ToolHealth> {
  const checkedAt = new Date().toISOString()
  return await new Promise<ToolHealth>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = crossSpawn(check.command, check.args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnvironment(process.env)
    })
    const finish = (health: ToolHealth): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(health)
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      finish({
        id: check.id,
        label: check.label,
        command: check.command,
        available: false,
        detail: error.message || 'Executable not found.',
        checkedAt
      })
    })
    child.once('close', (code) => {
      const output = (stdout || stderr).trim().split(/\r?\n/)[0]
      finish({
        id: check.id,
        label: check.label,
        command: check.command,
        available: code === 0,
        ...(output ? { version: output } : {}),
        ...(code === 0 ? {} : { detail: `Exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ''}` }),
        checkedAt
      })
    })
    const timeout = setTimeout(() => {
      void terminateProcessTree(child)
      finish({
        id: check.id,
        label: check.label,
        command: check.command,
        available: false,
        detail: `Health check timed out after ${check.timeoutMs}ms.`,
        checkedAt
      })
    }, check.timeoutMs)
  })
}

export interface HealthCheckDependencies {
  checkExecutable: typeof checkExecutable
  resolveAgentRuntimeProfiles: typeof resolveAgentRuntimeProfiles
  discoverAgentRuntimeCatalogs: typeof discoverAgentRuntimeCatalogs
}

const defaultDependencies: HealthCheckDependencies = {
  checkExecutable,
  resolveAgentRuntimeProfiles,
  discoverAgentRuntimeCatalogs
}

export async function checkAllTools(
  settings: AppSettings,
  dependencies: HealthCheckDependencies = defaultDependencies
): Promise<ToolHealth[]> {
  const [tools, runtimes, catalogs] = await Promise.all([
    Promise.all([
      dependencies.checkExecutable({ id: 'codex', label: 'Codex CLI', command: settings.codexPath, args: ['--version'], timeoutMs: 8_000 }),
      dependencies.checkExecutable({ id: 'claude', label: 'Claude Code', command: settings.claudePath, args: ['--version'], timeoutMs: 8_000 }),
      dependencies.checkExecutable({ id: 'git', label: 'Git', command: settings.gitPath, args: ['--version'], timeoutMs: 5_000 }),
      dependencies.checkExecutable({ id: 'node', label: 'Node.js', command: settings.nodePath, args: ['--version'], timeoutMs: 5_000 }),
      dependencies.checkExecutable({ id: 'npm', label: 'npm', command: settings.npmPath, args: ['--version'], timeoutMs: 8_000 })
    ]),
    dependencies.resolveAgentRuntimeProfiles(settings),
    dependencies.discoverAgentRuntimeCatalogs(settings)
  ])
  return tools.map((tool) => tool.id === 'codex'
    ? { ...tool, runtime: runtimes.codex, catalog: catalogs.codex }
    : tool.id === 'claude'
      ? { ...tool, runtime: runtimes.claude, catalog: catalogs.claude }
      : tool)
}
