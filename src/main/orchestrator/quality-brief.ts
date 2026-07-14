import { createHash } from 'node:crypto'
import type { MissionProfile } from '@shared/types'

const MAX_CONSTRAINTS = 12
const MAX_ACCEPTANCE_CHECKS = 14
const MAX_SOURCE_TEXT = 280

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'be', 'build', 'by', 'create', 'creating', 'do', 'for', 'from',
  'have', 'i', 'in', 'into', 'is', 'it', 'make', 'me', 'of', 'on', 'or', 'please', 'should', 'something',
  'that', 'the', 'their', 'them', 'this', 'to', 'tool', 'using', 'very', 'want', 'we', 'website', 'with', 'you'
])

const PROCESS_ONLY_PATTERN = /\b(?:agent|argue|challenge weak|claude|codex|debate|decide everything|do not reveal|reveal only|secret|spoiler|yourselves)\b/iu
const PRODUCT_SIGNAL_PATTERN = /\b(?:accessible|app|audience|browser|content|creator|dashboard|desktop|for\s+\p{L}|local|offline|platform|responsive|tool|useful|website|workflow)\b/iu
const RESTRICTION_PATTERN = /\b(?:avoid|do not|don't|must not|never|no|without)\b/iu
const RESTRICTION_CONTROL_TERMS = new Set([
  'add', 'allow', 'avoid', 'disable', 'do', 'don', 'dont', 'enable', 'include', 'must', 'never', 'no', 'not',
  'require', 'use', 'without'
])

export interface QualityBriefConstraint {
  id: string
  kind: 'required-outcome' | 'audience' | 'platform' | 'capability' | 'restriction'
  polarity: 'require' | 'forbid'
  sourceText: string
  coverageTerms: string[]
}

export interface QualityBriefAcceptanceCheck {
  id: string
  description: string
  constraintIds: string[]
}

export interface CompiledQualityBrief {
  version: 1
  missionProfile: MissionProfile
  fingerprint: string
  privateContract: {
    bindingBrief: string
    hardConstraints: QualityBriefConstraint[]
    qualityBar: string[]
    acceptanceChecks: QualityBriefAcceptanceCheck[]
  }
  publicContract: {
    summary: string
    hardConstraintCount: number
    acceptanceCheckCount: number
    qualityDimensionCount: number
  }
}

export interface ConsensusQualityInput {
  appName: string
  idea: string
  summary: string
  spec: string
}

export interface ConsensusQualityAssessment {
  valid: boolean
  violations: string[]
  coveredConstraintIds: string[]
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function normalizedTerm(value: string): string {
  let term = value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')
  if (term === 'locally') return 'local'
  if (term.endsWith('ies') && term.length > 5) term = `${term.slice(0, -3)}y`
  else if (term.endsWith('s') && term.length > 4 && !term.endsWith('ss')) term = term.slice(0, -1)
  return term
}

function meaningfulTerms(value: string): string[] {
  const terms = value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
  return [...new Set(terms.map(normalizedTerm).filter((term) => term.length >= 3 && !STOP_WORDS.has(term)))]
}

function sourceSegments(humanBrief: string): string[] {
  const normalized = humanBrief
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/^\s*[-*\d.)]+\s*/gmu, '')
  return normalized
    .split(/(?:\n+|[.!?;]+|,\s+(?=(?:but|and)\s+)|\s+and\s+(?=(?:it\s+)?(?:must|needs?|should|works?|feels?|has|supports?)\b))/giu)
    .map(normalizedText)
    .filter((segment) => segment.length >= 3)
}

function constraintKind(segment: string): QualityBriefConstraint['kind'] {
  if (RESTRICTION_PATTERN.test(segment)) return 'restriction'
  if (/\bfor\s+(?:an?\s+|the\s+)?[\p{L}\p{N}]/iu.test(segment)) return 'audience'
  if (/\b(?:browser|desktop|local|locally|offline|platform|web|windows|mac|linux|mobile)\b/iu.test(segment)) return 'platform'
  if (/\b(?:can|feature|has|include|interaction|must|needs?|supports?|workflow)\b/iu.test(segment)) return 'capability'
  return 'required-outcome'
}

