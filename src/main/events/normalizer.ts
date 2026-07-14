import { randomUUID } from 'node:crypto'
import type { AgentDispatchKind, AgentId, DuoEvent, DuoEventType, OpinionTone, Severity } from '@shared/types'
import { decodeProviderEnvelope, type ProviderRecord } from '@main/process/provider-envelope'

interface EventContext {
  runId: string
  round: number
}

interface CliContext extends EventContext {
  source: 'claude' | 'codex'
  stream: 'stdout' | 'stderr'
}

export interface CliActivityState {
  pendingClaudeVerificationToolUses: Set<string>
}

export interface CliQuotaSignal {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  overageStatus?: string
  resetAt?: string
  utilization?: number
  warningThreshold?: number
}

const TYPE_ALIASES: Record<string, DuoEventType> = {
  run_started: 'run.started',
  health_check: 'health.check',
  phase_changed: 'phase.changed',
  agent_started: 'agent.started',
  agent_output: 'cli.log',
  agent_dispatch: 'agent.dispatch',
  'agent-dispatch': 'agent.dispatch',
  opening: 'agent.dispatch',
  position: 'agent.dispatch',
  challenge: 'agent.dispatch',
  counter: 'agent.dispatch',
  reaction: 'agent.dispatch',
  evidence: 'agent.dispatch',
  prediction: 'agent.dispatch',
  concession: 'agent.dispatch',
  verdict: 'agent.dispatch',
  closing: 'agent.dispatch',
  criticism: 'opinion',
  'product-opinion': 'opinion',
  'implementation-opinion': 'opinion',
  'verification-opinion': 'opinion',
  'wrap-opinion': 'opinion',
  critique: 'opinion',
  review: 'opinion',
  'design-review': 'opinion',
  task_created: 'task.created',
  task_claimed: 'task.claimed',
  file_changed: 'file.changed',
  git_checkpoint: 'git.checkpoint',
  build_started: 'build.started',
  build_failed: 'build.failed',
  repair_started: 'repair.started',
  repair_completed: 'repair.completed',
  reveal_ready: 'reveal.ready',
  run_completed: 'run.completed',
  run_failed: 'run.failed'
}

const EVENT_TYPES = new Set<DuoEventType>([
  'run.started', 'health.check', 'phase.changed', 'agent.started', 'agent.activity', 'agent.dispatch', 'cli.log',
  'opinion', 'conflict', 'decision', 'task.created', 'task.claimed', 'task.updated',
  'file.changed', 'git.checkpoint', 'build.started', 'build.failed', 'build.passed',
  'repair.started', 'repair.completed', 'reveal.ready', 'run.completed', 'run.failed', 'run.cancelled'
])

const OPINION_TONES: Record<string, OpinionTone> = {
  'product-opinion': 'confident',
  critique: 'skeptical',
  'implementation-opinion': 'collaborative',
  review: 'cautious',
  'design-review': 'cautious',
  'verification-opinion': 'cautious',
  'wrap-opinion': 'impressed'
}

const DISPATCH_KINDS = new Set<AgentDispatchKind>([
  'opening', 'position', 'challenge', 'counter', 'reaction', 'evidence', 'prediction',
  'concession', 'decision', 'repair', 'verdict', 'closing', 'update'
])

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function stringOf(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

const MOJIBAKE_REPAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e2\u20ac\u2122', '\u2019'],
  ['\u00e2\u20ac\u02dc', '\u2018'],
  ['\u00e2\u20ac\u0153', '\u201c'],
  ['\u00e2\u20ac\u009d', '\u201d'],
  ['\u00e2\u20ac\u201c', '\u2013'],
  ['\u00e2\u20ac\u201d', '\u2014'],
  ['\u00e2\u20ac\u00a6', '\u2026'],
  ['\u00e2\u2020\u2019', '\u2192'],
  ['\u00c2\u00b7', '\u00b7']
]

function repairMojibake(value: string): string {
  let repaired = value
  for (const [broken, replacement] of MOJIBAKE_REPAIRS) repaired = repaired.replaceAll(broken, replacement)
  return repaired
}

function numberOf(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback
}

function optionalUnitNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined
}

