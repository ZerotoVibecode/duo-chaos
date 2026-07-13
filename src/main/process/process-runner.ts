import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import crossSpawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import type { AgentCommand } from './command-builder'

export interface ProcessRunOptions {
  id: string
  command: AgentCommand
  timeoutMs: number
  stdoutPath: string
  stderrPath: string
  onLine: (stream: 'stdout' | 'stderr', line: string) => void
}

export interface ProcessRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  cancelReason?: 'user' | 'lease'
  outputLimitExceeded?: {
    stream: 'stdout' | 'stderr'
    boundary: 'pending-line' | 'raw-log'
    limitBytes: number
  }
  rawLogWriteFailed?: {
    stream: 'stdout' | 'stderr'
    code?: string
  }
  startedAt: string
  finishedAt: string
}

interface ActiveProcess {
  child: ChildProcess
  cancelRequested: boolean
  cancelReason?: 'user' | 'lease'
}

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR'
])
const POSIX_TERMINATION_GRACE_MS = 1_000
export const MAX_PENDING_LINE_BYTES = 8 * 1024 * 1024
export const MAX_RAW_LOG_BYTES = 64 * 1024 * 1024

export function buildChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(source).filter(([name, value]) => {
      const normalized = name.toUpperCase()
      return value !== undefined && (ALLOWED_ENVIRONMENT_NAMES.has(normalized) || normalized.startsWith('LC_'))
    })
  )
  return {
    ...inherited,
    // Keep supervised Claude turns compact and deterministic even when user
    // capabilities are enabled. These controls do not disable user-scoped
    // skills, plugins, apps, or MCP servers selected by the CLI.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1'
  }
}

function streamLines(
  stream: NodeJS.ReadableStream,
  rawStream: NodeJS.WritableStream,
  kind: 'stdout' | 'stderr',
  onLine: ProcessRunOptions['onLine'],
  onLimitExceeded: (limit: NonNullable<ProcessRunResult['outputLimitExceeded']>) => void,
  onRawLogWriteFailed: (failure: NonNullable<ProcessRunResult['rawLogWriteFailed']>) => void
): () => void {
  let buffer: Buffer[] = []
  let pendingBytes = 0
  let rawBytes = 0
  let stopped = false
  let waitingForDrain = false

  const stopAtBoundary = (boundary: 'pending-line' | 'raw-log', limitBytes: number): void => {
    if (stopped) return
    stopped = true
    buffer = []
    pendingBytes = 0
    stream.pause()
    onLimitExceeded({ stream: kind, boundary, limitBytes })
  }

  const stopForRawLogFailure = (error: unknown): void => {
    if (stopped) return
    stopped = true
    buffer = []
    pendingBytes = 0
    stream.pause()
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
    onRawLogWriteFailed({ stream: kind, ...(code ? { code } : {}) })
  }
  rawStream.on('error', stopForRawLogFailure)

  const writeRaw = (chunk: Buffer): void => {
    if (chunk.length === 0 || stopped) return
    rawBytes += chunk.length
    let accepted = false
    try {
      accepted = rawStream.write(chunk)
    } catch (error) {
      stopForRawLogFailure(error)
      return
    }
    if (!accepted && !waitingForDrain) {
      waitingForDrain = true
      stream.pause()
      rawStream.once('drain', () => {
        waitingForDrain = false
        if (!stopped) stream.resume()
      })
    }
  }

  const emitPendingLine = (): void => {
    const joined = Buffer.concat(buffer, pendingBytes)
    const line = joined.length > 0 && joined[joined.length - 1] === 13
      ? joined.subarray(0, -1)
      : joined
    if (line.length > 0) onLine(kind, line.toString('utf8'))
    buffer = []
    pendingBytes = 0
  }

  stream.on('data', (chunk: Buffer | string) => {
    if (stopped) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remainingRawBytes = MAX_RAW_LOG_BYTES - rawBytes
    if (bytes.length > remainingRawBytes) {
      if (remainingRawBytes > 0) writeRaw(bytes.subarray(0, remainingRawBytes))
      stopAtBoundary('raw-log', MAX_RAW_LOG_BYTES)
      return
    }
    writeRaw(bytes)

    let cursor = 0
    while (cursor < bytes.length && !stopped) {
      const newline = bytes.indexOf(10, cursor)
      const end = newline === -1 ? bytes.length : newline
      const segment = bytes.subarray(cursor, end)
      if (pendingBytes + segment.length > MAX_PENDING_LINE_BYTES) {
        stopAtBoundary('pending-line', MAX_PENDING_LINE_BYTES)
        return
      }
      if (segment.length > 0) {
        buffer.push(segment)
        pendingBytes += segment.length
      }
      if (newline === -1) return
      emitPendingLine()
      cursor = newline + 1
    }
  })
  return () => {
    if (!stopped && pendingBytes > 0) emitPendingLine()
  }
}

