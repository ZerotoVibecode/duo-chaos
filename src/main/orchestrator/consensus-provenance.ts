import { createHash } from 'node:crypto'

const EXPLICIT_NAME_CORRECTION_PATTERN = /(?:^|[\r\n.!?]\s*)(?:(?:no|now)\s*[,;:]?\s*)?(?:actually\s+)?(?:choose|use|pick)\s+(?:your\s+own|a\s+new|another|the\s+final)\s+name\b|(?:^|[\r\n.!?]\s*)(?:rename|change)\s+(?:it|the\s+(?:app|product|project|website|site|tool|experience)(?:\s+name)?)\b.{0,60}\blater\b/imu
const IMPLICIT_NAME_AMBIGUITY_PATTERN = /\b(?:codename|placeholder|provisional(?:ly)?|rename|subject\s+to\s+change|tentative(?:ly)?|temporary|working\s+title)\b|\bfor\s+now\b/iu
const NAMING_CONTEXT_PATTERN = /\b(?:call|called|codename|name|named|rename|title)\b/iu

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
  selectionMode?: 'pitch-title' | 'human-named-synthesis'
  namingEvidenceFingerprint?: string
  pitchCatalogFingerprint?: string
  sourceSelectionFingerprint?: string
  pitchRoundCutoff?: number
}

