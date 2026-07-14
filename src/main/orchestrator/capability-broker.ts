import type {
  CustomizationProfile,
  MissionProfile,
  TurnKind,
  TurnStageName
} from '@shared/types'

export type CapabilityKind = 'skill' | 'plugin' | 'mcp' | 'browser' | 'lsp'
export type CapabilityTrust = 'app-owned' | 'official' | 'user' | 'third-party'
export type CapabilityDisposition = 'available' | 'recommend-install'

/**
 * Deliberately compact metadata. The broker never receives skill bodies,
 * plugin manifests, MCP schemas, credentials, or tool output.
 */
export interface CapabilityDescriptor {
  id: string
  label: string
  kind: CapabilityKind
  trust: CapabilityTrust
  summary: string
  tags: string[]
  available: boolean
  missions?: MissionProfile[]
  stages?: TurnStageName[]
  turnKinds?: TurnKind[]
  priority?: number
}

export interface CapabilityBrokerInput {
  mission: MissionProfile
  stage: TurnStageName
  turnKind: TurnKind
  profile: CustomizationProfile
  task: string
  stack?: string[]
  catalog?: readonly CapabilityDescriptor[]
  maxSelections?: number
  /** Third-party capabilities are opt-in by exact stable identifier. */
  approvedThirdPartyIds?: readonly string[]
}

export interface CapabilitySelection {
  id: string
  label: string
  kind: CapabilityKind
  disposition: CapabilityDisposition
  reason: string
}

export interface CapabilityBrokerResult {
  selected: CapabilitySelection[]
  recommendations: CapabilitySelection[]
  suppressed: Array<Pick<CapabilityDescriptor, 'id' | 'label'> & { reason: string }>
  /** A bounded name-and-purpose shortlist safe to add to one source prompt. */
  promptContract: string
}

export const DEFAULT_CAPABILITY_CATALOG: readonly CapabilityDescriptor[] = [
  {
    id: 'duo-quality',
    label: 'duo-quality',
    kind: 'skill',
    trust: 'app-owned',
    summary: 'Apply the workspace quality contract and evidence-first handoff.',
    tags: ['quality', 'implementation', 'review', 'verification', 'repair'],
    available: true,
    stages: ['opening', 'work'],
    turnKinds: ['tasking', 'code', 'review', 'verify', 'repair'],
    priority: 100
  },
  {
    id: 'typescript-lsp',
    label: 'Official TypeScript LSP',
    kind: 'lsp',
    trust: 'official',
    summary: 'Use TypeScript language intelligence for precise navigation and diagnostics.',
    tags: ['typescript', 'ts', 'tsx', 'react', 'vite', 'electron'],
    available: false,
    stages: ['work'],
    turnKinds: ['code', 'review', 'verify', 'repair'],
    priority: 80
  },
  {
    id: 'browser-qa',
    label: 'Browser QA',
    kind: 'browser',
    trust: 'official',
    summary: 'Exercise the real user journey, console, layout, and accessibility in a browser.',
    tags: ['browser', 'ui', 'frontend', 'react', 'html', 'electron', 'accessibility'],
    available: false,
    stages: ['work'],
    turnKinds: ['review', 'verify'],
    priority: 50
  }
]

function normalizedWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean))
}

function tagMatches(tag: string, text: string, words: ReadonlySet<string>): boolean {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return false
  return normalized.length <= 3 ? words.has(normalized) : text.includes(normalized)
}

function trustAllowed(
  descriptor: CapabilityDescriptor,
  profile: CustomizationProfile,
  approvedThirdPartyIds: ReadonlySet<string>
): boolean {
  if (descriptor.trust === 'app-owned') return true
  if (descriptor.trust === 'third-party') return approvedThirdPartyIds.has(descriptor.id)
  // Core is the app-owned deterministic toolbelt. Smart and Broad may use a
  // short brokered subset of official or already-connected user metadata.
  return profile !== 'core'
}

function relevantScore(descriptor: CapabilityDescriptor, input: CapabilityBrokerInput): number | undefined {
  if (descriptor.missions && !descriptor.missions.includes(input.mission)) return undefined
  if (descriptor.stages && !descriptor.stages.includes(input.stage)) return undefined
  if (descriptor.turnKinds && !descriptor.turnKinds.includes(input.turnKind)) return undefined
  if (descriptor.trust === 'app-owned') return descriptor.priority ?? 100

  const task = input.task.toLowerCase()
  const words = normalizedWords(`${input.task} ${(input.stack ?? []).join(' ')}`)
  const stack = (input.stack ?? []).join(' ').toLowerCase()
  const matches = descriptor.tags.filter((tag) => tagMatches(tag, `${task} ${stack}`, words)).length
  if (matches === 0) return undefined
  return (descriptor.priority ?? 0) + matches * 5
}

function reasonFor(descriptor: CapabilityDescriptor, input: CapabilityBrokerInput): string {
  const availability = descriptor.available ? 'available now' : 'install recommendation only'
  return `${descriptor.summary} Relevant to ${input.turnKind} work; ${availability}.`
}

function promptFor(selected: readonly CapabilitySelection[]): string {
  if (selected.length === 0) {
    return 'No external capability is assigned to this turn. Use the workspace-essential tools only.'
  }
  const entries = selected.map((entry) => {
    const state = entry.disposition === 'available' ? 'available on demand' : 'not installed; recommendation only'
    return `- ${entry.id} (${state}): ${entry.reason}`
  })
  return [
    'CAPABILITY SHORTLIST (metadata only)',
    'Use at most one available capability when it materially improves evidence. Do not inventory, load, or advertise any other skill, plugin, or MCP tool.',
    ...entries
  ].join('\n')
}

/**
 * Chooses a tiny per-turn shortlist without loading or serializing the global
 * capability inventory. Dialogue remains tool-free regardless of profile.
 */
export function selectTurnCapabilities(input: CapabilityBrokerInput): CapabilityBrokerResult {
  if (input.stage === 'dialogue' || input.stage === 'verdict' || input.stage === 'recovery') {
    return { selected: [], recommendations: [], suppressed: [], promptContract: promptFor([]) }
  }

  const catalog = input.catalog ?? DEFAULT_CAPABILITY_CATALOG
  const approvedThirdPartyIds = new Set(input.approvedThirdPartyIds ?? [])
  const suppressed: CapabilityBrokerResult['suppressed'] = []
  const candidates: Array<{ descriptor: CapabilityDescriptor; score: number }> = []

  for (const descriptor of catalog) {
    if (!trustAllowed(descriptor, input.profile, approvedThirdPartyIds)) {
      suppressed.push({ id: descriptor.id, label: descriptor.label, reason: 'not approved for this capability profile' })
      continue
    }
    const score = relevantScore(descriptor, input)
    if (score !== undefined) candidates.push({ descriptor, score })
  }

  const maxSelections = Math.max(0, Math.min(3, Math.floor(input.maxSelections ?? 3)))
  const selected = candidates
    .sort((left, right) => right.score - left.score || left.descriptor.id.localeCompare(right.descriptor.id))
    .slice(0, maxSelections)
    .map(({ descriptor }): CapabilitySelection => ({
      id: descriptor.id,
      label: descriptor.label,
      kind: descriptor.kind,
      disposition: descriptor.available ? 'available' : 'recommend-install',
      reason: reasonFor(descriptor, input)
    }))

  return {
    selected,
    recommendations: selected.filter((entry) => entry.disposition === 'recommend-install'),
    suppressed,
    promptContract: promptFor(selected)
  }
}
