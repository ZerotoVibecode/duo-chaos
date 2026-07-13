import crossSpawn from 'cross-spawn'

interface TerminalLaunchInput {
  binary: string
  cwd: string
  platform?: NodeJS.Platform
}

export interface TerminalLaunchCandidate {
  program: string
  args: string[]
}

export type TerminalStarter = (program: string, args: string[], cwd: string) => Promise<void>

const launch: TerminalStarter = (program, args, cwd) => {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(program, args, {
      cwd,
      detached: true,
      shell: false,
      windowsHide: false,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function appleScriptLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function buildTerminalLaunchCandidates(input: TerminalLaunchInput): TerminalLaunchCandidate[] {
  const binary = input.binary.trim()
  const platform = input.platform ?? process.platform

  if (platform === 'win32') {
    const script = `Set-Location -LiteralPath ${powerShellLiteral(input.cwd)}; & ${powerShellLiteral(binary)}`
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
    return [
      {
        program: 'wt.exe',
        args: ['-d', input.cwd, 'powershell.exe', '-NoExit', '-NoProfile', '-EncodedCommand', encodedScript]
      },
      { program: 'powershell.exe', args: ['-NoExit', '-NoProfile', '-Command', script] }
    ]
  }

  if (platform === 'darwin') {
    const command = `cd ${shellLiteral(input.cwd)} && ${shellLiteral(binary)}`
    const script = `tell application "Terminal" to do script "${appleScriptLiteral(command)}"\ntell application "Terminal" to activate`
    return [{ program: 'osascript', args: ['-e', script] }]
  }

  return [
    { program: 'x-terminal-emulator', args: ['-e', binary] },
    { program: 'gnome-terminal', args: ['--working-directory', input.cwd, '--', binary] }
  ]
}

export async function launchInteractiveCli(
  input: TerminalLaunchInput,
  start: TerminalStarter = launch
): Promise<void> {
  if (!input.binary.trim()) throw new Error('The CLI executable path is empty.')
  let lastError: unknown
  for (const candidate of buildTerminalLaunchCandidates(input)) {
    try {
      await start(candidate.program, candidate.args, input.cwd)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No supported terminal application was found.')
}
