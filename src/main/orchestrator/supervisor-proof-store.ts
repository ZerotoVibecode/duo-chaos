import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DuoEvent, DuoTask } from '@shared/types'
import { parseReviewReceiptsJsonl, type ReviewReceipt } from './collaboration-evidence'
import {
  type ConsensusProvenanceRecord,
  type PitchProvenanceRecord
} from './consensus-provenance'
import { parseContributionReceiptsJsonl, type ContributionReceipt } from './contribution-receipt'

const MAX_PROOF_FILE_BYTES = 4_000_000
const MAX_VERIFICATION_SUMMARY_CHARACTERS = 2_000
const MAX_VERIFICATION_CHECKS = 128
const MAX_VERIFICATION_CHECK_ID_CHARACTERS = 256
const MAX_VERIFICATION_CHECK_LABEL_CHARACTERS = 512
const MAX_VERIFICATION_CHECK_DETAIL_CHARACTERS = 1_000
const MAX_LEGACY_TRANSCRIPT_LINES = 650
const MAX_COLLABORATION_PROOF_EVENTS = 2_048
const MAX_COLLABORATION_EVENT_ID_CHARACTERS = 256
const MAX_COLLABORATION_RUN_ID_CHARACTERS = 200

type CollaborationProofEventType = 'agent.dispatch' | 'opinion' | 'conflict'

interface CollaborationProofEventRecord {
  schemaVersion: 1
  runId: string
  id: string
  type: CollaborationProofEventType
  round: number
  timestamp: string
  agent: 'claude' | 'codex'
  targetAgent: 'claude' | 'codex'
  replyTo?: string
}

interface CollaborationProofEnvelope {
  schemaVersion: 1
  runId: string
  events: CollaborationProofEventRecord[]
}

export interface SupervisorVerificationReceipt {
  version: 1
  runId: string
  revision: number
  outcome: 'passed' | 'failed'
  summary: string
  checks: Array<{
    id: string
    outcome: 'passed' | 'failed' | 'skipped'
    label?: string
    detail?: string
  }>
  recordedAt: string
}

