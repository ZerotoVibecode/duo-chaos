import type { AgentEffort, CodexEffort, CustomizationProfile, ExecutionMode } from '@shared/types'

export interface StructuredDialoguePolicy {
  kind: 'structured-dialogue' | 'structured-recovery'
  outputSchema: Record<string, unknown>
  outputSchemaPath: string
  toolPolicy: 'none'
}

interface BuildAgentCommandBase {
  executionMode: Exclude<ExecutionMode, 'simulation'>
  binary: string
  workspacePath: string
  prompt: string
  dangerousModeConfirmed: boolean
  model?: string
  extraArgs: string[]
  dialoguePolicy?: StructuredDialoguePolicy
  sourcePolicy?: {
    toolPolicy: 'workspace-essential'
    customizationProfile?: CustomizationProfile
  }
  session?:
    | { mode: 'start'; id?: string }
    | { mode: 'resume'; id: string }
}

export type BuildAgentCommandInput = BuildAgentCommandBase & (
  | { agent: 'codex'; effort?: CodexEffort }
  | { agent: 'claude'; effort?: AgentEffort }
)

export interface AgentCommand {
  bin: string
  args: string[]
  cwd: string
  stdin?: string
}

export class CommandBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandBuildError'
  }
}

const EXACT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_FILE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write'
] as const

const CLAUDE_BOUNDED_BUILD_TOOLS = [
  'Bash(node --check *)',
  'Bash(node.exe --check *)',
  'Bash(node --test *)',
  'Bash(node.exe --test *)',
  'Bash(npm install --ignore-scripts *)',
  'Bash(npm.cmd install --ignore-scripts *)',
  'Bash(npm ci --ignore-scripts *)',
  'Bash(npm.cmd ci --ignore-scripts *)',
  'Bash(npm run *)',
  'Bash(npm.cmd run *)',
  'Bash(npm test *)',
  'Bash(npm.cmd test *)'
] as const

function claudeSourceAllowedTools(
  executionMode: Exclude<ExecutionMode, 'simulation'>,
  customizationProfile: CustomizationProfile
): string {
  const tools: string[] = [...CLAUDE_FILE_TOOLS]
  // Safe is deliberately shell-free. Chaos retains only the package/test
  // commands needed to build inside the generated workspace; arbitrary Node
  // programs, package executors, and alternate package managers are not
  // preapproved. Native Windows does not provide Claude's OS Bash sandbox.
  if (executionMode !== 'safe') tools.push(...CLAUDE_BOUNDED_BUILD_TOOLS)
  // Smart/Broad are enabled only after the human explicitly trusts the local
  // CLI capability configuration. Headless acceptEdits does not autoapprove
  // MCP tools, so preapprove that configured namespace without returning to
  // the upstream auto classifier that previously caused retry storms.
  if (customizationProfile !== 'core') tools.push('mcp__*')
  return tools.join(',')
}

function assertSession(input: BuildAgentCommandInput): void {
  const session = input.session
  if (!session) return
  if (session.mode === 'resume' && !EXACT_SESSION_ID.test(session.id)) {
    throw new CommandBuildError('A resume session identifier must be an exact UUID.')
  }
  if (session.mode === 'start' && session.id !== undefined && !EXACT_SESSION_ID.test(session.id)) {
    throw new CommandBuildError('A start session identifier must be an exact UUID when provided.')
  }
}