function riskOf(value: unknown): number {
  if (typeof value === 'number') return numberOf(value, 0.1)
  if (typeof value === 'boolean') return value ? 0.85 : 0.05
  if (typeof value === 'string') {
    return { none: 0.05, low: 0.25, medium: 0.55, high: 0.85, critical: 1 }[value.toLowerCase()] ?? 0.1
  }
  return 0.1
}

function agentOf(value: unknown, fallback: AgentId = 'system'): AgentId {
  return value === 'claude' || value === 'codex' || value === 'director' || value === 'system'
    ? value
    : value === 'orchestrator' || value === 'referee'
      ? 'director'
      : fallback
}

function severityOf(value: unknown): Severity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium'
}

function toneOf(value: unknown): OpinionTone | undefined {
  const supported: OpinionTone[] = [
    'skeptical',
    'impressed',
    'annoyed',
    'confident',
    'cautious',
    'amused',
    'contrarian',
    'self-critical',
    'collaborative',
    'ruthless'
  ]
  return supported.includes(value as OpinionTone) ? (value as OpinionTone) : undefined
}

function dispatchKindOf(value: unknown): AgentDispatchKind | undefined {
  return typeof value === 'string' && DISPATCH_KINDS.has(value as AgentDispatchKind)
    ? value as AgentDispatchKind
    : undefined
}

function typeOf(value: unknown): DuoEventType {
  if (typeof value !== 'string') return 'cli.log'
  const alias = TYPE_ALIASES[value]
  if (alias) return alias
  return EVENT_TYPES.has(value as DuoEventType) ? (value as DuoEventType) : 'cli.log'
}

export function normalizeEvent(value: unknown, context: EventContext): DuoEvent {
  const input = recordOf(value)
  const inputType = stringOf(input.type)
  const normalizedType = typeOf(inputType)
  const type: DuoEventType = dispatchKindOf(input.dispatchKind) ? 'agent.dispatch' : normalizedType
  const timestamp = stringOf(input.timestamp, input.createdAt) ?? new Date().toISOString()
  const publicText = repairMojibake(
    stringOf(input.publicText, input.public, input.redactedText, input.text, input.message) ?? 'Activity received.'
  )
  const privateText = stringOf(input.privateText, input.private, input.raw)
  const targetAgentValue = input.targetAgent ?? input.target
  const agent = agentOf(input.agent ?? input.source)
  const inferredTarget = (type === 'opinion' || type === 'agent.dispatch') && (agent === 'claude' || agent === 'codex')
    ? agent === 'claude' ? 'codex' : 'claude'
    : undefined
  const inferredTone = inputType ? OPINION_TONES[inputType] : undefined
  const inferredTopic = type === 'opinion' && inputType !== 'opinion' ? inputType : undefined
  const confidence = optionalUnitNumber(input.confidence)
  const heat = optionalUnitNumber(input.heat)
  const dispatchKind = type === 'agent.dispatch'
    ? dispatchKindOf(input.dispatchKind) ?? dispatchKindOf(inputType)
    : undefined

  return {
    id: stringOf(input.id) ?? randomUUID(),
    type,
    runId: stringOf(input.runId) ?? context.runId,
    round: Number.isInteger(input.round) ? Number(input.round) : context.round,
    timestamp,
    agent,
    publicText,
    ...(privateText ? { privateText } : {}),
    spoilerRisk: riskOf(input.spoilerRisk),
    severity: severityOf(input.severity),
    ...(targetAgentValue || inferredTarget ? { targetAgent: agentOf(targetAgentValue ?? inferredTarget) } : {}),
    ...(stringOf(input.topic) ?? inferredTopic ? { topic: stringOf(input.topic) ?? inferredTopic } : {}),
    ...(toneOf(input.tone ?? input.mood) ?? inferredTone ? { tone: toneOf(input.tone ?? input.mood) ?? inferredTone } : {}),
    ...(dispatchKind ? { dispatchKind } : {}),
    ...(stringOf(input.claimKey) ? { claimKey: stringOf(input.claimKey) } : {}),
    ...(stringOf(input.replyTo) ? { replyTo: stringOf(input.replyTo) } : {}),
    ...(confidence === undefined ? {} : { confidence }),
    ...(heat === undefined ? {} : { heat }),
    metadata: input
  }
}