function restrictionTerms(segment: string): string[] {
  const marker = segment.search(RESTRICTION_PATTERN)
  return meaningfulTerms(marker >= 0 ? segment.slice(marker) : segment)
    .filter((term) => !RESTRICTION_CONTROL_TERMS.has(term))
}

function shouldBindSegment(segment: string, index: number): boolean {
  if (PROCESS_ONLY_PATTERN.test(segment) && !PRODUCT_SIGNAL_PATTERN.test(segment)) return false
  if (index === 0) return true
  return PRODUCT_SIGNAL_PATTERN.test(segment) ||
    /\b(?:must|need|require|should|work|feel|include|support|without|avoid|never|no)\b/iu.test(segment)
}

function constraintId(index: number, sourceText: string): string {
  const hash = createHash('sha256').update(sourceText, 'utf8').digest('hex').slice(0, 10)
  return `constraint-${String(index + 1)}-${hash}`
}

function compileConstraints(humanBrief: string): QualityBriefConstraint[] {
  const constraints: QualityBriefConstraint[] = []
  for (const [index, segment] of sourceSegments(humanBrief).entries()) {
    if (!shouldBindSegment(segment, index)) continue
    const polarity = RESTRICTION_PATTERN.test(segment) ? 'forbid' as const : 'require' as const
    const coverageTerms = polarity === 'forbid' ? restrictionTerms(segment) : meaningfulTerms(segment)
    if (coverageTerms.length === 0) continue
    constraints.push({
      id: constraintId(constraints.length, segment),
      kind: constraintKind(segment),
      polarity,
      sourceText: segment.slice(0, MAX_SOURCE_TEXT),
      coverageTerms: coverageTerms.slice(0, 12)
    })
    if (constraints.length >= MAX_CONSTRAINTS) break
  }

  if (constraints.length === 0) {
    const fallback = normalizedText(humanBrief).slice(0, MAX_SOURCE_TEXT)
    constraints.push({
      id: constraintId(0, fallback),
      kind: 'required-outcome',
      polarity: 'require',
      sourceText: fallback,
      coverageTerms: meaningfulTerms(fallback).slice(0, 12)
    })
  }
  return constraints
}

function qualityBar(): string[] {
  return [
    'The product has a distinctive, intentional direction instead of a generic template.',
    'The primary user journey is complete, understandable, and useful for its stated audience.',
    'The result is responsive and accessible through keyboard-safe controls where interaction exists.',
    'The app is runnable from the generated workspace with truthful launch instructions.',
    'Critical behavior is verified with deterministic checks plus a real user-journey smoke test.',
    'No requirement is silently replaced merely because a different idea is easier to build.'
  ]
}

function acceptanceChecks(constraints: QualityBriefConstraint[]): QualityBriefAcceptanceCheck[] {
  const checks = constraints.slice(0, 10).map((constraint, index) => ({
    id: `acceptance-constraint-${String(index + 1)}`,
    description: constraint.polarity === 'forbid'
      ? `The shipped product avoids the prohibited choice recorded in constraint ${String(index + 1)}.`
      : `The shipped product demonstrably satisfies the requested outcome recorded in constraint ${String(index + 1)}.`,
    constraintIds: [constraint.id]
  }))
  checks.push(
    {
      id: 'acceptance-primary-journey',
      description: 'A representative user can complete the primary journey from entry to a meaningful result.',
      constraintIds: []
    },
    {
      id: 'acceptance-runtime',
      description: 'The documented launch path starts the actual generated product without console-blocking errors.',
      constraintIds: []
    },
    {
      id: 'acceptance-quality',
      description: 'The final visual and interaction pass is intentional, readable, responsive, and non-generic.',
      constraintIds: []
    }
  )
  return checks.slice(0, MAX_ACCEPTANCE_CHECKS)
}

export function compileQualityBrief(input: {
  humanBrief: string
  missionProfile?: MissionProfile
}): CompiledQualityBrief {
  const bindingBrief = normalizedText(input.humanBrief)
  if (!bindingBrief) throw new Error('A quality brief requires a non-empty human prompt.')
  const missionProfile = input.missionProfile ?? 'surprise'
  const hardConstraints = compileConstraints(bindingBrief)
  const checks = acceptanceChecks(hardConstraints)
  const bar = qualityBar()
  return {
    version: 1,
    missionProfile,
    fingerprint: createHash('sha256').update(`${missionProfile}\0${bindingBrief}`, 'utf8').digest('hex'),
    privateContract: {
      bindingBrief,
      hardConstraints,
      qualityBar: bar,
      acceptanceChecks: checks
    },
    publicContract: {
      summary: 'A private quality contract is sealed with explicit constraints and acceptance checks.',
      hardConstraintCount: hardConstraints.length,
      acceptanceCheckCount: checks.length,
      qualityDimensionCount: bar.length
    }
  }
}

