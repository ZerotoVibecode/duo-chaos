import type { CustomizationProfile, MissionProfile, TurnStageName } from '@shared/types'
import type { RealTurn } from './real-turn-plan'

export interface ComposeTurnStagePromptInput {
  runId: string
  round: number
  turn: RealTurn
  stage: TurnStageName
  humanBrief: string
  latestStatement: string
  latestStatementId?: string
  board: string
  finalTurn: boolean
  missionProfile?: MissionProfile
  recoveryReasons?: string[]
  recoveryOriginStage?: TurnStageName
  quotaHandoffFrom?: 'claude' | 'codex'
  leanContribution?: boolean
  contextBaton?: string
  pitchCatalog?: Array<{
    pitchId: string
    agent: 'claude' | 'codex'
    title: string
  }>
  capabilityShortlist?: string
  qualityContract?: string
  qualityBaton?: string
  briefReference?: string
  customizationProfile?: CustomizationProfile
}

function capabilityContract(profile: CustomizationProfile = 'core'): string {
  if (profile === 'full-local') {
    return 'Proactively consider the best relevant already-available user skill, plugin, app, or MCP capability for this mission. Invoke only a clear best fit; never inventory the toolbelt and never invoke subagents.'
  }
  if (profile === 'smart') {
    return 'Use the app-owned duo-quality skill plus relevant already-available user plugins, apps, or MCP capabilities on demand only when they reduce uncertainty or improve evidence. The global user-skill catalog is intentionally suppressed in this profile. Never inventory the toolbelt and never invoke subagents.'
  }
  return 'Use the app-owned duo-quality skill when useful. The user capability toolbelt is disabled for this turn; never invoke subagents.'
}

function missionContract(input: ComposeTurnStagePromptInput): string {
  const briefLabel = input.briefReference ? 'SEALED BRIEF' : 'HUMAN BRIEF'
  if (input.missionProfile === 'serious') {
    return `MISSION PROFILE — SERIOUS BUILD
The ${briefLabel} is a binding product brief. Preserve its requested product, outcomes, constraints, and stated requirements.
- Do not replace the requested product with a different idea, even if another idea seems more entertaining.
- Debate architecture, UX, implementation strategy, scope, and tradeoffs; the product itself is not up for replacement.
- At consensus, put concrete acceptance checks for every stated requirement inside the sealed specification.
- During source work and review, use those acceptance checks to decide what is complete.`
  }
  return `MISSION PROFILE — SURPRISE BUILD
Secretly invent and choose the product identity, then keep the winning scope compact, buildable, and surprising. Explicit domain, audience, platform, usefulness, and restriction signals in the ${briefLabel} remain binding.`
}

function dispatchContract(input: ComposeTurnStagePromptInput, kind: 'opening' | 'verdict' | 'closing'): string {
  const other = input.turn.agent === 'claude' ? 'codex' : 'claude'
  const suffix = input.stage === 'recovery'
    ? `-recovery-${input.recoveryOriginStage ?? 'stage'}`
    : `-${input.stage}`
  const replyTo = input.latestStatementId ? `"${input.latestStatementId}"` : 'null'
  return `Append a spoiler-safe public dispatch to .duo/public/dispatches.jsonl and its detailed private counterpart to .duo/private/dispatches.jsonl.
Use this shape: {"id":"${input.turn.agent}-r${String(input.round)}-${kind}${suffix}","type":"agent.dispatch","agent":"${input.turn.agent}","targetAgent":"${other}","round":${String(input.round)},"dispatchKind":"${kind}","claimKey":"shared-topic","replyTo":${replyTo},"publicText":"I think ... because ...","spoilerRisk":0.0}
Append one spoiler-safe opinion to .duo/public/opinions.jsonl and its detailed private counterpart to .duo/private/opinions.jsonl. Use type opinion, this agent, this round, a valid tone, and a stable unique id.`
}

function revealPacketContract(): string {
  return `FINAL REVEAL CONTRACT
Write .duo/sealed/reveal_packet.json with this exact shape and factual values from the finished workspace:
{"appName":"Product name","idea":"What it is","summary":"What survived","features":["Shipped feature"],"runCommand":"Exact runnable command or direct HTML instruction","appPath":"Workspace-relative runnable path","status":"ready","whatWorked":["Verified result"],"knownIssues":[],"agentDramaSummary":["Factual disagreement and resolution"],"gitCheckpoints":["Checkpoint hash"],"agentQuotes":{"claude":"Real final Claude statement","codex":"Real final Codex statement"}}
Use status ready only when the runnable artifact and checks support it; otherwise use partial or failed and name the caveats. Do not use the run-folder name as appName.`
}