function assertInput(input: BuildAgentCommandInput): void {
  if (!input.binary.trim()) throw new CommandBuildError('A CLI binary is required.')
  if (!input.workspacePath.trim()) throw new CommandBuildError('A workspace path is required.')
  if (!input.prompt.trim()) throw new CommandBuildError('A turn prompt is required.')
  if (input.agent === 'claude' && (input.effort as string | undefined) === 'ultra') {
    throw new CommandBuildError('Claude automated runs support effort through Max; Ultra is Codex-only.')
  }
  if (input.executionMode === 'yolo-sandbox' && !input.dangerousModeConfirmed) {
    throw new CommandBuildError('YOLO Sandbox requires explicit disposable-environment confirmation.')
  }
  if (input.dialoguePolicy) {
    if (input.session) throw new CommandBuildError('Structured dialogue must use one ephemeral, tool-free response without a resumable session.')
    if (!input.dialoguePolicy.outputSchemaPath.trim()) throw new CommandBuildError('Structured Codex dialogue requires an output schema path.')
    if (Object.keys(input.dialoguePolicy.outputSchema).length === 0) throw new CommandBuildError('Structured dialogue requires a non-empty output schema.')
  }
  if (input.dialoguePolicy && input.sourcePolicy) {
    throw new CommandBuildError('A command cannot be both tool-free dialogue and a source contribution.')
  }
  if (input.sourcePolicy && input.session) {
    throw new CommandBuildError('Lean source contributions use a fresh compact session and cannot resume provider history.')
  }
  assertSession(input)
}

function structuredOutputPrompt(
  prompt: string,
  kind: StructuredDialoguePolicy['kind'],
  agent: BuildAgentCommandInput['agent']
): string {
  const label = kind === 'structured-recovery' ? 'recovery capsule' : 'dialogue capsule'
  const transport = agent === 'claude'
    ? `Return exactly one valid ${label} by submitting StructuredOutput with every schema field at the tool-input root. Never wrap the schema fields under \`value\`, \`output\`, or \`payload\`, and never serialize the object into a string. If schema validation rejects the first submission, immediately correct and resubmit once. Do not call anything else.`
    : `Return exactly one ${label} that satisfies the supplied JSON schema.`
  return `${transport}
Do not inspect, edit, or run workspace tools. Do not read files, execute commands, browse, or start a tool loop.
Answer only from the human brief and teammate context included below. Do not add a prose wrapper or markdown fence.

${prompt}`
}

