import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { safeReadProtocolText, safeWriteProtocolText } from './safe-protocol-files'

interface SeriousMissionContract {
  version: 1
  missionProfile: 'serious'
  brief: string
  briefFingerprint: string
  createdAt: string
  specificationFingerprint?: string
  acceptanceChecks?: string[]
  coveredBriefTerms?: string[]
}

interface SeriousMissionGuard {
  version: 1
  missionProfile: 'serious'
  briefFingerprint: string
  createdAt: string
  specificationFingerprint?: string
  acceptanceChecks?: string[]
  coveredBriefTerms?: string[]
  sealedAt?: string
}

export interface SeriousSpecificationEvidence {
  acceptanceChecks: string[]
  coveredBriefTerms: string[]
  requiredBriefTermCount: number
  valid: boolean
}

const BRIEF_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'app', 'build', 'create', 'for', 'from', 'have',
  'into', 'make', 'must', 'that', 'the', 'their', 'this', 'through', 'using', 'want',
  'where', 'which', 'with', 'without', 'you', 'your'
])

export function seriousBriefFingerprint(brief: string): string {
  return createHash('sha256').update(brief.trim(), 'utf8').digest('hex')
}

function humanBriefDocument(brief: string, fingerprint: string): string {
  return `# Binding human brief\n\nBrief fingerprint: \`${fingerprint}\`\n\n${brief.trim()}\n`
}

export function bindSeriousSpecification(brief: string, agentSpecification: string): string {
  const normalizedBrief = brief.trim()
  const fingerprint = seriousBriefFingerprint(normalizedBrief)
  return `# Sealed product specification\n\n## Binding human brief\n\nBrief fingerprint: \`${fingerprint}\`\n\n${normalizedBrief}\n\n## Agent-authored implementation and acceptance plan\n\n${agentSpecification.trim()}\n`
}

function normalizedTerms(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function meaningfulBriefTerms(brief: string): string[] {
  return [...new Set(normalizedTerms(brief).filter((term) =>
    term.length >= 4 && !BRIEF_STOP_WORDS.has(term)
  ))]
}

function acceptanceHeadingIndex(agentSpecification: string): number {
  const pattern = /\bacceptance (?:checks|criteria)\s*:?[ \t]*(?=\r?\n|(?:[-*+]|\d+[.)])\s+)/giu
  for (const match of agentSpecification.matchAll(pattern)) {
    const index = match.index ?? -1
    if (index < 0) continue
    const prefix = agentSpecification.slice(0, index)
    const boundary = Math.max(
      prefix.lastIndexOf('\n'),
      prefix.lastIndexOf('.'),
      prefix.lastIndexOf('!'),
      prefix.lastIndexOf('?')
    )
    const headingPrefix = prefix.slice(boundary + 1).trim()
    if (/^(?:#{1,6}|[-*+>]|\*\*|__)?$/u.test(headingPrefix)) return index
  }
  return -1
}

export function analyzeSeriousAgentSpecification(
  brief: string,
  agentSpecification: string
): SeriousSpecificationEvidence {
  // Structured providers sometimes keep the heading at the end of the final
  // plan sentence ("... ready. Acceptance checks:") while still returning a
  // real bullet list on the following lines. Bind to the labeled list rather
  // than requiring Markdown line-start styling.
  const acceptanceHeading = acceptanceHeadingIndex(agentSpecification)
  const acceptanceBody = acceptanceHeading >= 0 ? agentSpecification.slice(acceptanceHeading) : ''
  const checklistBody = acceptanceBody
    .replace(/^acceptance (?:checks|criteria)\s*:?[ \t]*/iu, '')
    .trim()
  const acceptanceChecks = checklistBody
    .split(/(?:\r?\n|\s+)(?=(?:[-*+]|\d+[.)])\s+)/u)
    .flatMap((line) => {
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+\S)\s*$/u)
    const value = match?.[1]?.trim()
    return value && value.length >= 12 ? [value] : []
  }).slice(0, 24)
  const briefTerms = meaningfulBriefTerms(brief)
  // Requirement coverage is counted only inside the actual acceptance checks.
  // A prose sentence such as "we will not implement CSV" cannot satisfy the
  // binding merely by repeating a noun from the human brief.
  const acceptanceTerms = new Set(normalizedTerms(acceptanceChecks.join('\n')))
  const coveredBriefTerms = briefTerms.filter((term) => acceptanceTerms.has(term))
  const requiredBriefTermCount = briefTerms.length === 0
    ? 0
    : Math.min(3, Math.max(1, Math.ceil(briefTerms.length * 0.25)))
  return {
    acceptanceChecks,
    coveredBriefTerms,
    requiredBriefTermCount,
    valid: agentSpecification.trim().length >= 120 &&
      acceptanceChecks.length >= 2 &&
      coveredBriefTerms.length >= requiredBriefTermCount
  }
}

