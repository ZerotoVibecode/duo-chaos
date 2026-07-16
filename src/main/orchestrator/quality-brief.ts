import { createHash } from 'node:crypto'
import type { MissionProfile } from '@shared/types'

const MAX_CONSTRAINTS = 12
const MAX_ACCEPTANCE_CHECKS = 14
const MAX_SOURCE_TEXT = 280

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'be', 'build', 'by', 'create', 'creating', 'do', 'for', 'from',
  'fully', 'have', 'i', 'in', 'into', 'is', 'it', 'make', 'me', 'of', 'on', 'or', 'please', 'run', 'should', 'something',
  'that', 'the', 'their', 'them', 'this', 'to', 'tool', 'using', 'very', 'want', 'we', 'website', 'with', 'you'
])

const PROCESS_ONLY_PATTERN = /\b(?:agent|argue|challenge weak|claude|codex|debate|decide everything|do not reveal|final reviewer|preserved source|reveal only|routine dialogue|secret|spoiler|yourselves)\b/iu
const PRODUCT_SIGNAL_PATTERN = /\b(?:accessible|app|audience|browser|content|creator|dashboard|desktop|for\s+\p{L}|local|locally|offline|platform|responsive|tool|useful|website|workflow)\b/iu
const RESTRICTION_PATTERN = /\b(?:avoid|cannot|can't|do not|does not|don't|is not|are not|lacks?|must not|never|no|omits?|without)\b/iu
const RESTRICTION_PREFIX_PATTERN = /^(?:avoid|cannot|can't|do not|does not|don't|is not|are not|lacks?|must not|never|no|omits?|without)\b\s*/iu
const RESTRICTION_CONTROL_TERMS = new Set([
  'add', 'allow', 'avoid', 'cannot', 'disable', 'do', 'does', 'don', 'dont', 'enable', 'include', 'lack', 'must',
  'never', 'no', 'not', 'omit', 'require', 'use', 'without',
  // These layout nouns are too generic to prove a prohibited state by
  // themselves (for example, "primary controls work" must not be read as
  // affirming "clipped primary controls"). Keep the failure-bearing terms.
  'primary', 'control', 'pagelevel'
])

export interface QualityBriefConstraint {
  id: string
  kind: 'required-outcome' | 'audience' | 'platform' | 'capability' | 'restriction'
  polarity: 'require' | 'forbid'
  sourceText: string
  coverageTerms: string[]
  /**
   * Alternative prohibited phrases derived from a restriction list. Every
   * term inside one group must be affirmed before that phrase is considered a
   * violation; any complete group is enough to reject the consensus.
   *
   * Example: "without clipped controls or horizontal overflow" becomes
   * [["clipped"], ["horizontal", "overflow"]]. This keeps an unrelated
   * positive use of "overflow" from becoming a false violation.
   */
  coverageGroups?: string[][]
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
  const expanded = terms.flatMap((term) => term.includes('-') ? [term, ...term.split('-')] : [term])
  return [...new Set(expanded.map(normalizedTerm).filter((term) => term.length >= 3 && !STOP_WORDS.has(term)))]
}

function sourceSegments(humanBrief: string): string[] {
  const normalized = humanBrief
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/^\s*[-*\d.)]+\s*/gmu, '')
  return normalized
    .split(/(?:\n+|[.!?;]+|,\s+(?=(?:(?:but|and)\s+)?(?:add|allow|be|display|enable|ensure|feel|function|functions|has|have|include|keep|must|need|needs|offer|operate|operates|persist|preserve|provide|remain|require|requires|run|runs|should|support|supports|use|with|work|works)\b)|\s+and\s+(?=(?:it\s+)?(?:must|needs?|should|works?|feels?|has|supports?)\b))/giu)
    .map(normalizedText)
    .filter((segment) => segment.length >= 3)
}

interface SplitConstraintSegment {
  text: string
  forceBind: boolean
  processOnly: boolean
}

