import type { ToolHealth } from '@shared/types'
import {
  pinProviderCapabilitySnapshot,
  type ProviderCapabilityEffort,
  type ProviderCapabilitySnapshot,
  type ProviderTransportFormat
} from './provider-capability-snapshot'

type ProviderAgent = 'claude' | 'codex'
type RequirementLevel = 'blocker' | 'warning' | 'ignore'

export interface ExpectedProviderCliContract {
  agent: ProviderAgent
  evidence: 'verified' | 'unverified'
  transportFormats: ProviderTransportFormat[]
  structuredOutput: boolean
  sessionResume: boolean
  toolDisable: boolean
  quotaResetAvailable: boolean
  efforts: ProviderCapabilityEffort[]
  requiredStructuredTransports: ProviderTransportFormat[]
  requireStructuredOutput: boolean
  sessionResumeRequirement: RequirementLevel
  toolDisableRequirement: RequirementLevel
}

export interface ProviderRunSelection {
  model?: string
  effort?: ProviderCapabilityEffort | 'default'
}

export interface RunPreflightIssue {
  agent: ProviderAgent
  code:
    | 'provider-unavailable'
    | 'capability-unverified'
    | 'structured-output-missing'
    | 'structured-transport-missing'
    | 'model-unsupported'
    | 'effort-unsupported'
    | 'session-resume-missing'
    | 'tool-disable-missing'
  message: string
}

export interface RunPreflightReport {
  capturedAt: string
  ready: boolean
  providers: Record<ProviderAgent, ProviderCapabilitySnapshot>
  blockers: RunPreflightIssue[]
  warnings: RunPreflightIssue[]
}

export interface RunPreflightInput {
  capturedAt: string
  tools: ToolHealth[]
  contracts: ExpectedProviderCliContract[]
  selections: Record<ProviderAgent, ProviderRunSelection>
}

const AGENTS: readonly ProviderAgent[] = ['claude', 'codex']

function providerHealth(tools: ToolHealth[], agent: ProviderAgent): ToolHealth | undefined {
  return tools.find((tool) => tool.id === agent)
}

function providerContract(
  contracts: ExpectedProviderCliContract[],
  agent: ProviderAgent
): ExpectedProviderCliContract {
  const contract = contracts.find((candidate) => candidate.agent === agent)
  if (!contract) throw new Error(`Missing expected ${agent} CLI contract.`)
  return contract
}

function deriveSnapshot(
  capturedAt: string,
  health: ToolHealth | undefined,
  contract: ExpectedProviderCliContract
): ProviderCapabilitySnapshot {
  const allowedEfforts = new Set(contract.efforts)
  const models = (health?.catalog?.models ?? []).map((model) => ({
    id: model.id,
    efforts: model.efforts.filter((effort): effort is ProviderCapabilityEffort => allowedEfforts.has(effort))
  }))
  const liveCatalog = health?.catalog && health.catalog.source !== 'fallback'
  const verified = Boolean(
    health?.available && health.version?.trim() && liveCatalog && contract.evidence === 'verified'
  )

  return pinProviderCapabilitySnapshot({
    schemaVersion: 1,
    agent: contract.agent,
    capturedAt,
    cliVersion: health?.version?.trim() || 'Unavailable',
    source: verified ? 'verified' : 'unverified',
    transportFormats: contract.transportFormats,
    structuredOutput: contract.structuredOutput,
    sessionResume: contract.sessionResume,
    toolDisable: contract.toolDisable,
    efforts: contract.efforts,
    models,
    quotaResetAvailable: contract.quotaResetAvailable
  })
}

function resolvedSelection(
  selection: ProviderRunSelection,
  health: ToolHealth | undefined
): { model?: string; effort?: ProviderCapabilityEffort } {
  const selectedModel = selection.model?.trim()
  const runtimeModel = health?.runtime?.model?.trim()
  const effort = selection.effort && selection.effort !== 'default'
    ? selection.effort
    : health?.runtime?.effort
  return {
    ...(selectedModel || runtimeModel ? { model: selectedModel || runtimeModel } : {}),
    ...(effort ? { effort } : {})
  }
}

function issue(agent: ProviderAgent, code: RunPreflightIssue['code'], message: string): RunPreflightIssue {
  return { agent, code, message }
}

function pushRequirementIssue(
  level: RequirementLevel,
  value: RunPreflightIssue,
  blockers: RunPreflightIssue[],
  warnings: RunPreflightIssue[]
): void {
  if (level === 'blocker') blockers.push(value)
  else if (level === 'warning') warnings.push(value)
}

function inspectProvider(
  agent: ProviderAgent,
  health: ToolHealth | undefined,
  contract: ExpectedProviderCliContract,
  snapshot: ProviderCapabilitySnapshot,
  selection: ProviderRunSelection,
  blockers: RunPreflightIssue[],
  warnings: RunPreflightIssue[]
): void {
  if (!health?.available) {
    blockers.push(issue(agent, 'provider-unavailable', `${agent} CLI is unavailable.`))
  }
  if (snapshot.source === 'unverified') {
    warnings.push(issue(agent, 'capability-unverified', `${agent} capabilities are based on unverified fallback or adapter data.`))
  }
  if (contract.requireStructuredOutput && !snapshot.structuredOutput) {
    blockers.push(issue(agent, 'structured-output-missing', `${agent} cannot return the required structured result.`))
  }
  const missingTransports = contract.requiredStructuredTransports
    .filter((format) => !snapshot.transportFormats.includes(format))
  if (missingTransports.length > 0) {
    blockers.push(issue(agent, 'structured-transport-missing', `${agent} lacks a required structured transport.`))
  }

  const resolved = resolvedSelection(selection, health)
  const selectedModel = resolved.model?.toLocaleLowerCase()
  const model = selectedModel
    ? snapshot.models.find((candidate) => candidate.id.toLocaleLowerCase() === selectedModel)
    : undefined
  if (selectedModel && !model) {
    blockers.push(issue(agent, 'model-unsupported', `${agent} does not advertise the selected model.`))
  } else if (resolved.effort) {
    const supportedEfforts = model?.efforts ?? snapshot.efforts
    if (!supportedEfforts.includes(resolved.effort)) {
      blockers.push(issue(agent, 'effort-unsupported', `${agent} does not advertise the selected effort.`))
    }
  }

  if (!snapshot.sessionResume) {
    pushRequirementIssue(
      contract.sessionResumeRequirement,
      issue(agent, 'session-resume-missing', `${agent} cannot resume an interrupted provider session.`),
      blockers,
      warnings
    )
  }
  if (!snapshot.toolDisable) {
    pushRequirementIssue(
      contract.toolDisableRequirement,
      issue(agent, 'tool-disable-missing', `${agent} cannot suppress optional tool context for a lean run.`),
      blockers,
      warnings
    )
  }
}

export function buildRunPreflightReport(input: RunPreflightInput): RunPreflightReport {
  const providers = {} as Record<ProviderAgent, ProviderCapabilitySnapshot>
  const blockers: RunPreflightIssue[] = []
  const warnings: RunPreflightIssue[] = []

  for (const agent of AGENTS) {
    const health = providerHealth(input.tools, agent)
    const contract = providerContract(input.contracts, agent)
    const snapshot = deriveSnapshot(input.capturedAt, health, contract)
    providers[agent] = snapshot
    inspectProvider(agent, health, contract, snapshot, input.selections[agent], blockers, warnings)
  }

  return {
    capturedAt: input.capturedAt,
    ready: blockers.length === 0,
    providers,
    blockers,
    warnings
  }
}