interface CliSummary {
  publicText: string
  category: NonNullable<DuoEvent['category']>
  severity: Severity
  meaningful: boolean
  verificationPassed?: boolean
  verificationFailed?: boolean
  commandCompleted?: boolean
}

function agentName(source: CliContext['source']): string {
  return source === 'claude' ? 'Claude' : 'Codex'
}

function naturalQuotaResetAt(message: string, now: Date): string | undefined {
  const match = message.match(/\b(?:try again|resets?)\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/iu)
  if (!match) return undefined
  let hour = Number(match[1]) % 12
  if (match[3]?.toLocaleLowerCase() === 'pm') hour += 12
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return undefined
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate.toISOString()
}

const QUOTA_STATUS_PRIORITY: Readonly<Record<CliQuotaSignal['status'], number>> = {
  allowed: 0,
  allowed_warning: 1,
  rejected: 2
}

function dominantQuotaSignal(
  current: CliQuotaSignal | undefined,
  candidate: CliQuotaSignal
): CliQuotaSignal {
  if (!current) return candidate
  const dominant = QUOTA_STATUS_PRIORITY[candidate.status] > QUOTA_STATUS_PRIORITY[current.status]
    ? candidate
    : current
  const fallback = dominant === candidate ? current : candidate
  return {
    ...fallback,
    ...dominant,
    status: dominant.status,
    ...(dominant.rateLimitType ?? fallback.rateLimitType
      ? { rateLimitType: dominant.rateLimitType ?? fallback.rateLimitType }
      : {}),
    ...(dominant.overageStatus ?? fallback.overageStatus
      ? { overageStatus: dominant.overageStatus ?? fallback.overageStatus }
      : {}),
    ...(dominant.resetAt ?? fallback.resetAt
      ? { resetAt: dominant.resetAt ?? fallback.resetAt }
      : {}),
    ...((dominant.utilization ?? fallback.utilization) !== undefined
      ? { utilization: dominant.utilization ?? fallback.utilization }
      : {}),
    ...((dominant.warningThreshold ?? fallback.warningThreshold) !== undefined
      ? { warningThreshold: dominant.warningThreshold ?? fallback.warningThreshold }
      : {})
  }
}

export function parseCliQuotaSignal(line: string, now = new Date()): CliQuotaSignal | undefined {
  let signal: CliQuotaSignal | undefined
  for (const input of decodeProviderEnvelope(line)) {
    if (input.type !== 'rate_limit_event') {
      if (input.type !== 'error' && input.type !== 'turn.failed') continue
      const error = recordOf(input.error)
      const message = typeof input.message === 'string'
        ? input.message
        : typeof error.message === 'string' ? error.message : ''
      if (!/\b(?:usage limit|quota|out of (?:credits|tokens))\b/iu.test(message)) continue
      const resetAt = naturalQuotaResetAt(message, now)
      signal = dominantQuotaSignal(signal, {
        status: 'rejected',
        ...(resetAt ? { resetAt } : {})
      })
      continue
    }
    const info = recordOf(input.rate_limit_info)
    const status = info.status
    if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') continue
    const rawResetAt = info.resetAt ?? info.resetsAt ?? info.reset_at
    const resetTimestamp = typeof rawResetAt === 'number' && Number.isFinite(rawResetAt)
      ? (rawResetAt < 10_000_000_000 ? rawResetAt * 1_000 : rawResetAt)
      : typeof rawResetAt === 'string' ? Date.parse(rawResetAt) : Number.NaN
    const resetAt = Number.isFinite(resetTimestamp) ? new Date(resetTimestamp).toISOString() : undefined
    const utilization = optionalUnitNumber(info.utilization)
    const warningThreshold = optionalUnitNumber(info.surpassedThreshold ?? info.warningThreshold)
    signal = dominantQuotaSignal(signal, {
      status,
      ...(typeof info.rateLimitType === 'string' ? { rateLimitType: info.rateLimitType } : {}),
      ...(typeof info.overageStatus === 'string' ? { overageStatus: info.overageStatus } : {}),
      ...(utilization !== undefined ? { utilization } : {}),
      ...(warningThreshold !== undefined ? { warningThreshold } : {}),
      ...(resetAt ? { resetAt } : {})
    })
  }
  return signal
}