function splitMixedRestriction(segment: string): SplitConstraintSegment[] {
  const processOnly = isProcessOnlySegment(segment)
  const offlineRequirement = /\b(?:work|works|run|runs|operate|operates|function|functions)\s+without\s+(?:an?\s+)?(?:internet|network)(?:\s+connection)?\b/iu
  const offlineMatch = segment.match(offlineRequirement)
  let normalizedSegment = segment
  if (offlineMatch?.index !== undefined) {
    const verb = offlineMatch[0].match(/^\w+/u)?.[0] ?? 'work'
    const before = segment.slice(0, offlineMatch.index)
    const after = segment.slice(offlineMatch.index + offlineMatch[0].length)
    const offlineSegment = normalizedText(`${before}${verb} offline`)
    const siblingClause = after.match(/^\s*(,\s*)?(?:(and|or|nor)\s+|(as\s+well\s+as)\s+)?(.+)$/iu)
    if (after.trim() && siblingClause) {
      const hasLeadingComma = Boolean(siblingClause[1])
      const connector = normalizedText(siblingClause[2] ?? siblingClause[3] ?? '').toLocaleLowerCase()
      const sibling = siblingClause[4]!.trim()
      const startsRestriction = sibling.search(RESTRICTION_PATTERN) === 0
      const inheritsNegativeScope = connector === 'or' || connector === 'nor' || connector === 'as well as' ||
        (hasLeadingComma && /,\s*(?:and|or|nor)\b/iu.test(sibling))
      if (!startsRestriction && !inheritsNegativeScope) {
        return [
          { text: offlineSegment, forceBind: true, processOnly },
          { text: normalizedText(sibling), forceBind: true, processOnly }
        ]
      }
      normalizedSegment = normalizedText(
        `${offlineSegment} and ${startsRestriction ? sibling : `without ${sibling}`}`
      )
    } else {
      normalizedSegment = offlineSegment
    }
  }
  const marker = normalizedSegment.search(RESTRICTION_PATTERN)
  if (marker <= 0) return [{ text: normalizedSegment, forceBind: false, processOnly }]
  const positive = normalizedText(
    normalizedSegment.slice(0, marker).replace(/\b(?:and|but|or|with)\s*$/iu, '')
  )
  const restriction = normalizedText(normalizedSegment.slice(marker))
  // A sentence such as "fit cleanly ... without clipped controls" contains
  // two independent contracts. Treating the whole sentence as a prohibition
  // makes the positive requirement contradict itself at consensus time.
  return meaningfulTerms(positive).length >= 1 && meaningfulTerms(restriction).length >= 1
      ? [
        { text: positive, forceBind: true, processOnly },
        { text: restriction, forceBind: true, processOnly }
      ]
    : [{ text: normalizedSegment, forceBind: false, processOnly }]
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

function restrictionCoverageGroups(segment: string): string[][] {
  const marker = segment.search(RESTRICTION_PATTERN)
  const restriction = normalizedText(marker >= 0 ? segment.slice(marker) : segment)
    .replace(RESTRICTION_PREFIX_PATTERN, '')
  const groups = restriction
    .split(/\s*,\s*|\s+\b(?:and|or)\b\s+/giu)
    .map((item) => meaningfulTerms(item).filter((term) => !RESTRICTION_CONTROL_TERMS.has(term)))
    .filter((terms) => terms.length > 0)
  return groups.length > 0 ? groups : [restrictionTerms(segment)]
}

function shouldBindSegment(segment: string, index: number): boolean {
  if (isProcessOnlySegment(segment)) return false
  if (index === 0) return true
  return PRODUCT_SIGNAL_PATTERN.test(segment) ||
    /\b(?:accessible|add|allow|display|enable|feel|include|input|keyboard|must|need|offer|persist|preserve|provide|remain|require|should|support|use|with|work|without|avoid|never|no)\b/iu.test(segment)
}

function isProcessOnlySegment(segment: string): boolean {
  return PROCESS_ONLY_PATTERN.test(segment) && !PRODUCT_SIGNAL_PATTERN.test(segment)
}

function constraintId(index: number, sourceText: string): string {
  const hash = createHash('sha256').update(sourceText, 'utf8').digest('hex').slice(0, 10)
  return `constraint-${String(index + 1)}-${hash}`
}

function compileConstraints(humanBrief: string): QualityBriefConstraint[] {
  const constraints: QualityBriefConstraint[] = []
  const segments = sourceSegments(humanBrief).flatMap(splitMixedRestriction)
  for (const [index, candidate] of segments.entries()) {
    const segment = candidate.text
    // Restriction splitting marks both halves as force-bound. That must not
    // turn instructions about how Duo should run into requirements for the
    // generated product (for example, "debate ... without Max effort").
    if (candidate.processOnly || isProcessOnlySegment(segment)) continue
    if (!candidate.forceBind && !shouldBindSegment(segment, index)) continue
    const polarity = RESTRICTION_PATTERN.test(segment) ? 'forbid' as const : 'require' as const
    const coverageGroups = polarity === 'forbid' ? restrictionCoverageGroups(segment) : undefined
    const coverageTerms = polarity === 'forbid'
      ? [...new Set((coverageGroups ?? []).flat())]
      : meaningfulTerms(segment)
    if (coverageTerms.length === 0) continue
    constraints.push({
      id: constraintId(constraints.length, segment),
      kind: constraintKind(segment),
      polarity,
      sourceText: segment.slice(0, MAX_SOURCE_TEXT),
      coverageTerms: coverageTerms.slice(0, 12),
      ...(coverageGroups
        ? { coverageGroups: coverageGroups.slice(0, 12).map((group) => group.slice(0, 12)) }
        : {})
    })
    if (constraints.length >= MAX_CONSTRAINTS) break
  }

  if (constraints.length === 0) {
    const fallback = normalizedText(humanBrief).slice(0, MAX_SOURCE_TEXT)
    // A purely orchestration-facing brief intentionally has no generated-app
    // hard constraints. The generic quality bar and acceptance checks still
    // apply; copying the process instruction into the product contract would
    // create an impossible consensus and waste a recovery turn.
    if (!isProcessOnlySegment(fallback)) {
      constraints.push({
        id: constraintId(0, fallback),
        kind: 'required-outcome',
        polarity: 'require',
        sourceText: fallback,
        coverageTerms: meaningfulTerms(fallback).slice(0, 12)
      })
    }
  }
  return constraints
}

function qualityBar(): string[] {
  return [
    'The product has a distinctive, intentional direction instead of a generic template.',
    'The primary user journey is complete, understandable, and useful for its stated audience.',
    'The result is readable in compact and full-screen desktop layouts and accessible through keyboard-safe controls where interaction exists. Mobile layout is required only when the human brief asks for it.',
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
      description: 'The final visual and interaction pass is intentional, non-generic, and readable in compact and full-screen desktop layouts; mobile is required only when requested.',
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

function affirmativeConsensusClauses(input: ConsensusQualityInput): Array<Set<string>> {
  return [input.appName, input.idea, input.summary, input.spec]
    .join('\n')
    .split(/(?:\r?\n+|[.!?;]+|\b(?:and|but|however|instead|yet|while)\b)/giu)
    .map(normalizedText)
    .filter((clause) => clause.length > 0 && !RESTRICTION_PATTERN.test(clause))
    .map((clause) => new Set(meaningfulTerms(clause)))
}

function forbiddenGroupIsAffirmative(
  group: string[],
  clauses: Array<Set<string>>
): boolean {
  const terms = [...new Set(group.map(normalizedTerm).filter((term) => term.length >= 3))]
  return terms.length > 0 && clauses.some((clause) => terms.every((term) => clause.has(term)))
}

export function assessConsensusAgainstQualityBrief(
  brief: CompiledQualityBrief,
  consensus: ConsensusQualityInput
): ConsensusQualityAssessment {
  const affirmativeClauses = affirmativeConsensusClauses(consensus)
  const affirmativeTerms = new Set([...affirmativeClauses].flatMap((clause) => [...clause]))
  const violations: string[] = []
  const coveredConstraintIds: string[] = []
  for (const constraint of brief.privateContract.hardConstraints) {
    if (constraint.polarity === 'forbid') {
      const groups = constraint.coverageGroups?.filter((group) => group.length > 0)
      const violated = groups && groups.length > 0
        ? groups.some((group) => forbiddenGroupIsAffirmative(group, affirmativeClauses))
        : constraint.coverageTerms.some((term) => forbiddenGroupIsAffirmative([term], affirmativeClauses))
      if (violated) {
        violations.push(`Consensus conflicts with hard constraint ${constraint.id}.`)
      } else {
        coveredConstraintIds.push(constraint.id)
      }
      continue
    }

    const matched = constraint.coverageTerms.filter((term) => affirmativeTerms.has(term)).length
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
    .map((constraint, index) => `${String(index + 1)}. [${constraint.polarity.toUpperCase()}] ${constraintPromptText(constraint)}`)
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
    .map((constraint) => `${constraint.id} [${constraint.polarity.toUpperCase()}] ${constraintPromptText(constraint)}`)
    .join('\n')
  return `SEALED QUALITY BATON (private; immutable)\nFingerprint: ${brief.fingerprint}\nExact contract: .duo/sealed/quality_brief.json\nSealed decision: .duo/sealed/spec.md\n\nBinding constraints\n${constraints}\n\nPreserve every ID above. Use the sealed files for exact detail and prove the current task's acceptance checks before handoff.`
}

function constraintPromptText(constraint: QualityBriefConstraint): string {
  if (constraint.polarity !== 'forbid') return constraint.sourceText
  const affirmativeProhibition = normalizedText(
    constraint.sourceText.replace(RESTRICTION_PREFIX_PATTERN, '')
  )
  return affirmativeProhibition || constraint.sourceText
}
