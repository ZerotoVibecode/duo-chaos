import type { ProcessRunResult } from '../process/process-runner'

export type ProviderFailureKind =
  | 'quota'
  | 'auth'
  | 'provider-unavailable'
  | 'model-unavailable'
  | 'cli-incompatible'
  | 'contract-invalid'
  | 'session-lost'
  | 'stage-timeout'
  | 'host-interrupted'
  | 'workspace-drift'
  | 'verification-failed'
  | 'user-cancelled'
  | 'safety-violation'

export type ProviderFailurePolicy =
  | 'pause'
  | 'local-replay'
  | 'bounded-retry'
  | 'user-action'
  | 'partial'
  | 'terminal'

export const PROVIDER_FAILURE_POLICY: Readonly<Record<ProviderFailureKind, ProviderFailurePolicy>> = Object.freeze({
  quota: 'pause',
  auth: 'user-action',
  'provider-unavailable': 'bounded-retry',
  'model-unavailable': 'user-action',
  'cli-incompatible': 'user-action',
  'contract-invalid': 'local-replay',
  'session-lost': 'bounded-retry',
  'stage-timeout': 'partial',
  'host-interrupted': 'partial',
  'workspace-drift': 'terminal',
  'verification-failed': 'bounded-retry',
  'user-cancelled': 'terminal',
  'safety-violation': 'terminal'
})

export type CanonicalProviderRecord = Readonly<Record<string, unknown>>

export interface ProviderFailureEvidence {
  agent: 'claude' | 'codex'
  result: ProcessRunResult
  records?: readonly CanonicalProviderRecord[]
  text?: string | readonly string[]
}

export interface ProviderFailureClassification {
  kind: ProviderFailureKind
  policy: ProviderFailurePolicy
  source: 'process' | 'record' | 'text'
  agent: ProviderFailureEvidence['agent']
}

const SIGNALS: ReadonlyArray<readonly [ProviderFailureKind, RegExp]> = [
  ['safety-violation', /\b(?:safety[\s._-]*violation|sandbox[\s._-]*violation|unsafe[\s._-]*workspace|dangerous[\s._-]*mode[\s._-]*required)\b/i],
  ['workspace-drift', /\bworkspace[\s._-]*drift\b/i],
  ['quota', /\b(?:rate[\s._-]*limit(?:[\s._-]*(?:event|info))?|quota|usage[\s._-]*limit|out[\s._-]*of[\s._-]*(?:credits|tokens)|exhausted[\s._-]*balance)\b/i],
  ['auth', /\b(?:authentication[\s._-]*error|unauthori[sz]ed|invalid[\s._-]*(?:api[\s._-]*)?key|login[\s._-]*required|not[\s._-]*logged[\s._-]*in)\b/i],
  ['model-unavailable', /\b(?:model[\s._-]*(?:(?:was|is)[\s._-]*)?(?:not[\s._-]*found|unavailable)|unknown[\s._-]*model|unsupported[\s._-]*model)\b/i],
  ['provider-unavailable', /\b(?:provider[\s._-]*unavailable|service[\s._-]*unavailable|temporarily[\s._-]*unavailable|overloaded[\s._-]*error|bad[\s._-]*gateway|gateway[\s._-]*timeout)\b/i],
  ['contract-invalid', /\b(?:contract[\s._-]*invalid|invalid[\s._-]*contract|structured[\s._-]*output[\s._-]*invalid|schema[\s._-]*validation[\s._-]*(?:failed|error))\b/i],
  ['session-lost', /\b(?:session[\s._-]*(?:not[\s._-]*found|lost)|resume[\s._-]*failed|cannot[\s._-]*resume|invalid[\s._-]*session)\b/i],
  ['verification-failed', /\bverification[\s._-]*(?:failed|failure)\b/i],
  ['cli-incompatible', /\b(?:cli[\s._-]*incompatible|unknown[\s._-]*(?:option|transport)|unsupported[\s._-]*(?:output[\s._-]*format|transport)|unexpected[\s._-]*stream[\s._-]*format)\b/i]
]

function flattenCanonicalRecord(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || output.length >= 256) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value).slice(0, 1_000))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) flattenCanonicalRecord(item, output, depth + 1)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    output.push(key)
    flattenCanonicalRecord(item, output, depth + 1)
  }
}