function shellPayload(command: string): string {
  const trimmed = command.trim()
  const wrapper = trimmed.match(
    /^(?:"[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+[\s\S]*?-(?:command|c)\s+([\s\S]+)$/i
  ) ?? trimmed.match(
    /^(?:"[^"]*[\\/])?cmd(?:\.exe)?"?\s+\/(?:c|k)\s+([\s\S]+)$/i
  ) ?? trimmed.match(
    /^(?:"[^"]*[\\/])?(?:bash|sh)(?:\.exe)?"?\s+-l?c\s+([\s\S]+)$/i
  )
  const payload = wrapper?.[1]?.trim() ?? trimmed
  if (payload.length >= 2 && ((payload.startsWith('"') && payload.endsWith('"')) || (payload.startsWith("'") && payload.endsWith("'")))) {
    return payload.slice(1, -1).trim()
  }
  return payload
}

function isRecognizableVerificationSegment(candidate: string): boolean {
  const segment = candidate
    .trim()
    .replace(/^[(&\s]+/, '')
    .replace(/^&\s*/, '')
    .replace(/^(?:cross-env(?:-shell)?\s+(?:[^\s=]+=[^\s]+\s+)*)/i, '')
    .trim()
  const executable = '(?:"?[^"\\s]+[\\\\/])?'
  const packageManager = new RegExp(
    `^${executable}(?:npm|pnpm|yarn|bun)(?:\\.(?:cmd|exe|ps1))?\\s+(?:run\\s+)?(?:test(?::[\\w.-]+)?|build(?::[\\w.-]+)?|typecheck|lint|check|verify)(?:\\s|$)`,
    'i'
  )
  const packageExecutor = new RegExp(
    `^${executable}(?:npx|bunx)(?:\\.(?:cmd|exe|ps1))?(?:\\s+--yes)?\\s+(?:vitest|jest|tsc|eslint|playwright)(?:\\s|$)|^${executable}(?:pnpm\\s+exec|yarn\\s+dlx)\\s+(?:vitest|jest|tsc|eslint|playwright)(?:\\s|$)`,
    'i'
  )
  return packageManager.test(segment) || packageExecutor.test(segment) ||
    /^(?:python(?:3|\.exe)?\s+-m\s+)?pytest(?:\s|$)/i.test(segment) ||
    /^cargo\s+(?:test|check|clippy)(?:\s|$)/i.test(segment) ||
    /^go\s+test(?:\s|$)/i.test(segment) ||
    /^dotnet\s+(?:test|build)(?:\s|$)/i.test(segment) ||
    /^(?:\.\/?|\.\\)?(?:mvnw?|gradlew?)(?:\.cmd|\.bat|\.exe)?\s+(?:test|verify|build|check)(?:\s|$)/i.test(segment) ||
    /^(?:node(?:\.exe)?\s+--check|(?:bash|sh)\s+-n|deno\s+(?:test|check|lint))(?:\s|$)/i.test(segment)
}

function isRecognizableVerificationCommand(command: string): boolean {
  const payload = shellPayload(command)
  // Standard stderr-to-stdout redirection is common in verifier commands and
  // does not alter their exit status. Remove only that narrow form before
  // rejecting shell control operators; a remaining ampersand is still unsafe.
  const controlPayload = payload.replace(/\d*>\s*&\s*\d+/g, '')
  const guardedPowerShellSequence = controlPayload.match(
    /^([^;|\r\n{}]+);\s*if\s*\(\s*\$LASTEXITCODE\s+-eq\s+0\s*\)\s*\{\s*([^;|\r\n{}]+)\s*\}\s*;\s*exit\s+\$LASTEXITCODE\s*$/i
  )
  if (guardedPowerShellSequence) {
    return isRecognizableVerificationSegment(guardedPowerShellSequence[1] ?? '') &&
      isRecognizableVerificationSegment(guardedPowerShellSequence[2] ?? '')
  }
  if (/[;|\r\n]/.test(controlPayload)) return false
  const segments = controlPayload.split(/&&/)
  if (segments.some((candidate) => /&/.test(candidate.trim().replace(/^&\s*/, '')))) return false
  return segments.some(isRecognizableVerificationSegment)
}

function commandSummary(
  command: string,
  source: CliContext['source'],
  completed = false,
  explicitSuccess = false
): CliSummary {
  const name = agentName(source)
  const recognizableVerification = isRecognizableVerificationCommand(command)
  if (recognizableVerification && (!completed || explicitSuccess)) {
    return {
      publicText: completed ? `${name} finished a verification command.` : `${name} is testing the current build.`,
      category: 'command', severity: 'low', meaningful: true,
      ...(completed ? { verificationPassed: true, commandCompleted: true } : {})
    }
  }
  if (!completed && /\b(test|typecheck|lint|build|verify|check)\b/i.test(command)) {
    return {
      publicText: `${name} is testing the current build.`,
      category: 'command', severity: 'low', meaningful: true
    }
  }
  if (/\b(Get-Content|Get-ChildItem|Select-String|rg|grep|find|read)\b/i.test(command)) {
    return {
      publicText: `${name} is inspecting the shared workspace.`, category: 'command', severity: 'low', meaningful: true,
      ...(completed && explicitSuccess ? { commandCompleted: true } : {})
    }
  }
  if (/\b(git\s+(status|diff|log|show))\b/i.test(command)) {
    return {
      publicText: `${name} is checking repository evidence.`, category: 'command', severity: 'low', meaningful: true,
      ...(completed && explicitSuccess ? { commandCompleted: true } : {})
    }
  }
  return {
    publicText: completed ? `${name} completed a workspace command.` : `${name} is running a workspace command.`,
    category: 'command', severity: 'low', meaningful: true,
    ...(completed && explicitSuccess ? { commandCompleted: true } : {})
  }
}

function toolSummary(name: string, input: Record<string, unknown>, source: CliContext['source']): CliSummary {
  const agent = agentName(source)
  if (/^(Read|Glob|Grep|LS)$/i.test(name)) {
    return { publicText: `${agent} is inspecting the shared workspace.`, category: 'command', severity: 'low', meaningful: true }
  }
  if (/^(Edit|Write|NotebookEdit)$/i.test(name)) {
    return { publicText: `${agent} is editing a workspace file.`, category: 'file', severity: 'low', meaningful: true }
  }
  if (/^(Bash|PowerShell|Shell)$/i.test(name)) {
    return commandSummary(stringOf(input.command, input.cmd) ?? '', source)
  }
  return { publicText: `${agent} started a private ${name} tool step.`, category: 'status', severity: 'low', meaningful: true }
}

function correlateClaudeVerification(
  input: Record<string, unknown>,
  context: CliContext,
  state?: CliActivityState
): CliSummary | undefined {
  if (context.source !== 'claude' || !state) return undefined
  const eventType = stringOf(input.type)
  const message = recordOf(input.message)
  const content = Array.isArray(message.content) ? message.content.map(recordOf) : []

  if (eventType === 'assistant') {
    for (const block of content) {
      const toolUseId = stringOf(block.id)
      const toolName = stringOf(block.name)
      const command = stringOf(recordOf(block.input).command, recordOf(block.input).cmd)
      if (
        block.type === 'tool_use' && toolUseId && /^Bash$/i.test(toolName ?? '') && command &&
        isRecognizableVerificationCommand(command)
      ) {
        state.pendingClaudeVerificationToolUses.add(toolUseId)
      }
    }
    return undefined
  }

  if (eventType !== 'user') return undefined
  let matchedResult = false
  let successfulResult = false
  let unsuccessfulResult = false
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    const toolUseId = stringOf(block.tool_use_id)
    if (!toolUseId || !state.pendingClaudeVerificationToolUses.has(toolUseId)) continue
    matchedResult = true
    state.pendingClaudeVerificationToolUses.delete(toolUseId)
    if (block.is_error === false) successfulResult = true
    else unsuccessfulResult = true
  }
  if (!matchedResult) return undefined
  if (unsuccessfulResult) {
    return {
      publicText: 'Claude hit a failed workspace command and is adjusting.',
      category: 'error',
      severity: 'high',
      meaningful: true,
      verificationFailed: true
    }
  }
  if (successfulResult) {
    return {
      publicText: 'Claude finished a verification command.',
      category: 'command',
      severity: 'low',
      meaningful: true,
      verificationPassed: true,
      commandCompleted: true
    }
  }
  return {
    publicText: 'Claude hit a failed workspace command and is adjusting.',
    category: 'error',
    severity: 'high',
    meaningful: true
  }
}