function finishRawLog(stream: WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableFinished) return Promise.resolve()
  return new Promise((resolve) => {
    const settled = (): void => {
      stream.removeListener('finish', settled)
      stream.removeListener('close', settled)
      resolve()
    }
    stream.once('finish', settled)
    stream.once('close', settled)
    stream.end()
  })
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', () => {
        child.kill()
        resolve()
      })
      killer.once('close', () => resolve())
    })
    return
  }
  const pid = child.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const exited = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const onClose = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolve(child.exitCode !== null || child.signalCode !== null)
    }, POSIX_TERMINATION_GRACE_MS)
    child.once('close', onClose)
  })
  if (exited) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export class ProcessRunner {
  private readonly active = new Map<string, ActiveProcess>()

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (this.active.has(options.id)) throw new Error(`Process ${options.id} is already running.`)
    await Promise.all([
      mkdir(dirname(options.stdoutPath), { recursive: true }),
      mkdir(dirname(options.stderrPath), { recursive: true })
    ])

    const startedAt = new Date().toISOString()
    const stdoutFile = createWriteStream(options.stdoutPath, { flags: 'a' })
    const stderrFile = createWriteStream(options.stderrPath, { flags: 'a' })
    const child = crossSpawn(options.command.bin, options.command.args, {
      cwd: options.command.cwd,
      env: buildChildEnvironment(process.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.command.stdin)
    const active: ActiveProcess = { child, cancelRequested: false }
    this.active.set(options.id, active)

    let timedOut = false
    let outputLimitExceeded: ProcessRunResult['outputLimitExceeded']
    let rawLogWriteFailed: ProcessRunResult['rawLogWriteFailed']
    const handleOutputLimit = (limit: NonNullable<ProcessRunResult['outputLimitExceeded']>): void => {
      if (outputLimitExceeded) return
      outputLimitExceeded = limit
      void terminateProcessTree(child)
    }
    const handleRawLogWriteFailure = (failure: NonNullable<ProcessRunResult['rawLogWriteFailed']>): void => {
      if (rawLogWriteFailed) return
      rawLogWriteFailed = failure
      void terminateProcessTree(child)
    }
    const flushStdout = child.stdout
      ? streamLines(child.stdout, stdoutFile, 'stdout', options.onLine, handleOutputLimit, handleRawLogWriteFailure)
      : () => undefined
    const flushStderr = child.stderr
      ? streamLines(child.stderr, stderrFile, 'stderr', options.onLine, handleOutputLimit, handleRawLogWriteFailure)
      : () => undefined
    const timeout = setTimeout(() => {
      timedOut = true
      void terminateProcessTree(child)
    }, options.timeoutMs)

    return await new Promise<ProcessRunResult>((resolve, reject) => {
      child.once('error', (error) => {
        clearTimeout(timeout)
        this.active.delete(options.id)
        void Promise.all([finishRawLog(stdoutFile), finishRawLog(stderrFile)]).finally(() => reject(error))
      })
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout)
        flushStdout()
        flushStderr()
        this.active.delete(options.id)
        void Promise.all([finishRawLog(stdoutFile), finishRawLog(stderrFile)]).then(() => {
          resolve({
            exitCode,
            signal,
            timedOut,
            cancelled: active.cancelRequested,
            ...(active.cancelReason ? { cancelReason: active.cancelReason } : {}),
            ...(outputLimitExceeded ? { outputLimitExceeded } : {}),
            ...(rawLogWriteFailed ? { rawLogWriteFailed } : {}),
            startedAt,
            finishedAt: new Date().toISOString()
          })
        })
      })
    })
  }

  async cancel(id: string, reason: 'user' | 'lease' = 'user'): Promise<boolean> {
    const active = this.active.get(id)
    if (!active) return false
    active.cancelRequested = true
    active.cancelReason = reason
    await terminateProcessTree(active.child)
    return true
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)))
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }
}
