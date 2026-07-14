import type { DuoEvent, DuoTask, VisibilityMode } from '@shared/types'
import { redactText, type RedactionTerm } from './redaction'

const EXPLICIT_MASK = /\[(?:REDACTED|APP(?:_NAME| IDEA)?|FEATURE|DOMAIN|CORE_MECHANIC|WORKSPACE_FILE)\]/i
const SAFE_GENERIC_TASK_TITLE = /^(?:Repair investigation|Verification pass|Design challenge|Shared build task|Spoiler-sealed shared task)$/i

function hasExplicitMask(text: string): boolean {
  return EXPLICIT_MASK.test(text)
}

function projectedPublicText(
  text: string,
  terms: RedactionTerm[],
  fallback: string
): string {
  const redacted = redactText(text, terms)
  const dictionaryChangedText = redacted !== redactText(text, [])
  return hasExplicitMask(text) || dictionaryChangedText ? redacted : fallback
}

function stripPrivateTaskStructure(task: DuoTask): DuoTask {
  const safe = { ...task }
  delete safe.privateTitle
  delete safe.privateDescription
  delete safe.privateFiles
  delete safe.privateExpectedOutcome
  delete safe.privateAcceptanceChecks
  return safe
}

export function projectTaskForRenderer(
  task: DuoTask,
  visibilityMode: VisibilityMode,
  revealed: boolean,
  terms: RedactionTerm[]
): DuoTask {
  if (revealed) {
    return stripPrivateTaskStructure({
      ...task,
      ...(task.privateTitle ? { publicTitle: task.privateTitle } : {}),
      ...(task.privateDescription ? { publicDescription: task.privateDescription } : {}),
      ...(task.privateFiles ? { files: task.privateFiles } : {})
    })
  }

  const safe = stripPrivateTaskStructure(task)
  if (visibilityMode === 'full-chaos') return safe
  if (visibilityMode === 'blind') {
    return {
      ...safe,
      publicTitle: 'Spoiler-sealed shared task',
      publicDescription: 'Task details stay sealed until reveal.',
      files: safe.files.map(() => '[WORKSPACE_FILE]')
    }
  }

  return {
    ...safe,
    publicTitle: SAFE_GENERIC_TASK_TITLE.test(safe.publicTitle)
      ? safe.publicTitle
      : projectedPublicText(safe.publicTitle, terms, 'Spoiler-sealed shared task'),
    ...(safe.publicDescription
      ? {
          publicDescription: projectedPublicText(
            safe.publicDescription,
            terms,
            'Task details stay sealed until reveal.'
          )
        }
      : {}),
    files: safe.files.map((file) => projectedPublicText(file, terms, '[WORKSPACE_FILE]'))
  }
}

function stripPrivateStructure(event: DuoEvent): DuoEvent {
  const safe = { ...event }
  delete safe.privateText
  delete safe.metadata
  delete safe.revealPacket
  delete safe.privateTopic
  if (
    safe.agent !== 'director' ||
    event.metadata?.protocolOrigin === 'workspace-public-protocol' ||
    !['contribution-receipt', 'review-receipt', 'quality-evidence-state'].includes(safe.topic ?? '')
  ) {
    delete safe.proof
  }
  if (safe.task) {
    safe.task = { ...safe.task }
    delete safe.task.privateTitle
    delete safe.task.privateDescription
    delete safe.task.privateFiles
    delete safe.task.privateExpectedOutcome
    delete safe.task.privateAcceptanceChecks
  }
  return safe
}

function agentName(event: DuoEvent): string {
  return event.agent === 'claude' ? 'Claude' : event.agent === 'codex' ? 'Codex' : 'Director'
}

function targetName(event: DuoEvent): string {
  if (event.targetAgent === 'claude') return 'Claude'
  if (event.targetAgent === 'codex') return 'Codex'
  return event.agent === 'claude' ? 'Codex' : event.agent === 'codex' ? 'Claude' : 'the agents'
}

function sealedProtocolHandoff(event: DuoEvent): string {
  const agent = agentName(event)
  const target = targetName(event)
  switch (event.dispatchKind) {
    case 'challenge':
      return `${agent} challenged ${target} on a hidden build choice.`
    case 'counter':
    case 'reaction':
      return `${agent} answered ${target}'s hidden build position.`
    case 'evidence':
      return `${agent} handed ${target} spoiler-sealed build evidence.`
    case 'repair':
      return `${agent} handed ${target} a spoiler-sealed repair update.`
    case 'concession':
      return `${agent} conceded one hidden build point to ${target}.`
    case 'decision':
    case 'verdict':
    case 'closing':
      return `${agent} filed a spoiler-sealed build verdict.`
    default:
      return `${agent} handed ${target} a spoiler-sealed build position.`
  }
}