function summarizeParsedCli(input: Record<string, unknown>, context: CliContext): CliSummary {
  const name = agentName(context.source)
  const item = recordOf(input.item)
  const itemType = stringOf(item.type)
  const eventType = stringOf(input.type)

  if ((eventType === 'item.started' || eventType === 'item.completed') && itemType === 'command_execution') {
    const command = stringOf(item.command) ?? ''
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
    if (eventType === 'item.completed' && (exitCode !== undefined && exitCode !== 0 || item.status === 'failed')) {
      return {
        publicText: `${name} hit a failed workspace command and is adjusting.`,
        category: 'error',
        severity: 'high',
        meaningful: true,
        ...(isRecognizableVerificationCommand(command) ? { verificationFailed: true } : {})
      }
    }
    return commandSummary(
      command,
      context.source,
      eventType === 'item.completed',
      eventType === 'item.completed' && exitCode === 0
    )
  }
  if ((eventType === 'item.started' || eventType === 'item.completed') && itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes.length : 1
    return {
      publicText: eventType === 'item.completed'
        ? `${name} changed ${String(changes)} workspace ${changes === 1 ? 'file' : 'files'}.`
        : `${name} is preparing a workspace edit.`,
      category: 'file', severity: 'low', meaningful: true
    }
  }
  if ((eventType === 'item.started' || eventType === 'item.completed') && itemType === 'agent_message') {
    return { publicText: `${name} recorded a private progress update.`, category: 'message', severity: 'low', meaningful: true }
  }
  if (eventType === 'turn.started') {
    return { publicText: `${name} started its private turn.`, category: 'status', severity: 'low', meaningful: true }
  }
  if (eventType === 'turn.completed' || eventType === 'result') {
    return { publicText: `${name} completed its private turn.`, category: 'status', severity: 'low', meaningful: true }
  }
  if (eventType === 'rate_limit_event' && recordOf(input.rate_limit_info).status === 'allowed') {
    return { publicText: `${name} confirmed the current session can continue.`, category: 'status', severity: 'low', meaningful: true }
  }

  const message = recordOf(input.message)
  const content = Array.isArray(message.content) ? message.content : []
  const toolUse = content.map(recordOf).find((block) => block.type === 'tool_use')
  if (toolUse) {
    return toolSummary(stringOf(toolUse.name) ?? 'workspace', recordOf(toolUse.input), context.source)
  }
  if (content.length > 0) {
    return { publicText: `${name} is evaluating the next move.`, category: 'reasoning', severity: 'low', meaningful: true }
  }

  return { publicText: `${name} emitted a private CLI signal.`, category: 'message', severity: 'low', meaningful: false }
}

