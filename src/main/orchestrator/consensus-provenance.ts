import { createHash } from 'node:crypto'

export interface PitchProvenanceRecord {
  pitchId: string
  runId: string
  round: number
  agent: 'claude' | 'codex'
  title: string
  idea: string
  appeal: string
  risk: string
}

export interface ConsensusProvenanceRecord {
  version: 1
  runId: string
  consensusAppName: string
  sourcePitchIds: string[]
  sourceAgents: Array<'claude' | 'codex'>
  sourceRounds: number[]
  qualityBriefFingerprint: string
}

function normalizedTitle(value: string): string {
  const base = value.trim().match(/^(.*?)(?:\s*[([{]|\s+(?:—|–|-|\||·)\s+|:\s+)/u)?.[1]?.trim() || value.trim()
  return base.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ')
}

export function createPitchProvenanceId(input: {
  runId: string
  round: number
  agent: 'claude' | 'codex'
  index: number
  title: string
  idea: string
}): string {
  const seed = [input.runId, String(input.round), input.agent, String(input.index), input.title, input.idea].join('\0')
  return `pitch-${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24)}`
}

export function resolveConsensusProvenance(input: {
  runId: string
  appName: string
  qualityBriefFingerprint: string
  pitches: PitchProvenanceRecord[]
}): ConsensusProvenanceRecord | undefined {
  const expectedTitle = normalizedTitle(input.appName)
  const matches = input.pitches.filter((pitch) =>
    pitch.runId === input.runId && normalizedTitle(pitch.title) === expectedTitle
  )
  if (matches.length === 0) return undefined
  return {
    version: 1,
    runId: input.runId,
    consensusAppName: input.appName,
    sourcePitchIds: [...new Set(matches.map((pitch) => pitch.pitchId))],
    sourceAgents: [...new Set(matches.map((pitch) => pitch.agent))],
    sourceRounds: [...new Set(matches.map((pitch) => pitch.round))],
    qualityBriefFingerprint: input.qualityBriefFingerprint
  }
}

function sameSet<T extends string | number>(left: T[], right: T[]): boolean {
  const a = [...new Set(left)].sort((x, y) => String(x).localeCompare(String(y)))
  const b = [...new Set(right)].sort((x, y) => String(x).localeCompare(String(y)))
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function validateConsensusProvenance(input: {
  record: ConsensusProvenanceRecord
  runId: string
  qualityBriefFingerprint: string
  immutablePitches: PitchProvenanceRecord[]
}): boolean {
  if (
    input.record.version !== 1 ||
    input.record.runId !== input.runId ||
    input.record.qualityBriefFingerprint !== input.qualityBriefFingerprint
  ) return false
  const expected = resolveConsensusProvenance({
    runId: input.runId,
    appName: input.record.consensusAppName,
    qualityBriefFingerprint: input.qualityBriefFingerprint,
    pitches: input.immutablePitches
  })
  return Boolean(expected) &&
    sameSet(input.record.sourcePitchIds, expected!.sourcePitchIds) &&
    sameSet(input.record.sourceAgents, expected!.sourceAgents) &&
    sameSet(input.record.sourceRounds, expected!.sourceRounds)
}