function blindText(event: DuoEvent): string {
  const agent = agentName(event)
  switch (event.type) {
    case 'agent.dispatch':
      return sealedProtocolHandoff(event)
    case 'opinion':
      return `${agent} registered a ${event.severity === 'critical' || event.severity === 'high' ? 'high-heat' : 'new'} opinion.`
    case 'conflict':
      return 'A conflict opened. Details stay hidden in Blind mode.'
    case 'build.failed':
      return 'The build failed. A repair loop is starting.'
    case 'reveal.ready':
      return 'Reveal ready. The hidden app can now be opened.'
    case 'task.created':
      return 'A spoiler-sealed shared task was added.'
    case 'task.claimed':
      return 'An agent claimed a spoiler-sealed shared task.'
    case 'task.updated':
      return 'A spoiler-sealed shared task changed state.'
    case 'cli.log':
      return `${agent} is working inside the private workspace.`
    default:
      return event.publicText
  }
}

export function projectEventForRenderer(
  event: DuoEvent,
  visibilityMode: VisibilityMode,
  revealed: boolean,
  terms: RedactionTerm[]
): DuoEvent {
  // Provider envelopes, tool inputs/results and private transcripts are a
  // main-process-only record. Reveal unlocks product spoilers, never raw CLI
  // payloads or capability inventories across IPC.
  if (revealed) {
    return {
      ...stripPrivateStructure(event),
      publicText: redactText(event.publicText, []),
      ...(event.task
        ? { task: projectTaskForRenderer(event.task, visibilityMode, true, terms) }
        : {}),
      rawAvailable: Boolean(event.privateText || event.rawAvailable)
    }
  }

  if (visibilityMode === 'full-chaos') {
    return {
      ...stripPrivateStructure(event),
      // Full Chaos is spoiler-full structured speech, not raw provider output.
      publicText: redactText(event.publicText, []),
      rawAvailable: Boolean(event.privateText || event.rawAvailable)
    }
  }

  const publicEvent = stripPrivateStructure(event)
  const eventHasExplicitMask = hasExplicitMask(event.publicText)
  const dictionaryRedactedText = redactText(event.publicText, terms)
  const wasDictionaryRedacted = dictionaryRedactedText !== redactText(event.publicText, [])
  const isAgentAuthoredProtocolSpeech =
    event.metadata?.protocolOrigin === 'workspace-public-protocol' &&
    (event.type === 'agent.dispatch' || event.type === 'opinion')
  const needsProtocolQuarantine =
    isAgentAuthoredProtocolSpeech && !eventHasExplicitMask && !wasDictionaryRedacted
  const needsTaskQuarantine = event.type.startsWith('task.') && !eventHasExplicitMask && !wasDictionaryRedacted
  const needsDictionaryQuarantine = event.spoilerRisk >= 0.7 && terms.length === 0 && !eventHasExplicitMask
  const publicText =
    visibilityMode === 'blind' || needsDictionaryQuarantine || needsTaskQuarantine
      ? blindText(event)
      : needsProtocolQuarantine
        ? event.type === 'agent.dispatch'
          ? sealedProtocolHandoff(event)
          : `${agentName(event)} challenged ${targetName(event)} on a hidden build choice.`
        : dictionaryRedactedText
  return {
    ...publicEvent,
    publicText,
    ...(event.task
      ? {
          task: projectTaskForRenderer(event.task, visibilityMode, revealed, terms)
        }
      : {}),
    ...(event.claudePosition ? { claudePosition: redactText(event.claudePosition, terms) } : {}),
    ...(event.codexPosition ? { codexPosition: redactText(event.codexPosition, terms) } : {}),
    ...(event.resolution ? { resolution: redactText(event.resolution, terms) } : {}),
    ...(event.evidenceFiles
      ? { evidenceFiles: event.evidenceFiles.map((file) => redactText(file, terms)) }
      : {}),
    rawAvailable: Boolean(event.privateText || event.rawAvailable)
  }
}