function safePlainSummary(line: string, context: CliContext): CliSummary {
  const classification = classify(line, context.stream)
  const name = agentName(context.source)
  return {
    publicText: classification.category === 'error'
      ? `${name} reported a private CLI error.`
      : `${name} emitted a private CLI message.`,
    ...classification,
    meaningful: classification.category === 'error'
  }
}

export function normalizeCliActivity(
  line: string,
  context: CliContext,
  state?: CliActivityState
): DuoEvent | undefined {
  const inputs = decodeProviderEnvelope(line)
  if (inputs.length === 0) {
    const summary = safePlainSummary(line, context)
    if (!summary.meaningful) return undefined
    return {
      id: randomUUID(), type: 'agent.activity', runId: context.runId, round: context.round,
      timestamp: new Date().toISOString(), agent: context.source, source: context.source, stream: context.stream,
      publicText: summary.publicText, spoilerRisk: 0.05, category: summary.category, severity: summary.severity
    }
  }
  const quota = parseCliQuotaSignal(line)
  if (quota && quota.status !== 'allowed') {
    const rejected = quota.status === 'rejected'
    const name = agentName(context.source)
    return {
      id: randomUUID(),
      type: 'agent.activity',
      runId: context.runId,
      round: context.round,
      timestamp: new Date().toISOString(),
      agent: context.source,
      source: context.source,
      stream: context.stream,
      publicText: rejected
        ? `${name} reached a provider usage limit. Durable work will be preserved and handed to the other agent.`
        : `${name} is approaching a provider usage limit; the current turn is being watched closely.`,
      spoilerRisk: 0.05,
      topic: 'quota-pressure',
      category: rejected ? 'error' : 'status',
      severity: rejected ? 'high' : 'medium',
      metadata: {
        quotaStatus: quota.status,
        ...(quota.rateLimitType ? { rateLimitType: quota.rateLimitType } : {}),
        ...(quota.overageStatus ? { overageStatus: quota.overageStatus } : {}),
        ...(quota.utilization !== undefined ? { utilization: quota.utilization } : {})
      }
    }
  }
  let summary: CliSummary | undefined
  for (const input of inputs) {
    const eventType = dispatchKindOf(input.dispatchKind) ? 'agent.dispatch' : typeOf(input.type)
    if (eventType === 'opinion' || eventType === 'conflict' || eventType === 'agent.dispatch') continue
    const candidate = correlateClaudeVerification(input, context, state) ?? summarizeParsedCli(input, context)
    if (candidate.meaningful) summary = candidate
  }
  if (!summary) return undefined
  return {
    id: randomUUID(), type: 'agent.activity', runId: context.runId, round: context.round,
    timestamp: new Date().toISOString(), agent: context.source, source: context.source, stream: context.stream,
    publicText: summary.publicText, spoilerRisk: 0.05, category: summary.category, severity: summary.severity,
    ...(summary.verificationPassed || summary.verificationFailed || summary.commandCompleted
      ? {
          metadata: {
            ...(summary.verificationPassed ? { verificationPassed: true } : {}),
            ...(summary.verificationFailed ? { verificationFailed: true } : {}),
            ...(summary.commandCompleted ? { commandCompleted: true } : {})
          }
        }
      : {})
  }
}