function consensusTerms(input: ConsensusQualityInput): Set<string> {
  return new Set(meaningfulTerms([input.appName, input.idea, input.summary, input.spec].join('\n')))
}

function forbiddenTermIsAffirmative(term: string, input: ConsensusQualityInput): boolean {
  const text = normalizedText([input.idea, input.summary, input.spec].join(' ')).toLocaleLowerCase()
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const matches = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, 'giu'))]
  return matches.some((match) => {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 120), match.index)
    const activeClause = prefix.split(/[.!?;]|\b(?:but|however|instead|yet)\b/iu).at(-1) ?? prefix
    return !RESTRICTION_PATTERN.test(activeClause)
  })
}

export function assessConsensusAgainstQualityBrief(
  brief: CompiledQualityBrief,
  consensus: ConsensusQualityInput
): ConsensusQualityAssessment {
  const terms = consensusTerms(consensus)
  const violations: string[] = []
  const coveredConstraintIds: string[] = []
  for (const constraint of brief.privateContract.hardConstraints) {
    if (constraint.polarity === 'forbid') {
      const violated = constraint.coverageTerms.some((term) => forbiddenTermIsAffirmative(term, consensus))
      if (violated) {
        violations.push(`Consensus conflicts with hard constraint ${constraint.id}.`)
      } else {
        coveredConstraintIds.push(constraint.id)
      }
      continue
    }

    const matched = constraint.coverageTerms.filter((term) => terms.has(term)).length
    const required = Math.min(3, Math.max(1, Math.ceil(constraint.coverageTerms.length * 0.4)))
    if (matched < required) {
      violations.push(`Consensus does not preserve human-brief constraint ${constraint.id}.`)
    } else {
      coveredConstraintIds.push(constraint.id)
    }
  }
  return { valid: violations.length === 0, violations, coveredConstraintIds }
}

export function formatQualityBriefForAgent(brief: CompiledQualityBrief): string {
  const constraints = brief.privateContract.hardConstraints
    .map((constraint, index) => `${String(index + 1)}. [${constraint.polarity.toUpperCase()}] ${constraint.sourceText}`)
    .join('\n')
  const quality = brief.privateContract.qualityBar.map((item) => `- ${item}`).join('\n')
  // Constraint-specific acceptance lines merely restate the numbered hard
  // constraints. Keep them in the sealed machine contract, but do not repay
  // their tokens on every provider turn.
  const checks = brief.privateContract.acceptanceChecks
    .filter((item) => item.constraintIds.length === 0)
    .map((item) => `- ${item.description}`)
    .join('\n')
  return `QUALITY CONTRACT (private; binding)\nFingerprint: ${brief.fingerprint}\n\nHard constraints\n${constraints}\n\nQuality bar\n${quality}\n\nAcceptance checks\n${checks}\n\nDo not replace a hard constraint. Improve the solution inside this contract and prove the checks before declaring completion.`
}

/**
 * Post-consensus source work receives an immutable baton instead of repaying
 * the human prompt and full quality rubric on every provider call. Constraint
 * descriptions remain explicit so an opaque identifier can never hide a hard
 * requirement; the sealed JSON remains the exact source of truth.
 */
export function formatQualityBriefBatonForAgent(brief: CompiledQualityBrief): string {
  const constraints = brief.privateContract.hardConstraints
    .map((constraint) => `${constraint.id} [${constraint.polarity.toUpperCase()}] ${constraint.sourceText}`)
    .join('\n')
  return `SEALED QUALITY BATON (private; immutable)\nFingerprint: ${brief.fingerprint}\nExact contract: .duo/sealed/quality_brief.json\nSealed decision: .duo/sealed/spec.md\n\nBinding constraints\n${constraints}\n\nPreserve every ID above. Use the sealed files for exact detail and prove the current task's acceptance checks before handoff.`
}