function normalizedTitle(value: string): string {
  const base = value.trim().match(/^(.*?)(?:\s*[([{]|\s+(?:—|–|-|\||·)\s+|:\s+)/u)?.[1]?.trim() || value.trim()
  return base.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ')
}

function normalizedWords(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ')
}

function namingEvidenceFingerprint(qualityBriefFingerprint: string, appName: string): string {
  return createHash('sha256')
    .update([qualityBriefFingerprint, normalizedWords(appName), 'human-named-synthesis'].join('\0'), 'utf8')
    .digest('hex')
}

function hasAmbiguousNamingInstruction(humanBrief: string, normalizedAppName: string): boolean {
  return humanBrief
    .split(/\r?\n|(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .some((sentence) => {
      if (!IMPLICIT_NAME_AMBIGUITY_PATTERN.test(sentence)) return false
      const normalizedSentence = normalizedWords(sentence)
      return NAMING_CONTEXT_PATTERN.test(sentence) ||
        normalizedSentence.startsWith(normalizedAppName) ||
        (/\bfor\s+now\b/iu.test(sentence) && normalizedSentence.includes(normalizedAppName))
    })
}

function catalogFingerprint(pitches: PitchProvenanceRecord[]): string {
  const material = pitches
    .map((pitch) => ({
      pitchId: pitch.pitchId,
      runId: pitch.runId,
      round: pitch.round,
      agent: pitch.agent,
      title: pitch.title,
      idea: pitch.idea,
      appeal: pitch.appeal,
      risk: pitch.risk
    }))
    .sort((left, right) => left.pitchId.localeCompare(right.pitchId))
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex')
}

function selectionFingerprint(pitchCatalogFingerprint: string, selectedPitchIds: string[]): string {
  return createHash('sha256')
    .update([pitchCatalogFingerprint, ...selectedPitchIds].join('\0'), 'utf8')
    .digest('hex')
}

function explicitProductNames(humanBrief: string): string[] {
  if (EXPLICIT_NAME_CORRECTION_PATTERN.test(humanBrief)) return []
  const ambiguousNamingClause = /\b(?:codename|never\s+mind|provisional(?:ly)?|tentative(?:ly)?|temporary|placeholder|working\s+title)\b|\bfor\s+now\b|\bsubject\s+to\s+change\b|\bunless\b|\bno\s*[,;:]/iu
  const names: string[] = []
  const clauses = [
    /^(?:(?:please)\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+)?(?:build|create|make|design|deliver)\b.{0,180}?\b(?:app|product|project|website|site|tool|experience)\s+(?:called|named)\s+/iu,
    /^(?:(?:please)\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+)?(?:build|create|make|design|deliver)\b.{0,180}?\band\s+(?:call|name)\s+it\s+/iu,
    /^(?:this|the)\s+(?:app|product|project|website|site|tool|experience)\s+(?:is|must\s+be)\s+(?:called|named)\s+/iu,
    /^(?:app|product|project|website|site|tool|experience)\s+name\s*(?:(?:is|must\s+be)\s+|:\s*)/iu,
    /^(?:call|name)\s+it\s+/iu
  ]
  let previousLine = ''
  // Inspect sentence boundaries as well as line boundaries so a later
  // explicit correction on the same line outranks an implicit opening title.
  for (const sourceLine of humanBrief.split(/\r?\n|(?<=[.!?])\s+/u)) {
    const line = sourceLine.trim()
    const isExampleBlock = /(?:^|[.!?]\s*)(?:for\s+)?example(?:\s+(?:prompt|request|brief|input|project))?\s*:\s*$/iu.test(previousLine)
    for (const clause of clauses) {
      const match = line.match(clause)
      if (!match) continue
      const sentenceEnd = line.slice(match[0].length).search(/[.!?]/u)
      const namingClause = sentenceEnd < 0
        ? line
        : line.slice(0, match[0].length + sentenceEnd + 1)
      if (isExampleBlock || ambiguousNamingClause.test(namingClause)) continue
      const tail = line.slice(match[0].length).trimStart()
      const quoted = tail.match(/^(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)/u)
      let candidate = quoted
        ? quoted.slice(1).find((value): value is string => Boolean(value))
        : tail.split(/(?:[,.;:!?\r\n]|\s+(?:that|which|with|while|where|so)\b|\s+and\s+(?:build|make|include|add|ensure|keep|use)\b)/iu, 1)[0]
      if (!quoted && candidate) {
        // Preserve title-like connectors ("Focus for Creators") while a
        // lower-case audience clause ("Signal Garden for content creators")
        // remains outside the product name. Ambiguous all-lowercase text is
        // deliberately conservative and will not bind a shorter appName.
        const audienceBoundary = candidate.search(/\s+for\s+(?=\p{Ll})/u)
        if (audienceBoundary >= 0) candidate = candidate.slice(0, audienceBoundary)
      }
      const normalized = normalizedWords(candidate ?? '')
      if (normalized) names.push(normalized)
    }
    if (line) previousLine = line
  }
  return [...new Set(names)]
}

function briefExplicitlyNamesProduct(humanBrief: string | undefined, appName: string): boolean {
  if (!humanBrief?.trim()) return false
  const name = normalizedWords(appName)
  if (!name || new Set(['app', 'product', 'project', 'website', 'site', 'tool', 'local']).has(name)) return false
  const names = explicitProductNames(humanBrief)
  if (names.length > 0) return names.length === 1 && names[0] === name
  if (EXPLICIT_NAME_CORRECTION_PATTERN.test(humanBrief) || hasAmbiguousNamingInstruction(humanBrief, name)) return false

  // Product briefs often use the requested name as the final noun phrase
  // without saying "called" (for example, "Build a polished single-page
  // Decision Deck"). Accept only the exact phrase after the final product-
  // shape word in a direct opening instruction. This distinguishes
  // "Decision Deck" from arbitrary suffixes such as "Deck", and it refuses
  // audience clauses such as "an app for content creators".
  const firstSentence = humanBrief.trim().split(/[.!?\r\n]/u, 1)[0]?.trim() ?? ''
  const directBuildPattern = /^(?:(?:please)\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+)?(?:build|create|make|design|deliver)\b\s*/iu
  const directBuild = firstSentence.match(directBuildPattern)
  const isAmbiguous = /\b(?:called|codename|example|formerly|inspired\s+by|named|placeholder|provisional(?:ly)?|rename|subject\s+to\s+change|working\s+title)\b|\bfor\s+now\b/iu.test(firstSentence)
  const instructionBody = directBuild ? firstSentence.slice(directBuild[0].length) : ''
  const sentenceWords = instructionBody.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu) ?? []
  const productShapes = new Set([
    'app', 'application', 'browser', 'dashboard', 'desktop', 'experience',
    'page', 'product', 'site', 'tool', 'website', 'workflow'
  ])
  const hasProductShape = sentenceWords.some((word) =>
    normalizedWords(word).split(' ').some((part) => productShapes.has(part))
  )
  const titleConnector = new Set(['and', 'for', 'of', 'the', 'to', 'vs'])
  const isTitleWord = (word: string): boolean => /^(?:\p{Lu}[\p{L}\p{N}'\u2019-]*|\p{N}[\p{L}\p{N}'\u2019-]*)$/u.test(word)
  let titleStart = sentenceWords.length
  let sawTitleWord = false
  for (let index = sentenceWords.length - 1; index >= 0; index -= 1) {
    const word = sentenceWords[index]!
    if (isTitleWord(word)) {
      titleStart = index
      sawTitleWord = true
      continue
    }
    const normalized = normalizedWords(word)
    if (
      sawTitleWord &&
      titleConnector.has(normalized) &&
      index > 0 &&
      isTitleWord(sentenceWords[index - 1]!)
    ) {
      titleStart = index
      continue
    }
    break
  }
  const precedingWord = titleStart > 0 ? normalizedWords(sentenceWords[titleStart - 1]!) : ''
  const audienceConnector = new Set([
    'at', 'by', 'for', 'helping', 'serving', 'targeting', 'that', 'used',
    'using', 'where', 'which', 'with'
  ])
  const impliedTitleWords = sentenceWords.slice(titleStart)
  const titleContainsProductShape = impliedTitleWords.some((word) =>
    normalizedWords(word).split(' ').some((part) => productShapes.has(part))
  )
  const precedingContainsProductShape = precedingWord.split(' ').some((part) => productShapes.has(part))
  const anchoredToProductShape = titleContainsProductShape || precedingContainsProductShape
  const impliedName = sawTitleWord && !audienceConnector.has(precedingWord)
    ? normalizedWords(impliedTitleWords.join(' '))
    : ''
  return Boolean(directBuild) && hasProductShape && anchoredToProductShape && !isAmbiguous && impliedName === name
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
  humanBrief?: string
  qualityBriefFingerprint: string
  selectedSourcePitchIds?: string[]
  pitches: PitchProvenanceRecord[]
}): ConsensusProvenanceRecord | undefined {
  const expectedTitle = normalizedTitle(input.appName)
  const runPitches = input.pitches.filter((pitch) => pitch.runId === input.runId)
  const exactMatches = runPitches.filter((pitch) => normalizedTitle(pitch.title) === expectedTitle)
  const selectedIds = input.selectedSourcePitchIds ?? []
  const uniqueSelectedIds = [...new Set(selectedIds)]
  if (selectedIds.length !== uniqueSelectedIds.length || selectedIds.length > 2) return undefined
  const selectedPitches = uniqueSelectedIds.map((pitchId) => runPitches.find((pitch) => pitch.pitchId === pitchId))
  if (selectedPitches.some((pitch) => !pitch)) return undefined

  const fixedHumanName = briefExplicitlyNamesProduct(input.humanBrief, input.appName)
  const selectedRecords = selectedPitches as PitchProvenanceRecord[]
  const selectedAllMatchName = selectedRecords.length > 0 &&
    selectedRecords.every((pitch) => normalizedTitle(pitch.title) === expectedTitle)
  const humanNamedSelection = fixedHumanName &&
    new Set(runPitches.map((pitch) => pitch.agent)).size === 2 &&
    selectedRecords.length > 0 &&
    (exactMatches.length === 0 || !selectedAllMatchName)
  // Exact-title records remain backward compatible: older capsules did not
  // carry an explicit selection, yet the title itself identifies the source.
  // A human-fixed name has no such identity. An explicit selection that mixes
  // an exact-title pitch with a differently named teammate pitch is therefore
  // a named synthesis, not a forged exact-title attribution.
  const matches = humanNamedSelection
    ? selectedRecords
    : exactMatches.length > 0
    ? uniqueSelectedIds.length > 0
      ? selectedAllMatchName
        ? selectedRecords
        : []
      : exactMatches
    : []
  if (matches.length === 0) return undefined
  const selectionMode = humanNamedSelection ? 'human-named-synthesis' : 'pitch-title'
  const pitchRoundCutoff = selectionMode === 'human-named-synthesis'
    ? Math.max(...runPitches.map((pitch) => pitch.round))
    : Math.max(...matches.map((pitch) => pitch.round))
  const frozenCatalog = runPitches.filter((pitch) => pitch.round <= pitchRoundCutoff)
  const pitchCatalogFingerprint = catalogFingerprint(frozenCatalog)
  return {
    version: 1,
    runId: input.runId,
    consensusAppName: input.appName,
    sourcePitchIds: [...new Set(matches.map((pitch) => pitch.pitchId))],
    sourceAgents: [...new Set(matches.map((pitch) => pitch.agent))],
    sourceRounds: [...new Set(matches.map((pitch) => pitch.round))],
    qualityBriefFingerprint: input.qualityBriefFingerprint,
    selectionMode,
    pitchRoundCutoff,
    ...(selectionMode === 'human-named-synthesis' && input.humanBrief
      ? {
          namingEvidenceFingerprint: namingEvidenceFingerprint(input.qualityBriefFingerprint, input.appName),
          pitchCatalogFingerprint,
          sourceSelectionFingerprint: selectionFingerprint(
            pitchCatalogFingerprint,
            matches.map((pitch) => pitch.pitchId)
          )
        }
      : {})
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
  humanBrief?: string
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
    ...(input.humanBrief ? { humanBrief: input.humanBrief } : {}),
    qualityBriefFingerprint: input.qualityBriefFingerprint,
    selectedSourcePitchIds: input.record.sourcePitchIds,
    pitches: input.record.pitchRoundCutoff === undefined
      ? input.immutablePitches
      : input.immutablePitches.filter((pitch) => pitch.round <= input.record.pitchRoundCutoff!)
  })
  return Boolean(expected) &&
    (input.record.pitchRoundCutoff === undefined || input.record.pitchRoundCutoff === expected!.pitchRoundCutoff) &&
    (input.record.selectionMode ?? 'pitch-title') === expected!.selectionMode &&
    (expected!.selectionMode !== 'human-named-synthesis' ||
      input.record.namingEvidenceFingerprint === expected!.namingEvidenceFingerprint &&
      input.record.pitchCatalogFingerprint === expected!.pitchCatalogFingerprint &&
      input.record.sourceSelectionFingerprint === expected!.sourceSelectionFingerprint) &&
    sameSet(input.record.sourcePitchIds, expected!.sourcePitchIds) &&
    sameSet(input.record.sourceAgents, expected!.sourceAgents) &&
    sameSet(input.record.sourceRounds, expected!.sourceRounds)
}