function sourceExecutionContract(): string {
  return `SOURCE EXECUTION RULES
- The shell already starts at the workspace root. Never run cd or prefix a command with cd; target app/... paths directly.
- On Windows, prefer npm.cmd and npx.cmd (plus the matching .cmd or .exe package-runner shim) so PowerShell does not resolve a blocked script shim.
- If a tool call is denied because the permission or safety classifier is unavailable, do not retry that identical tool or command. Record the limitation once in .duo/board.json, fall back to Read, Glob, Grep, Edit, Write, or another preapproved verifier, and finish the handoff with the available evidence.`
}

function common(input: ComposeTurnStagePromptInput): string {
  const other = input.turn.agent === 'claude' ? 'Codex' : 'Claude Code'
  const brief = input.briefReference
    ? `SEALED BRIEF REFERENCE\n${input.briefReference}`
    : `HUMAN BRIEF\n${input.humanBrief}`
  const quality = input.qualityBaton ?? input.qualityContract
  return `# Duo Chaos — broadcast turn
Run: ${input.runId}
Round: ${String(input.round)}
Turn: ${input.turn.kind}
Stage: ${input.stage}
Agent: ${input.turn.agent}

${brief}

${missionContract(input)}
${quality ? `\n${quality}\n` : ''}

GOAL
${input.turn.goal}

LATEST ${other.toUpperCase()} STATEMENT
${input.latestStatement}
Reply to the latest statement directly when it exists. Do not merely summarize it.

BOARD
${input.board}
${input.contextBaton ? `\n${input.contextBaton}` : ''}
${input.capabilityShortlist ? `\n${input.capabilityShortlist}` : ''}
${input.quotaHandoffFrom
    ? `\nQUOTA HANDOFF\n${input.quotaHandoffFrom === 'claude' ? 'Claude' : 'Codex'} is provider-limited. Claim any released task needed to finish the shared build; preserve completed work and do not wait for that agent.`
    : ''}

BOUNDARIES
- Stay inside this workspace. Never inspect runtime telemetry directories or parent/sibling directories.
- Treat app/ as the generated product root. Create and edit all product source, manifests, assets, and product tests under app/, never beside it.
- Do not ask the human for product decisions.
- Both agents design and code. Preserve the teammate's accepted work.
- Keep hidden nouns private. Public text uses [APP_NAME], [FEATURE], [DOMAIN], or [REDACTED].
- Use direct teammate language: "I think X because Y" or "I agree, but change Z." Never invent emotion, confidence, a winner, or a concession.
- During workspace-enabled stages, keep .duo/board.json accurate. Public text never contains hidden names, private paths, secrets, or private implementation details.`
}

function dialogueCapsuleContract(input: ComposeTurnStagePromptInput): string {
  const serious = input.missionProfile === 'serious'
  const pitchContract = input.turn.kind === 'pitch'
    ? serious
      ? 'Include `pitches` with exactly two compact private solution approaches for the requested product. Compare architecture, UX, or implementation strategy; neither candidate may replace the product. Each needs title, idea, appeal, and risk.'
      : 'Include `pitches` with exactly two compact private product candidates. Each needs title, idea, appeal, and risk.'
    : ''
  const pitchCatalog = input.pitchCatalog?.slice(0, 8).map((pitch) =>
    `${pitch.pitchId} | ${pitch.agent} | ${pitch.title.replace(/[\r\n|]+/gu, ' ').replace(/\s+/gu, ' ').trim()}`
  ).join('\n')
  const selectionContract = input.turn.phase === 'round.consensus'
    ? `IMMUTABLE PITCH CATALOG
${pitchCatalog || 'No immutable pitches are available; do not invent source IDs.'}
Set consensus.sourcePitchIds to the exact one or two pitch IDs from this catalog that materially source the decision. Never credit every pitch by default and never invent an ID.`
    : ''
  const consensusContract = input.turn.phase === 'round.consensus'
    ? `Include \`consensus\` with appName, idea, summary, an implementation-ready spec, and redaction terms. consensus.appName is the real private product name; never put [APP_NAME], APP_NAME, or another public placeholder there. consensus.redactions contains exactly one private title term with label "app name" or "product name"; put every other hidden mechanic or pitch term in the top-level redactions array.${serious ? ' The spec must be at least 120 characters, explicitly preserve every binding product requirement and requested quality direction (including visual, readability, interaction, and evidence expectations when present), reuse the brief’s important product terms, and end with an "Acceptance checks" section containing at least two specific bullet checks that cover the stated requirements.' : ''} Include exactly two similarly weighted source-changing tasks: one claimed by claude and one by codex. Every task needs impact (core or substantial), a concrete expectedOutcome, 1-4 concise acceptanceChecks, risk, and 1-12 expected source file boundaries in \`files\`. Every task file boundary must begin with \`app/\` (for example \`app/src/**\` or \`app/tests/**\`); the workspace root is not a product source tree. No copy-only, docs-only, or verification-only consolation task.`
    : ''
  return `DIALOGUE CAPSULE CONTRACT
Return exactly one schema-valid JSON object. The orchestrator will persist it; you have no workspace tools in this stage.
- This capsule represents one real agent statement, not a synthetic conversation. Do not simulate or invent the teammate's reply.
  - statement: the single concise first-person position for this turn. Open directly on a first turn, answer the recorded teammate on a reply, and state the actionable decision during consensus.
- opinion: one honest product/build judgment with a valid tone.
- Public text is 12–28 words, spoiler-safe, and uses [APP_NAME], [FEATURE], [DOMAIN], or [REDACTED].
- Private text names the real idea and implementation detail directly.
- The redactions array lists every private pitch title, chosen app name, and distinctive mechanic/product term that public text must not reveal.
- Do not manufacture agreement. Respond to the teammate context above in plain language.
${pitchContract}
${selectionContract}
${consensusContract}`
}