interface TaskContractEnvelope {
  schemaVersion: 1
  runId: string
  tasks: DuoTask[]
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function validPitch(value: unknown, runId: string): value is PitchProvenanceRecord {
  const pitch = record(value)
  return pitch.runId === runId && typeof pitch.pitchId === 'string' && /^pitch-[a-f0-9]{24}$/u.test(pitch.pitchId) &&
    typeof pitch.round === 'number' && Number.isInteger(pitch.round) && pitch.round > 0 &&
    (pitch.agent === 'claude' || pitch.agent === 'codex') &&
    ['title', 'idea', 'appeal', 'risk'].every((key) => typeof pitch[key] === 'string' && Boolean(pitch[key].trim()))
}

function validConsensus(value: unknown, runId: string): value is ConsensusProvenanceRecord {
  const proof = record(value)
  const selectionMode = proof.selectionMode ?? 'pitch-title'
  const sourcePitchIdsValid = Array.isArray(proof.sourcePitchIds) && proof.sourcePitchIds.length > 0 &&
    proof.sourcePitchIds.every((id) => typeof id === 'string' && /^pitch-[a-f0-9]{24}$/u.test(id)) &&
    new Set(proof.sourcePitchIds).size === proof.sourcePitchIds.length
  const modeEvidenceValid = selectionMode === 'human-named-synthesis'
    ? Array.isArray(proof.sourcePitchIds) && proof.sourcePitchIds.length <= 2 &&
      typeof proof.namingEvidenceFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(proof.namingEvidenceFingerprint) &&
      typeof proof.pitchCatalogFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(proof.pitchCatalogFingerprint) &&
      typeof proof.sourceSelectionFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(proof.sourceSelectionFingerprint) &&
      typeof proof.pitchRoundCutoff === 'number' && Number.isInteger(proof.pitchRoundCutoff) && proof.pitchRoundCutoff > 0
    : proof.pitchCatalogFingerprint === undefined &&
      proof.sourceSelectionFingerprint === undefined &&
      (proof.namingEvidenceFingerprint === undefined ||
        typeof proof.namingEvidenceFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(proof.namingEvidenceFingerprint))
  return proof.version === 1 && proof.runId === runId &&
    typeof proof.consensusAppName === 'string' && Boolean(proof.consensusAppName.trim()) &&
    typeof proof.qualityBriefFingerprint === 'string' && Boolean(proof.qualityBriefFingerprint.trim()) &&
    (selectionMode === 'pitch-title' || selectionMode === 'human-named-synthesis') &&
    modeEvidenceValid &&
    (proof.pitchRoundCutoff === undefined ||
      typeof proof.pitchRoundCutoff === 'number' && Number.isInteger(proof.pitchRoundCutoff) && proof.pitchRoundCutoff > 0) &&
    sourcePitchIdsValid &&
    Array.isArray(proof.sourceAgents) && proof.sourceAgents.length > 0 &&
    Array.isArray(proof.sourcePitchIds) && proof.sourceAgents.length <= proof.sourcePitchIds.length &&
    new Set(proof.sourceAgents).size === proof.sourceAgents.length &&
    proof.sourceAgents.every((agent) => agent === 'claude' || agent === 'codex') &&
    Array.isArray(proof.sourceRounds) && proof.sourceRounds.length > 0 &&
    Array.isArray(proof.sourcePitchIds) && proof.sourceRounds.length <= proof.sourcePitchIds.length &&
    new Set(proof.sourceRounds).size === proof.sourceRounds.length &&
    proof.sourceRounds.every((round) => typeof round === 'number' && Number.isInteger(round) && round > 0)
}

function validTask(value: unknown): value is DuoTask {
  const task = record(value)
  return typeof task.id === 'string' && Boolean(task.id.trim()) &&
    typeof task.publicTitle === 'string' && Boolean(task.publicTitle.trim()) &&
    ['open', 'claimed', 'in-progress', 'review', 'done', 'blocked'].includes(String(task.status)) &&
    (task.claimedBy === 'claude' || task.claimedBy === 'codex' || task.claimedBy === 'both' || task.claimedBy === 'none') &&
    (task.impact === 'core' || task.impact === 'substantial') &&
    typeof task.privateExpectedOutcome === 'string' && Boolean(task.privateExpectedOutcome.trim()) &&
    Array.isArray(task.privateAcceptanceChecks) && task.privateAcceptanceChecks.length > 0 &&
    task.privateAcceptanceChecks.every((check) => typeof check === 'string' && Boolean(check.trim())) &&
    Array.isArray(task.privateFiles) && task.privateFiles.length > 0 &&
    task.privateFiles.every((file) => typeof file === 'string' && Boolean(file.trim()))
}

function collaborationProofRecord(value: unknown, runId: string): CollaborationProofEventRecord | undefined {
  const event = record(value)
  if (
    typeof runId !== 'string' || !runId || runId.length > MAX_COLLABORATION_RUN_ID_CHARACTERS ||
    event.runId !== runId ||
    typeof event.id !== 'string' || !event.id || event.id.length > MAX_COLLABORATION_EVENT_ID_CHARACTERS ||
    (event.type !== 'agent.dispatch' && event.type !== 'opinion' && event.type !== 'conflict') ||
    typeof event.round !== 'number' || !Number.isInteger(event.round) || event.round < 1 || event.round > 10_000 ||
    typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) ||
    (event.agent !== 'claude' && event.agent !== 'codex') ||
    (event.targetAgent !== 'claude' && event.targetAgent !== 'codex') ||
    event.targetAgent === event.agent ||
    typeof event.publicText !== 'string' || !event.publicText.trim() ||
    (event.replyTo !== undefined && (
      typeof event.replyTo !== 'string' || !event.replyTo ||
      event.replyTo.length > MAX_COLLABORATION_EVENT_ID_CHARACTERS
    ))
  ) return undefined
  return {
    schemaVersion: 1,
    runId,
    id: event.id,
    type: event.type,
    round: event.round,
    timestamp: event.timestamp,
    agent: event.agent,
    targetAgent: event.targetAgent,
    ...(typeof event.replyTo === 'string' ? { replyTo: event.replyTo } : {})
  }
}

function validStoredCollaborationProof(value: unknown, runId: string): value is CollaborationProofEventRecord {
  const event = record(value)
  const synthetic = {
    ...event,
    publicText: 'Recorded collaboration proof.'
  }
  const normalized = collaborationProofRecord(synthetic, runId)
  return normalized !== undefined && event.schemaVersion === 1 &&
    Object.keys(event).every((key) => [
      'schemaVersion', 'runId', 'id', 'type', 'round', 'timestamp', 'agent', 'targetAgent', 'replyTo'
    ].includes(key))
}