function specificationFingerprint(specification: string): string {
  return createHash('sha256').update(specification, 'utf8').digest('hex')
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function sealSeriousMissionSpecification(
  sealedPath: string,
  brief: string,
  agentSpecification: string
): Promise<string> {
  const normalizedBrief = brief.trim()
  const expectedBriefFingerprint = seriousBriefFingerprint(normalizedBrief)
  const evidence = analyzeSeriousAgentSpecification(normalizedBrief, agentSpecification)
  if (!evidence.valid) {
    throw new Error('A serious mission requires a detailed implementation plan with at least two testable acceptance checks anchored to the human brief.')
  }
  const protocolRoot = dirname(sealedPath)
  const rawContractText = await safeReadProtocolText(protocolRoot, join(sealedPath, 'serious_contract.json'))
  if (!rawContractText) throw new Error('The serious mission binding is missing.')
  const rawContract = JSON.parse(rawContractText) as Partial<SeriousMissionContract>
  if (
    rawContract.version !== 1 ||
    rawContract.missionProfile !== 'serious' ||
    rawContract.brief !== normalizedBrief ||
    rawContract.briefFingerprint !== expectedBriefFingerprint
  ) {
    throw new Error('The serious mission binding no longer matches the original human brief.')
  }
  const specification = bindSeriousSpecification(normalizedBrief, agentSpecification)
  const updated: SeriousMissionContract = {
    ...rawContract,
    version: 1,
    missionProfile: 'serious',
    brief: normalizedBrief,
    briefFingerprint: expectedBriefFingerprint,
    createdAt: rawContract.createdAt ?? new Date().toISOString(),
    specificationFingerprint: specificationFingerprint(specification),
    acceptanceChecks: evidence.acceptanceChecks,
    coveredBriefTerms: evidence.coveredBriefTerms
  }
  await safeWriteProtocolText(protocolRoot, join(sealedPath, 'spec.md'), specification)
  await safeWriteProtocolText(protocolRoot, join(sealedPath, 'serious_contract.json'), `${JSON.stringify(updated, null, 2)}\n`)
  return specification
}

export async function writeSeriousMissionContract(
  sealedPath: string,
  brief: string,
  createdAt = new Date().toISOString()
): Promise<void> {
  const normalizedBrief = brief.trim()
  const briefFingerprint = seriousBriefFingerprint(normalizedBrief)
  const contract: SeriousMissionContract = {
    version: 1,
    missionProfile: 'serious',
    brief: normalizedBrief,
    briefFingerprint,
    createdAt
  }
  await mkdir(sealedPath, { recursive: true })
  const protocolRoot = dirname(sealedPath)
  await Promise.all([
    safeWriteProtocolText(protocolRoot, join(sealedPath, 'serious_contract.json'), `${JSON.stringify(contract, null, 2)}\n`),
    safeWriteProtocolText(protocolRoot, join(sealedPath, 'human_brief.md'), humanBriefDocument(normalizedBrief, briefFingerprint))
  ])
}

export async function writeSeriousMissionGuard(
  runtimePath: string,
  brief: string,
  createdAt = new Date().toISOString()
): Promise<string> {
  const path = join(runtimePath, 'private', 'serious_mission_guard.json')
  const guard: SeriousMissionGuard = {
    version: 1,
    missionProfile: 'serious',
    briefFingerprint: seriousBriefFingerprint(brief),
    createdAt
  }
  await mkdir(join(runtimePath, 'private'), { recursive: true })
  await atomicWriteFile(path, `${JSON.stringify(guard, null, 2)}\n`)
  return path
}

export async function sealSeriousMissionGuard(
  runtimePath: string,
  sealedPath: string,
  brief: string,
  sealedAt = new Date().toISOString()
): Promise<string> {
  const guardPath = join(runtimePath, 'private', 'serious_mission_guard.json')
  const [rawGuard, rawContract, specification] = await Promise.all([
    readFile(guardPath, 'utf8'),
    safeReadProtocolText(dirname(sealedPath), join(sealedPath, 'serious_contract.json')),
    safeReadProtocolText(dirname(sealedPath), join(sealedPath, 'spec.md'))
  ])
  if (!rawContract || !specification) throw new Error('The serious workspace specification is missing.')
  const guard = JSON.parse(rawGuard) as Partial<SeriousMissionGuard>
  const contract = JSON.parse(rawContract) as Partial<SeriousMissionContract>
  const expectedBriefFingerprint = seriousBriefFingerprint(brief)
  const requiredBriefTermCount = meaningfulBriefTerms(brief).length === 0
    ? 0
    : Math.min(3, Math.max(1, Math.ceil(meaningfulBriefTerms(brief).length * 0.25)))
  if (
    guard.version !== 1 || guard.missionProfile !== 'serious' ||
    guard.briefFingerprint !== expectedBriefFingerprint ||
    contract.briefFingerprint !== expectedBriefFingerprint ||
    !contract.specificationFingerprint ||
    contract.specificationFingerprint !== specificationFingerprint(specification) ||
    !Array.isArray(contract.acceptanceChecks) || contract.acceptanceChecks.length < 2 ||
    !Array.isArray(contract.coveredBriefTerms) || contract.coveredBriefTerms.length < requiredBriefTermCount
  ) {
    throw new Error('The workspace specification could not be sealed into the supervisor serious-mission guard.')
  }
  const sealedGuard: SeriousMissionGuard = {
    version: 1,
    missionProfile: 'serious',
    briefFingerprint: expectedBriefFingerprint,
    createdAt: guard.createdAt ?? sealedAt,
    specificationFingerprint: contract.specificationFingerprint,
    acceptanceChecks: [...contract.acceptanceChecks],
    coveredBriefTerms: [...contract.coveredBriefTerms],
    sealedAt
  }
  await atomicWriteFile(guardPath, `${JSON.stringify(sealedGuard, null, 2)}\n`)
  return guardPath
}

export async function validateSeriousMissionContract(
  sealedPath: string,
  brief: string,
  supervisorGuardPath?: string
): Promise<boolean> {
  const normalizedBrief = brief.trim()
  const expectedFingerprint = seriousBriefFingerprint(normalizedBrief)
  try {
    const [rawContract, humanBrief, specification] = await Promise.all([
      safeReadProtocolText(dirname(sealedPath), join(sealedPath, 'serious_contract.json')),
      safeReadProtocolText(dirname(sealedPath), join(sealedPath, 'human_brief.md')),
      safeReadProtocolText(dirname(sealedPath), join(sealedPath, 'spec.md'))
    ])
    if (!rawContract || !humanBrief || !specification) return false
    const contract = JSON.parse(rawContract) as Partial<SeriousMissionContract>
    const marker = '## Agent-authored implementation and acceptance plan'
    const markerIndex = specification.indexOf(marker)
    const agentSpecification = markerIndex >= 0
      ? specification.slice(markerIndex + marker.length).trim()
      : ''
    const evidence = analyzeSeriousAgentSpecification(normalizedBrief, agentSpecification)
    const workspaceValid = contract.version === 1 &&
      contract.missionProfile === 'serious' &&
      contract.brief === normalizedBrief &&
      contract.briefFingerprint === expectedFingerprint &&
      humanBrief.includes(normalizedBrief) &&
      humanBrief.includes(expectedFingerprint) &&
      specification.includes(normalizedBrief) &&
      specification.includes(expectedFingerprint) &&
      markerIndex >= 0 &&
      evidence.valid &&
      contract.specificationFingerprint === specificationFingerprint(specification) &&
      JSON.stringify(contract.acceptanceChecks) === JSON.stringify(evidence.acceptanceChecks) &&
      JSON.stringify(contract.coveredBriefTerms) === JSON.stringify(evidence.coveredBriefTerms)
    if (!workspaceValid) return false
    if (!supervisorGuardPath) return true
    const guard = JSON.parse(await readFile(supervisorGuardPath, 'utf8')) as Partial<SeriousMissionGuard>
    return guard.version === 1 &&
      guard.missionProfile === 'serious' &&
      guard.briefFingerprint === expectedFingerprint &&
      guard.specificationFingerprint === contract.specificationFingerprint &&
      JSON.stringify(guard.acceptanceChecks) === JSON.stringify(contract.acceptanceChecks) &&
      JSON.stringify(guard.coveredBriefTerms) === JSON.stringify(contract.coveredBriefTerms)
  } catch {
    return false
  }
}