function dialogueRecoveryGuidance(input: ComposeTurnStagePromptInput): string {
  const reasons = new Set(input.recoveryReasons ?? [])
  if (reasons.has('consensus-quality-contract')) {
    return `QUALITY CONTRACT REPAIR
The prior consensus failed the binding quality brief. Rewrite consensus.idea, consensus.summary, and consensus.spec so they explicitly preserve every binding product requirement and requested quality direction. Do not treat visual direction, readability, accessibility, interaction feedback, or verification as optional implementation detail. Keep the agreed product and valid pitch IDs; repair only the omitted contract coverage.`
  }
  if (reasons.has('consensus-provenance')) {
    return `PROVENANCE REPAIR
Keep the agreed direction, but set consensus.sourcePitchIds only to the exact one or two immutable pitch IDs that materially source it. Do not invent, broaden, or replace the recorded selection.`
  }
  if (reasons.has('structured-tool-activity')) {
    return `TOOL-BOUNDARY REPAIR
Return the structured capsule directly. Do not call, name, or simulate workspace tools in this tool-free dialogue stage.`
  }
  return ''
}

function stagedRecoveryCapsuleContract(input: ComposeTurnStagePromptInput): string {
  const needsOpinion = input.recoveryReasons?.includes('missing-opinion') ?? false
  return `RECOVERY CAPSULE CONTRACT
Origin stage: ${input.recoveryOriginStage ?? 'staged handoff'}.
Return exactly one schema-valid JSON object. The orchestrator—not this agent—will persist the repaired collaboration record.
- dispatch.publicText: one concise, direct, spoiler-safe teammate handoff using [APP_NAME], [FEATURE], [DOMAIN], or [REDACTED].
- dispatch.privateText: the same authentic handoff with the real implementation detail.
- opinion: ${needsOpinion ? 'one honest build judgment with publicText, privateText, and a valid tone.' : 'null; this recovery does not require a duplicate opinion.'}
- redactions: every distinctive private product or mechanic term used by the capsule.
- Do not include IDs, paths, tasks, consensus, commands, or file operations. The supervisor derives all protocol metadata.
- Do not simulate the teammate or repeat implementation. Repair only the missing coordination statement.`
}

