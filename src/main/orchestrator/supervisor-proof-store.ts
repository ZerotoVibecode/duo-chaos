import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DuoTask } from '@shared/types'
import { parseReviewReceiptsJsonl, type ReviewReceipt } from './collaboration-evidence'
import {
  type ConsensusProvenanceRecord,
  type PitchProvenanceRecord
} from './consensus-provenance'
import { parseContributionReceiptsJsonl, type ContributionReceipt } from './contribution-receipt'

const MAX_PROOF_FILE_BYTES = 4_000_000

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
  return proof.version === 1 && proof.runId === runId &&
    typeof proof.consensusAppName === 'string' && Boolean(proof.consensusAppName.trim()) &&
    typeof proof.qualityBriefFingerprint === 'string' && Boolean(proof.qualityBriefFingerprint.trim()) &&
    Array.isArray(proof.sourcePitchIds) && proof.sourcePitchIds.length > 0 &&
    proof.sourcePitchIds.every((id) => typeof id === 'string' && /^pitch-[a-f0-9]{24}$/u.test(id)) &&
    Array.isArray(proof.sourceAgents) && proof.sourceAgents.length > 0 &&
    proof.sourceAgents.every((agent) => agent === 'claude' || agent === 'codex') &&
    Array.isArray(proof.sourceRounds) && proof.sourceRounds.length > 0 &&
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

export class SupervisorProofStore {
  private readonly proofRoot: string

  constructor(runtimePath: string) {
    this.proofRoot = join(runtimePath, 'private', 'proof')
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
}