export function buildAgentCommand(input: BuildAgentCommandInput): AgentCommand {
  assertInput(input)
  const model = input.model?.trim()
  const effort = input.effort && input.effort !== 'default' ? input.effort : undefined
  const dialoguePolicy = input.dialoguePolicy
  const sourcePolicy = input.sourcePolicy
  const customizationProfile = sourcePolicy?.customizationProfile ?? 'core'
  if (input.executionMode === 'safe' && sourcePolicy && customizationProfile !== 'core') {
    throw new Error('Safe execution supports Core toolbelts only; unattended local capabilities require Chaos or YOLO Sandbox.')
  }
  const prompt = dialoguePolicy ? structuredOutputPrompt(input.prompt, dialoguePolicy.kind, input.agent) : input.prompt
  // Supervised runs are a closed command contract. Legacy extra-argument fields
  // remain loadable for settings compatibility, but never enter a child command:
  // they could override the visible model, effort, sandbox, tools, or consent.
  const extraArgs: string[] = []

  if (input.agent === 'codex') {
    const safetyArgs =
      dialoguePolicy
        ? ['--ask-for-approval', 'never', '--sandbox', 'read-only']
        : input.executionMode === 'yolo-sandbox'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
    const leanContextArgs = dialoguePolicy || customizationProfile === 'core'
      ? [
          '--disable', 'plugins',
          '--disable', 'apps',
          '--disable', 'multi_agent',
          '--disable', 'hooks',
          ...(dialoguePolicy ? ['--disable', 'shell_tool'] : []),
          '-c', 'skills.include_instructions=false',
          '-c', 'mcp_servers={}'
        ]
      : [
          // User MCP servers, apps and plugins stay available in source work;
          // Broad also keeps user skills. Hidden subagent fan-out and hooks stay
          // disabled in every profile.
          '--disable', 'multi_agent',
          '--disable', 'hooks',
          // Smart mode avoids paying to advertise every user skill. Duo's
          // app-owned workflow remains available by its explicit workspace path.
          ...(customizationProfile === 'smart' ? ['-c', 'skills.include_instructions=false'] : [])
        ]
    const executionArgs = [
      // Generated workspaces intentionally keep Git metadata outside the
      // agent-writable tree. Tell Codex that the supervisor has already
      // established the trust boundary instead of requiring a local .git.
      '--skip-git-repo-check',
      ...(input.session?.mode === 'resume'
        ? ['resume', '--json', ...extraArgs, input.session.id, '-']
        : [
          ...(dialoguePolicy ? ['--ignore-user-config', '--ignore-rules'] : []),
          '--json',
          ...(input.session?.mode === 'start' ? [] : ['--ephemeral']),
          ...(dialoguePolicy ? ['--output-schema', dialoguePolicy.outputSchemaPath] : []),
          ...extraArgs,
          '-'
        ])
    ]
    return {
      bin: input.binary,
      args: [
        ...safetyArgs,
        ...leanContextArgs,
        ...(model ? ['--model', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
        '--cd',
        input.workspacePath,
        'exec',
        ...executionArgs
      ],
      cwd: input.workspacePath,
      stdin: prompt
    }
  }

  const permissionMode =
    input.executionMode === 'yolo-sandbox'
      ? ['--dangerously-skip-permissions']
      : [
          '--permission-mode',
          sourcePolicy?.toolPolicy === 'workspace-essential' || input.executionMode === 'safe'
            ? 'acceptEdits'
            : 'auto'
        ]
  const preapprovedSourceTools =
    sourcePolicy?.toolPolicy === 'workspace-essential' && input.executionMode !== 'yolo-sandbox'
      ? ['--allowedTools', claudeSourceAllowedTools(input.executionMode, customizationProfile)]
      : []
  const sessionArgs = input.session?.mode === 'resume'
    ? ['--resume', input.session.id]
    : input.session?.mode === 'start'
      ? input.session.id ? ['--session-id', input.session.id] : []
      : ['--no-session-persistence']
  const lockedClaudeContext = dialoguePolicy || customizationProfile === 'core'
  const supervisedClaudeSettings = JSON.stringify({
    disableAllHooks: true,
    includeGitInstructions: false
  })
  const claudeCustomizationArgs = lockedClaudeContext
    ? ['--safe-mode', '--disable-slash-commands']
    // Both capability profiles inherit authenticated user-level plugin/MCP
    // settings. Smart suppresses the skill catalog below; Broad retains it.
    // Project/local settings are never trusted by supervised runs.
    : [
        '--setting-sources', 'user',
        '--settings', supervisedClaudeSettings,
        '--disallowedTools', 'Agent,Task',
        // Smart keeps plugins/apps/MCPs but suppresses the potentially huge
        // user skill catalog. Broad intentionally leaves user skills enabled.
        ...(customizationProfile === 'smart' ? ['--disable-slash-commands'] : [])
      ]
  return {
    bin: input.binary,
    args: [
      '--print',
      '--input-format',
      'text',
      '--output-format',
      dialoguePolicy ? 'json' : 'stream-json',
      '--verbose',
      // `--bare` also disables OAuth and keychain reads. Core mode uses safe
      // mode; source stages can instead inherit a deliberately scoped toolbelt.
      ...claudeCustomizationArgs,
      '--exclude-dynamic-system-prompt-sections',
      '--prompt-suggestions',
      'false',
      ...permissionMode,
      ...preapprovedSourceTools,
      ...sessionArgs,
      ...(dialoguePolicy ? ['--tools', '', '--json-schema', JSON.stringify(dialoguePolicy.outputSchema)] : []),
      // One response plus one provider-internal schema correction. Real tools
      // remain disabled, the session stays ephemeral, and the orchestrator
      // still accepts only one strictly validated capsule.
      ...(dialoguePolicy ? ['--max-turns', '2'] : []),
      ...(sourcePolicy?.toolPolicy === 'workspace-essential' && lockedClaudeContext
        ? ['--tools', input.executionMode === 'safe' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep,Edit,Write,Bash']
        : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...extraArgs
    ],
    cwd: input.workspacePath,
    stdin: prompt
  }
}