export function composeTurnStagePrompt(input: ComposeTurnStagePromptInput): string {
  const header = common(input)
  if (input.stage === 'opening') {
    return `${header}

OPENING CONTRACT
Before any source work, tests, or broad inspection, file one direct opening or counter-position that makes the upcoming work legible on camera.
${dispatchContract(input, 'opening')}
Stop immediately after those coordination records are valid. Do not edit app source in this stage.`
  }

  if (input.stage === 'work') {
    if (input.leanContribution) {
      return `${header}

COHESIVE CONTRIBUTION
This is one fresh, self-contained source contribution. Do not expect a later paid opening or verdict call.
${sourceExecutionContract()}
- State your direct answer to the teammate's latest position, then act on it.
- Read .duo/sealed/idea.md, .duo/sealed/spec.md, and .duo/board.json before choosing the implementation boundary. The complete sealed decision outranks a shortened handoff.
- Batch independent reads and searches. Inspect only files needed for this mission; do not tour the repository.
- A small app-owned skill lives at .duo/private/skills/duo-quality/SKILL.md. Use it when it sharpens implementation or review; do not reread it repeatedly.
- ${capabilityContract(input.customizationProfile)}
- Git metadata is supervisor-private and intentionally absent here. Do not run Git commands; inspect and verify the workspace files directly.
- On Windows use npm.cmd; elsewhere use npm. Dependency setup must use npm install --ignore-scripts. Do not use npx, alternate package managers, or arbitrary inline node programs. Prefer package scripts, node --check, or node --test for verification.
- Preserve accepted teammate work. For an integration turn, review that work before adding your distinct slice.
- Claim or update your matching task in .duo/board.json, implement the goal, and run the smallest useful verification set.
- Keep source changes inside the task's expected file boundaries; satisfy its concise acceptance checks and preserve the expectedOutcome as the definition of done.
- Before stopping, mark your owned task done or explicitly blocked and record verification evidence in the board/protocol.
- Finish by appending one concise, reply-linked handoff that says what you accepted, challenged, changed, verified, and what remains.
${dispatchContract(input, input.latestStatementId ? 'verdict' : 'opening')}
${input.missionProfile === 'serious' ? 'The sealed brief and acceptance checks are binding. Improve the solution without substituting a different product. Apply the same premium quality floor: a distinctive, polished result, one signature interaction where appropriate, deliberate visual direction, accessible controls, and a runnable finish.' : 'Elevate a vague brief into a distinctive, polished product: one signature interaction, deliberate visual direction, accessible controls, and a runnable finish.'}
The supervisor builds the reveal packet from verified evidence. Do not spend time authoring presentation metadata or replaying work in a separate verdict.`
    }
    return `${header}

WORK LEASE
Implement the distinct source-changing goal and produce real workspace evidence. Do not redo or reopen the settled product decision unless the current build proves it impossible.
${sourceExecutionContract()}
Read .duo/sealed/idea.md, .duo/sealed/spec.md, and .duo/board.json before choosing the implementation boundary.
Use the supervisor FOCUS BATON as the starting map. ${capabilityContract(input.customizationProfile)}
Claim or update the matching task in .duo/board.json, keep the teammate's slice intact, run the most useful available checks, and leave the workspace in a recoverable state.
${input.missionProfile === 'serious' ? 'Treat the sealed acceptance checks as binding: preserve the requested product and verify the requirements touched by this slice.' : ''}
After a meaningful milestone, you may append one concise update/evidence dispatch. Do not fabricate heartbeat messages or repeat the opening contract.
${input.finalTurn ? revealPacketContract() : ''}`
  }

  if (input.stage === 'verdict') {
    return `${header}

VERDICT / HANDOFF
No source edits and no new test run in this stage. State what changed, what remains uncertain, and the exact next move for the other agent.
${dispatchContract(input, 'verdict')}
${input.finalTurn ? revealPacketContract() : ''}
Stop immediately after the verdict and opinion records are valid.`
  }

  if (input.stage === 'recovery') {
    if (input.recoveryOriginStage === 'dialogue') {
      return `${header}

CONTRACT-ONLY RECOVERY — STRUCTURED DIALOGUE
The previous response was missing or invalid: ${(input.recoveryReasons ?? []).join(', ') || 'structured dialogue capsule'}.
Do not inspect or edit the workspace. Correct only the response contract and return one complete capsule.
${dialogueRecoveryGuidance(input)}
${dialogueCapsuleContract(input)}`
    }
    return `${header}

CONTRACT-ONLY RECOVERY
The completed stage was missing: ${(input.recoveryReasons ?? []).join(', ') || 'required coordination records'}.
Do not inspect or edit the app, do not run tests, and do not repeat implementation. Use only the ${input.briefReference ? 'sealed brief reference, immutable quality baton,' : 'human brief'} and teammate context already supplied above.
${stagedRecoveryCapsuleContract(input)}`
  }

  return `${header}

DIALOGUE CONTRACT
This is a substantive but time-bounded product discussion. Challenge the latest statement with concrete product and build reasoning, then move the shared direction toward a decision.
${dialogueCapsuleContract(input)}`
}