function restoredCollaborationEvent(proof: CollaborationProofEventRecord): DuoEvent {
  return {
    id: proof.id,
    type: proof.type,
    runId: proof.runId,
    round: proof.round,
    timestamp: proof.timestamp,
    agent: proof.agent,
    targetAgent: proof.targetAgent,
    ...(proof.replyTo ? { replyTo: proof.replyTo } : {}),
    // The private proof store deliberately records no agent-authored prose.
    // A fixed nonempty marker is sufficient for exact event-id validation.
    publicText: 'Recorded collaboration proof.',
    spoilerRisk: 0,
    severity: 'low'
  }
}

function verificationChecks(value: unknown): SupervisorVerificationReceipt['checks'] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VERIFICATION_CHECKS) return undefined
  const checks: SupervisorVerificationReceipt['checks'] = []
  const ids = new Set<string>()
  for (const item of value) {
    const check = record(item)
    if (
      typeof check.id !== 'string' || !check.id.trim() || check.id.length > MAX_VERIFICATION_CHECK_ID_CHARACTERS ||
      (check.outcome !== 'passed' && check.outcome !== 'failed' && check.outcome !== 'skipped') ||
      (check.label !== undefined && (
        typeof check.label !== 'string' || !check.label.trim() ||
        check.label.length > MAX_VERIFICATION_CHECK_LABEL_CHARACTERS
      )) ||
      (check.detail !== undefined && (
        typeof check.detail !== 'string' || !check.detail.trim() ||
        check.detail.length > MAX_VERIFICATION_CHECK_DETAIL_CHARACTERS
      )) ||
      ids.has(check.id)
    ) return undefined
    ids.add(check.id)
    checks.push({
      id: check.id,
      outcome: check.outcome,
      ...(typeof check.label === 'string' ? { label: check.label } : {}),
      ...(typeof check.detail === 'string' ? { detail: check.detail } : {})
    })
  }
  return checks
}

function validVerificationReceipt(value: unknown, runId: string): value is SupervisorVerificationReceipt {
  const receipt = record(value)
  return receipt.version === 1 && receipt.runId === runId &&
    typeof receipt.revision === 'number' && Number.isInteger(receipt.revision) && receipt.revision >= 0 &&
    (receipt.outcome === 'passed' || receipt.outcome === 'failed') &&
    typeof receipt.summary === 'string' && Boolean(receipt.summary.trim()) &&
    receipt.summary.length <= MAX_VERIFICATION_SUMMARY_CHARACTERS &&
    verificationChecks(receipt.checks) !== undefined &&
    typeof receipt.recordedAt === 'string' && Number.isFinite(Date.parse(receipt.recordedAt))
}

function legacyVerificationReceipt(value: unknown, runId: string): SupervisorVerificationReceipt | undefined {
  const event = record(value)
  if (
    event.runId !== runId ||
    (event.type !== 'build.failed' && event.type !== 'build.passed') ||
    event.topic !== 'supervisor-verification' ||
    typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))
  ) return undefined
  const metadata = record(event.metadata)
  const checks = verificationChecks(metadata.checks)
  const sourceSummary = typeof event.privateText === 'string'
    ? event.privateText
    : typeof event.publicText === 'string'
      ? event.publicText
      : undefined
  if (!checks || !sourceSummary?.trim()) return undefined
  const revision = typeof metadata.revision === 'number' && Number.isInteger(metadata.revision) && metadata.revision >= 0
    ? metadata.revision
    : 0
  return {
    version: 1,
    runId,
    revision,
    outcome: event.type === 'build.passed' ? 'passed' : 'failed',
    summary: sourceSummary.trim().slice(0, MAX_VERIFICATION_SUMMARY_CHARACTERS),
    checks,
    recordedAt: event.timestamp
  }
}

export class SupervisorProofStore {
  private readonly proofRoot: string
  private readonly privateRoot: string

  constructor(runtimePath: string) {
    this.privateRoot = join(runtimePath, 'private')
    this.proofRoot = join(this.privateRoot, 'proof')
  }

