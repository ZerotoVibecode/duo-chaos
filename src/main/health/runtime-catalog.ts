import crossSpawn from 'cross-spawn'
import { buildChildEnvironment, terminateProcessTree } from '../process/process-runner'
import type {
  AgentModelCapability,
  AgentRuntimeCatalog,
  AppSettings,
  CodexEffort
} from '@shared/types'

const VALID_EFFORTS = new Set<Exclude<CodexEffort, 'default'>>([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
])
const MAX_OUTPUT_BYTES = 1_048_576

function effort(value: unknown): Exclude<CodexEffort, 'default'> | undefined {
  return typeof value === 'string' && VALID_EFFORTS.has(value as Exclude<CodexEffort, 'default'>)
    ? value as Exclude<CodexEffort, 'default'>
    : undefined
}

function title(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

export function parseCodexModelCatalog(raw: string): AgentModelCapability[] {
  try {
    const parsed = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return []
    const seen = new Set<string>()
    return parsed.models.flatMap((entry): AgentModelCapability[] => {
      if (!entry || typeof entry !== 'object') return []
      const value = entry as Record<string, unknown>
      const id = typeof value.slug === 'string' ? value.slug.trim() : ''
      const key = id.toLocaleLowerCase()
      if (!id || value.visibility !== 'list' || seen.has(key)) return []
      const levels = Array.isArray(value.supported_reasoning_levels) ? value.supported_reasoning_levels : []
      const efforts = levels.flatMap((level) => {
        if (!level || typeof level !== 'object') return []
        const parsedEffort = effort((level as Record<string, unknown>).effort)
        return parsedEffort ? [parsedEffort] : []
      }).filter((item, index, all) => all.indexOf(item) === index)
      if (efforts.length === 0) return []
      seen.add(key)
      const defaultEffort = effort(value.default_reasoning_level)
      return [{
        id,
        label: typeof value.display_name === 'string' && value.display_name.trim()
          ? value.display_name.trim()
          : id,
        efforts,
        ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {})
      }]
    })
  } catch {
    return []
  }
}

function optionBlock(raw: string, option: string): string {
  const expression = new RegExp(`^\\s*${option.replaceAll('-', '\\-')}\\b`, 'm')
  const match = expression.exec(raw)
  if (!match) return ''
  const tail = raw.slice(match.index)
  const next = /\n\s*--[a-z0-9-]+\b/i.exec(tail.slice(1))
  return next ? tail.slice(0, next.index + 1) : tail
}

export function parseClaudeHelpCatalog(raw: string): AgentModelCapability[] {
  const modelBlock = optionBlock(raw, '--model')
  const effortBlock = optionBlock(raw, '--effort')
  if (!modelBlock || !effortBlock) return []
  const efforts = (effortBlock.match(/\(([^)]+)\)/)?.[1] ?? '')
    .split(',')
    .map((item) => effort(item.trim()))
    .filter((item): item is Exclude<CodexEffort, 'default'> => Boolean(item && item !== 'ultra'))
  if (efforts.length === 0) return []
  const aliases = [...modelBlock.matchAll(/'([^']+)'/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((value) => /^[a-z][a-z0-9]*$/i.test(value))
    .filter((value, index, all) => all.findIndex((candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase()) === index)
  return aliases.map((id) => ({ id, label: title(id), efforts: [...efforts] }))
}

export interface RuntimeCatalogProbeResult {
  code: number | null
  stdout: string
}

export type RuntimeCatalogProbe = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<RuntimeCatalogProbeResult>

export function buildRuntimeProbeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...buildChildEnvironment(source), NO_COLOR: '1', TERM: 'dumb' }
}

export const runBoundedProbe: RuntimeCatalogProbe = async (command, args, timeoutMs) => await new Promise((resolve) => {
  let stdout = ''
  let settled = false
  const child = crossSpawn(command, args, {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: buildRuntimeProbeEnvironment(process.env)
  })
  const finish = (result: RuntimeCatalogProbeResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(result)
  }
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (settled) return
    stdout += chunk.toString()
    if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      void terminateProcessTree(child)
      finish({ code: null, stdout: '' })
    }
  })
  child.once('error', () => finish({ code: null, stdout: '' }))
  child.once('close', (code) => finish({ code, stdout }))
  const timer = setTimeout(() => {
    void terminateProcessTree(child)
    finish({ code: null, stdout: '' })
  }, timeoutMs)
})

function fallbackCodexModels(): AgentModelCapability[] {
  const efforts: AgentModelCapability['efforts'] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return [
    { id: 'gpt-5.6-sol', label: 'Sol', efforts: [...efforts] },
    { id: 'gpt-5.6-terra', label: 'Terra', efforts: [...efforts] }
  ]
}

function fallbackClaudeModels(): AgentModelCapability[] {
  const efforts: AgentModelCapability['efforts'] = ['low', 'medium', 'high', 'xhigh', 'max']
  return ['fable', 'opus', 'sonnet'].map((id) => ({ id, label: title(id), efforts: [...efforts] }))
}

async function discoverCodex(command: string, probe: RuntimeCatalogProbe, discoveredAt: string): Promise<AgentRuntimeCatalog> {
  for (const [args, source] of [
    [['debug', 'models'], 'cli-live'],
    [['debug', 'models', '--bundled'], 'cli-bundled']
  ] as const) {
    const result = await probe(command, [...args], 6_000)
    const models = result.code === 0 ? parseCodexModelCatalog(result.stdout) : []
    if (models.length > 0) return { agent: 'codex', models, source, discoveredAt }
  }
  return {
    agent: 'codex', models: fallbackCodexModels(), source: 'fallback', discoveredAt,
    note: 'The installed Codex CLI did not expose a readable model catalog.'
  }
}

async function discoverClaude(command: string, probe: RuntimeCatalogProbe, discoveredAt: string): Promise<AgentRuntimeCatalog> {
  const result = await probe(command, ['--help'], 5_000)
  const models = result.code === 0 ? parseClaudeHelpCatalog(result.stdout) : []
  if (models.length > 0) return { agent: 'claude', models, source: 'cli-help', discoveredAt }
  return {
    agent: 'claude', models: fallbackClaudeModels(), source: 'fallback', discoveredAt,
    note: 'Claude Code does not expose a machine-readable model catalog; curated aliases remain available.'
  }
}

export async function discoverAgentRuntimeCatalogs(
  settings: AppSettings,
  probe: RuntimeCatalogProbe = runBoundedProbe
): Promise<{ codex: AgentRuntimeCatalog; claude: AgentRuntimeCatalog }> {
  const discoveredAt = new Date().toISOString()
  const [codex, claude] = await Promise.all([
    discoverCodex(settings.codexPath, probe, discoveredAt),
    discoverClaude(settings.claudePath, probe, discoveredAt)
  ])
  return { codex, claude }
}
