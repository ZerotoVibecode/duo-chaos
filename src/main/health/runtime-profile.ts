import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntimeProfile, AppSettings, CodexEffort } from '@shared/types'

type RuntimeAgent = 'codex' | 'claude'
type DetectedRuntime = Omit<AgentRuntimeProfile, 'source'>

const CODEX_EFFORTS = new Set<Exclude<CodexEffort, 'default'>>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const CLAUDE_EFFORTS = new Set<Exclude<CodexEffort, 'default'>>(['low', 'medium', 'high', 'xhigh', 'max'])

function effortOf(value: unknown, supported: Set<Exclude<CodexEffort, 'default'>>): Exclude<CodexEffort, 'default'> | undefined {
  return typeof value === 'string' && supported.has(value as Exclude<CodexEffort, 'default'>)
    ? (value as Exclude<CodexEffort, 'default'>)
    : undefined
}

function topLevelTomlString(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) break
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`))
    if (match?.[1]) return match[1]
  }
  return undefined
}

export function parseCodexRuntimeConfig(content: string): DetectedRuntime {
  const model = topLevelTomlString(content, 'model')
  const effort = effortOf(topLevelTomlString(content, 'model_reasoning_effort'), CODEX_EFFORTS)
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

export function parseClaudeRuntimeConfig(content: string): DetectedRuntime {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : undefined
    const effort = effortOf(value.effort ?? value.effortLevel, CLAUDE_EFFORTS)
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  } catch {
    return {}
  }
}

export function resolveRuntimeProfile(
  agent: RuntimeAgent,
  settings: AppSettings,
  detected: DetectedRuntime
): AgentRuntimeProfile {
  const configuredModel = (agent === 'codex' ? settings.codexModel : settings.claudeModel).trim()
  const configuredEffort = agent === 'codex' ? settings.codexEffort : settings.claudeEffort
  const hasOverride = Boolean(configuredModel) || configuredEffort !== 'default'
  const model = configuredModel || detected.model
  const detectedEffort = agent === 'claude' && detected.effort === 'ultra' ? undefined : detected.effort
  const effort = configuredEffort !== 'default' ? configuredEffort : detectedEffort
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    source: hasOverride ? 'studio' : model || effort ? 'cli-config' : 'cli-default'
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export async function resolveAgentRuntimeProfiles(
  settings: AppSettings,
  paths: { codexConfig?: string; claudeSettings?: string } = {}
): Promise<{ codex: AgentRuntimeProfile; claude: AgentRuntimeProfile }> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  const [codexConfig, claudeSettings] = await Promise.all([
    readOptional(paths.codexConfig ?? join(codexHome, 'config.toml')),
    readOptional(paths.claudeSettings ?? join(homedir(), '.claude', 'settings.json'))
  ])
  return {
    codex: resolveRuntimeProfile('codex', settings, parseCodexRuntimeConfig(codexConfig)),
    claude: resolveRuntimeProfile('claude', settings, parseClaudeRuntimeConfig(claudeSettings))
  }
}