function extractDisplayText(input: Record<string, unknown>, fallback: string): string {
  const item = recordOf(input.item)
  const message = recordOf(input.message)
  return stringOf(input.displayText, input.text, input.content, input.message, item.text, item.content, message.content) ?? fallback
}

function classify(text: string, stream: 'stdout' | 'stderr'): {
  category: NonNullable<DuoEvent['category']>
  severity: Severity
} {
  const normalized = text.toLowerCase()
  if (stream === 'stderr' || /\b(error|failed|failure|exception|fatal)\b/.test(normalized)) {
    return { category: 'error', severity: 'high' }
  }
  if (/\b(command|executing|running)\b/.test(normalized)) return { category: 'command', severity: 'low' }
  if (/\b(file|wrote|edited|created|deleted)\b/.test(normalized)) return { category: 'file', severity: 'low' }
  if (/\b(status|complete|started|finished)\b/.test(normalized)) return { category: 'status', severity: 'low' }
  return { category: 'message', severity: 'low' }
}

export function normalizeCliLine(line: string, context: CliContext): DuoEvent {
  const inputs = decodeProviderEnvelope(line)
  if (inputs.length > 0) {
    const input = inputs.at(-1) as ProviderRecord
    const eventType = dispatchKindOf(input.dispatchKind) ? 'agent.dispatch' : typeOf(input.type)
    if (eventType === 'opinion' || eventType === 'conflict' || eventType === 'agent.dispatch') {
      return normalizeEvent(input, context)
    }
    const derived = summarizeParsedCli(input, context)
    const nestedText = extractDisplayText(input, '')
    const summary = derived.meaningful
      ? derived
      : nestedText
        ? { publicText: nestedText, ...classify(nestedText, context.stream), meaningful: true }
        : derived
    return {
      id: randomUUID(),
      type: 'cli.log',
      runId: context.runId,
      round: context.round,
      timestamp: new Date().toISOString(),
      agent: context.source,
      source: context.source,
      stream: context.stream,
      publicText: summary.publicText,
      privateText: line,
      spoilerRisk: 0.5,
      rawAvailable: true,
      category: summary.category,
      severity: summary.severity,
      metadata: input
    }
  }

  const summary = safePlainSummary(line, context)
  return {
    id: randomUUID(),
    type: 'cli.log',
    runId: context.runId,
    round: context.round,
    timestamp: new Date().toISOString(),
    agent: context.source,
    source: context.source,
    stream: context.stream,
    publicText: summary.publicText,
    privateText: line,
    spoilerRisk: 0.4,
    rawAvailable: true,
    category: summary.category,
    severity: summary.severity
  }
}