  private path(name: string): string {
    return join(this.proofRoot, name)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.proofRoot, { recursive: true })
  }

  private async readBounded(name: string): Promise<string | undefined> {
    try {
      const value = await readFile(this.path(name))
      if (value.length === 0 || value.length > MAX_PROOF_FILE_BYTES) return undefined
      return value.toString('utf8')
    } catch {
      return undefined
    }
  }

  private async append(name: string, value: unknown): Promise<void> {
    await this.ensureRoot()
    await appendFile(this.path(name), `${JSON.stringify(value)}\n`, 'utf8')
  }

  private async writeAtomic(name: string, value: unknown): Promise<void> {
    await this.ensureRoot()
    const destination = this.path(name)
    const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`)
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, destination)
  }

  appendContributionReceipt(receipt: ContributionReceipt): Promise<void> {
    return this.append('contribution_receipts.jsonl', receipt)
  }

  async readContributionReceipts(runId: string): Promise<ContributionReceipt[]> {
    const content = await this.readBounded('contribution_receipts.jsonl')
    return content ? parseContributionReceiptsJsonl(content, runId) : []
  }

  appendReviewReceipt(receipt: ReviewReceipt): Promise<void> {
    return this.append('review_receipts.jsonl', receipt)
  }

  async readReviewReceipts(runId: string): Promise<ReviewReceipt[]> {
    const content = await this.readBounded('review_receipts.jsonl')
    return content ? parseReviewReceiptsJsonl(content, runId) : []
  }

  async recordCollaborationProofEvents(runId: string, events: DuoEvent[]): Promise<DuoEvent[]> {
    if (events.length === 0) return await this.readCollaborationProofEvents(runId)
    const normalized: CollaborationProofEventRecord[] = []
    for (const event of events) {
      const proof = collaborationProofRecord(event, runId)
      if (!proof) throw new Error('Invalid collaboration proof event.')
      normalized.push(proof)
    }
    const existing = await this.readCollaborationProofRecords(runId)
    const merged = new Map(existing.map((proof) => [proof.id, proof]))
    for (const proof of normalized) {
      const prior = merged.get(proof.id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(proof)) {
        throw new Error('Invalid collaboration proof event: an immutable event id changed.')
      }
      merged.set(proof.id, proof)
    }
    const ordered = [...merged.values()].sort((left, right) =>
      left.round - right.round || left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
    )
    if (ordered.length > MAX_COLLABORATION_PROOF_EVENTS) {
      throw new Error('Collaboration proof event limit exceeded; canonical proof was not truncated.')
    }
    const envelope: CollaborationProofEnvelope = { schemaVersion: 1, runId, events: ordered }
    if (Buffer.byteLength(`${JSON.stringify(envelope)}\n`, 'utf8') > MAX_PROOF_FILE_BYTES) {
      throw new Error('Collaboration proof file limit exceeded; canonical proof was not truncated.')
    }
    await this.writeAtomic('collaboration_events.json', envelope)
    return ordered.map(restoredCollaborationEvent)
  }

  async readCollaborationProofEvents(
    runId: string,
    requiredEventIds: readonly string[] = []
  ): Promise<DuoEvent[]> {
    const canonical = await this.readCollaborationProofRecords(runId)
    const knownIds = new Set(canonical.map((event) => event.id))
    const requiredIds = [...new Set(requiredEventIds)]
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_COLLABORATION_EVENT_ID_CHARACTERS)
      .slice(0, MAX_COLLABORATION_PROOF_EVENTS)
    const missingIds = requiredIds.filter((id) => !knownIds.has(id))
    if (missingIds.length === 0) return canonical.map(restoredCollaborationEvent)

    const recovered = await this.readRequiredLegacyCollaborationProofRecords(runId, new Set(missingIds))
    return [...canonical, ...recovered]
      .sort((left, right) => left.round - right.round || left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
      .map(restoredCollaborationEvent)
  }

  /**
   * Upgrade bridge for runs created before canonical collaboration proof was
   * durable. Scan only the bounded supervisor-private transcript and recover
   * only immutable event IDs already referenced by trusted receipts. Agent
   * prose is discarded by collaborationProofRecord and never reaches restore.
   */
  private async readRequiredLegacyCollaborationProofRecords(
    runId: string,
    requiredIds: ReadonlySet<string>
  ): Promise<CollaborationProofEventRecord[]> {
    let transcript: Buffer
    try {
      transcript = await readFile(join(this.privateRoot, 'transcript.jsonl'))
    } catch {
      return []
    }
    if (transcript.length === 0 || transcript.length > MAX_PROOF_FILE_BYTES) return []

    const found = new Map<string, CollaborationProofEventRecord>()
    const conflicted = new Set<string>()
    for (const line of transcript.toString('utf8').split(/\r?\n/u)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as unknown
        const candidate = record(value)
        if (typeof candidate.id !== 'string' || !requiredIds.has(candidate.id) || conflicted.has(candidate.id)) continue
        const proof = collaborationProofRecord(value, runId)
        if (!proof) {
          found.delete(candidate.id)
          conflicted.add(candidate.id)
          continue
        }
        const prior = found.get(proof.id)
        if (prior && JSON.stringify(prior) !== JSON.stringify(proof)) {
          found.delete(proof.id)
          conflicted.add(proof.id)
          continue
        }
        found.set(proof.id, proof)
      } catch {
        // Unrelated or truncated transcript records cannot create proof.
      }
    }
    return [...found.values()]
  }

  private async readCollaborationProofRecords(runId: string): Promise<CollaborationProofEventRecord[]> {
    const content = await this.readBounded('collaboration_events.json')
    if (!content) return []
    try {
      const envelope = record(JSON.parse(content) as unknown)
      if (
        envelope.schemaVersion !== 1 || envelope.runId !== runId || !Array.isArray(envelope.events) ||
        envelope.events.length > MAX_COLLABORATION_PROOF_EVENTS ||
        !envelope.events.every((event) => validStoredCollaborationProof(event, runId))
      ) return []
      const ids = new Set<string>()
      const events = envelope.events
      for (const event of events) {
        if (ids.has(event.id)) return []
        ids.add(event.id)
      }
      return events
    } catch {
      return []
    }
  }

  appendPitch(pitch: PitchProvenanceRecord): Promise<void> {
    return this.append('pitches.jsonl', pitch)
  }

  async readPitches(runId: string): Promise<PitchProvenanceRecord[]> {
    const content = await this.readBounded('pitches.jsonl')
    if (!content) return []
    const latest = new Map<string, PitchProvenanceRecord>()
    for (const line of content.split(/\r?\n/u).slice(-500)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as unknown
        if (validPitch(value, runId)) latest.set(value.pitchId, value)
      } catch {
        // A truncated final record cannot erase earlier immutable proof.
      }
    }
    return [...latest.values()].sort((left, right) => left.round - right.round || left.pitchId.localeCompare(right.pitchId))
  }

  writeConsensusProvenance(proof: ConsensusProvenanceRecord): Promise<void> {
    if (!validConsensus(proof, proof.runId)) {
      return Promise.reject(new Error('Invalid consensus provenance proof.'))
    }
    return this.writeAtomic('consensus_provenance.json', proof)
  }

  async readConsensusProvenance(runId: string): Promise<ConsensusProvenanceRecord | undefined> {
    const content = await this.readBounded('consensus_provenance.json')
    if (!content) return undefined
    try {
      const value = JSON.parse(content) as unknown
      return validConsensus(value, runId) ? value : undefined
    } catch {
      return undefined
    }
  }

  writeTaskContracts(runId: string, tasks: DuoTask[]): Promise<void> {
    const material = tasks.filter(validTask)
    return this.writeAtomic('task_contracts.json', { schemaVersion: 1, runId, tasks: material } satisfies TaskContractEnvelope)
  }

  async readTaskContracts(runId: string): Promise<DuoTask[]> {
    const content = await this.readBounded('task_contracts.json')
    if (!content) return []
    try {
      const value = record(JSON.parse(content) as unknown)
      if (value.schemaVersion !== 1 || value.runId !== runId || !Array.isArray(value.tasks)) return []
      return value.tasks.filter(validTask)
    } catch {
      return []
    }
  }

  writeVerificationReceipt(receipt: SupervisorVerificationReceipt): Promise<void> {
    if (!validVerificationReceipt(receipt, receipt.runId)) {
      return Promise.reject(new Error('Invalid supervisor verification receipt.'))
    }
    return this.writeAtomic('verification_receipt.json', receipt)
  }

  async readLatestVerificationReceipt(runId: string): Promise<SupervisorVerificationReceipt | undefined> {
    const durableContent = await this.readBounded('verification_receipt.json')
    if (durableContent) {
      try {
        const durable = JSON.parse(durableContent) as unknown
        if (validVerificationReceipt(durable, runId)) return durable
      } catch {
        // A damaged new-format receipt falls through to the legacy private transcript.
      }
    }

    let transcript: Buffer
    try {
      transcript = await readFile(join(this.privateRoot, 'transcript.jsonl'))
    } catch {
      return undefined
    }
    if (transcript.length === 0 || transcript.length > MAX_PROOF_FILE_BYTES) return undefined
    const lines = transcript.toString('utf8').split(/\r?\n/u).slice(-MAX_LEGACY_TRANSCRIPT_LINES).reverse()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const receipt = legacyVerificationReceipt(JSON.parse(line) as unknown, runId)
        if (receipt) return receipt
      } catch {
        // Truncated or malformed legacy records cannot override earlier valid proof.
      }
    }
    return undefined
  }
}