function recordSignal(records: readonly CanonicalProviderRecord[] | undefined): string {
  const values: string[] = []
  for (const record of records?.slice(0, 128) ?? []) {
    const quota = record.type === 'rate_limit_event' && typeof record.rate_limit_info === 'object' && record.rate_limit_info !== null
      ? record.rate_limit_info as Readonly<Record<string, unknown>>
      : undefined
    if (quota?.status === 'allowed' || quota?.status === 'allowed_warning') continue
    if (quota?.status === 'rejected') {
      flattenCanonicalRecord({ type: record.type, rate_limit_info: quota }, values)
      continue
    }
    const type = typeof record.type === 'string' ? record.type : ''
    const subtype = typeof record.subtype === 'string' ? record.subtype : ''
    const explicitErrorResult = type === 'result' && (
      record.is_error === true || /(?:error|failed|failure)/iu.test(subtype)
    )
    const canonicalFailureRecord = type === 'error' || type.endsWith('.error') || type.endsWith('.invalid') ||
      type.endsWith('.failed') || type.endsWith('.failure') || type.endsWith('.violation') ||
      type === 'workspace.drift' || explicitErrorResult
    if (!canonicalFailureRecord) continue
    flattenCanonicalRecord({
      type,
      ...(subtype ? { subtype } : {}),
      ...(record.is_error !== undefined ? { is_error: record.is_error } : {}),
      ...(record.code !== undefined ? { code: record.code } : {}),
      ...(record.status !== undefined ? { status: record.status } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.message !== undefined ? { message: record.message } : {})
    }, values)
  }
  return values.join(' ')
}

function textSignal(text: ProviderFailureEvidence['text']): string {
  const lines: readonly string[] = typeof text === 'string' ? [text] : text ?? []
  return lines
    .slice(0, 256)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as unknown
        const statuses: string[] = []
        const visit = (value: unknown, depth = 0): void => {
          if (depth > 6 || typeof value !== 'object' || value === null) return
          if (Array.isArray(value)) {
            for (const item of value.slice(0, 64)) visit(item, depth + 1)
            return
          }
          const record = value as Readonly<Record<string, unknown>>
          if (record.type === 'rate_limit_event' && typeof record.rate_limit_info === 'object' && record.rate_limit_info !== null) {
            const status = (record.rate_limit_info as Readonly<Record<string, unknown>>).status
            if (typeof status === 'string') statuses.push(status)
          }
          for (const item of Object.values(record).slice(0, 64)) visit(item, depth + 1)
        }
        visit(parsed)
        return statuses.length === 0 || statuses.some((status) => status !== 'allowed' && status !== 'allowed_warning')
      } catch {
        return true
      }
    })
    .map((line) => line.slice(0, 2_000))
    .join(' ')
}

function classification(
  kind: ProviderFailureKind,
  source: ProviderFailureClassification['source'],
  agent: ProviderFailureEvidence['agent']
): ProviderFailureClassification {
  return { kind, policy: PROVIDER_FAILURE_POLICY[kind], source, agent }
}

function explicitSignal(
  records: string,
  text: string,
  allowedKinds?: ReadonlySet<ProviderFailureKind>
): { kind: ProviderFailureKind; source: 'record' | 'text' } | undefined {
  for (const [kind, pattern] of SIGNALS) {
    if (allowedKinds && !allowedKinds.has(kind)) continue
    if (pattern.test(records)) return { kind, source: 'record' }
    if (pattern.test(text)) return { kind, source: 'text' }
  }
  return undefined
}

export function classifyProviderFailure(
  evidence: ProviderFailureEvidence
): ProviderFailureClassification | undefined {
  const records = recordSignal(evidence.records)
  const processCompletedSuccessfully = evidence.result.exitCode === 0 &&
    evidence.result.signal === null &&
    !evidence.result.timedOut &&
    !evidence.result.cancelled &&
    !evidence.result.outputLimitExceeded &&
    !evidence.result.rawLogWriteFailed
  // Successful CLI output can contain grep/search results, tool echoes, and
  // historical protocol records. Those strings are not provider diagnostics.
  // Canonical structured records remain authoritative even when a CLI exits 0.
  const text = processCompletedSuccessfully ? '' : textSignal(evidence.text)
  const critical = explicitSignal(records, text, new Set(['safety-violation', 'workspace-drift']))
  if (critical) return classification(critical.kind, critical.source, evidence.agent)

  // A bounded supervisor stream is part of the supported CLI transport contract.
  // Reuse the existing user-action compatibility pause so the orchestrator never
  // mistakes a killed over-limit process for a contract response worth replaying.
  if (evidence.result.outputLimitExceeded || evidence.result.rawLogWriteFailed) {
    return classification('cli-incompatible', 'process', evidence.agent)
  }
  if (evidence.result.cancelled) {
    return classification(evidence.result.cancelReason === 'lease' ? 'stage-timeout' : 'user-cancelled', 'process', evidence.agent)
  }
  if (evidence.result.timedOut) return classification('stage-timeout', 'process', evidence.agent)

  const providerSignal = explicitSignal(records, text)
  if (providerSignal) return classification(providerSignal.kind, providerSignal.source, evidence.agent)

  if (evidence.result.signal !== null || evidence.result.exitCode === null) {
    return classification('host-interrupted', 'process', evidence.agent)
  }
  if (evidence.result.exitCode !== 0) {
    return classification('cli-incompatible', 'process', evidence.agent)
  }
  return undefined
}
