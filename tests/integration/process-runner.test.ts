import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING_LINE_BYTES,
  MAX_RAW_LOG_BYTES,
  ProcessRunner,
  buildChildEnvironment,
  terminateProcessTree
} from '../../src/main/process/process-runner'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function inertChild(pid = 41_042, exitCode: number | null = null): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode,
    signalCode: null,
    kill: vi.fn(() => true)
  }) as unknown as ChildProcess
}

describe('process runner', () => {
  it('escalates an uncooperative POSIX process group from SIGTERM to SIGKILL after a bounded grace period', async () => {
    vi.useFakeTimers()
    const killProcess = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const child = inertChild()

    const termination = terminateProcessTree(child)

    expect(killProcess).toHaveBeenCalledWith(-child.pid!, 'SIGTERM')
    expect(killProcess).not.toHaveBeenCalledWith(-child.pid!, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(2_000)
    await termination

    expect(killProcess).toHaveBeenCalledWith(-child.pid!, 'SIGKILL')
  })

  it('does not signal a POSIX process that already exited', async () => {
    const killProcess = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const child = inertChild(41_042, 0)

    await terminateProcessTree(child)

    expect(killProcess).not.toHaveBeenCalled()
  })

  it('keeps only platform and CLI runtime variables in child environments', () => {
    const environment = buildChildEnvironment({
      PATH: 'C:\\Tools',
      HOME: 'C:\\Users\\test',
      SYSTEMROOT: 'C:\\Windows',
      CODEX_HOME: 'C:\\Codex',
      CLAUDE_CONFIG_DIR: 'C:\\Claude',
      OPENAI_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      DATABASE_URL: 'postgres://owner:password@localhost/private',
      SENTRY_DSN: 'https://secret@sentry.example/1',
      NODE_OPTIONS: '--require malicious.js',
      SAFE_FLAG: 'visible'
    })
    expect(environment).toEqual({
      PATH: 'C:\\Tools',
      HOME: 'C:\\Users\\test',
      SYSTEMROOT: 'C:\\Windows',
      CODEX_HOME: 'C:\\Codex',
      CLAUDE_CONFIG_DIR: 'C:\\Claude',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1'
    })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
    expect(environment).not.toHaveProperty('DATABASE_URL')
    expect(environment).not.toHaveProperty('SENTRY_DSN')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('SAFE_FLAG')
  })

  it('streams stdout and stderr, preserves raw logs, and returns the exit code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-test-'))
    const stdoutPath = join(root, 'stdout.log')
    const stderrPath = join(root, 'stderr.log')
    const lines: Array<{ stream: string; line: string }> = []
    const runner = new ProcessRunner()

    const result = await runner.run({
      id: 'process-1',
      command: {
        bin: process.execPath,
        args: ['-e', "console.log('hello'); console.error('warning')"],
        cwd: root
      },
      timeoutMs: 5_000,
      stdoutPath,
      stderrPath,
      onLine: (stream, line) => lines.push({ stream, line })
    })

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false })
    expect(lines).toContainEqual({ stream: 'stdout', line: 'hello' })
    expect(lines).toContainEqual({ stream: 'stderr', line: 'warning' })
    await expect(readFile(stdoutPath, 'utf8')).resolves.toContain('hello')
    await expect(readFile(stderrPath, 'utf8')).resolves.toContain('warning')
  })

  it('delivers a multiline agent prompt over stdin without enabling a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-stdin-'))
    const stdoutPath = join(root, 'stdout.log')
    const prompt = 'First line.\nSecond line with "quotes" and & shell characters.'
    const runner = new ProcessRunner()

    await runner.run({
      id: 'process-stdin',
      command: {
        bin: process.execPath,
        args: ['-e', "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(data))"],
        cwd: root,
        stdin: prompt
      },
      timeoutMs: 2_000,
      stdoutPath,
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    })

    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe(prompt)
  })

  it('terminates a timed-out process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-timeout-'))
    const runner = new ProcessRunner()
    const result = await runner.run({
      id: 'process-timeout',
      command: {
        bin: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root
      },
      timeoutMs: 80,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    })

    expect(result.timedOut).toBe(true)
    expect(result.cancelled).toBe(false)
  })

  it('tracks, rejects duplicate ids, and explicitly cancels a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-cancel-'))
    const runner = new ProcessRunner()
    const options = {
      id: 'process-cancel',
      command: { bin: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root },
      timeoutMs: 5_000,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    }
    const running = runner.run(options)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(runner.isRunning(options.id)).toBe(true)
    await expect(runner.run(options)).rejects.toThrow(/already running/i)
    expect(await runner.cancel(options.id)).toBe(true)
    await expect(running).resolves.toMatchObject({ cancelled: true, timedOut: false })
    expect(await runner.cancel('missing')).toBe(false)
    expect(runner.isRunning(options.id)).toBe(false)
  })

  it('flushes final output without a trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-tail-'))
    const lines: string[] = []
    const runner = new ProcessRunner()
    await runner.run({
      id: 'process-tail',
      command: { bin: process.execPath, args: ['-e', "process.stdout.write('tail')"], cwd: root },
      timeoutMs: 2_000,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      onLine: (_stream, line) => lines.push(line)
    })
    expect(lines).toEqual(['tail'])
  })

  it('terminates and marks a process that exceeds the pending unterminated line boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-line-limit-'))
    const stdoutPath = join(root, 'stdout.log')
    const lines: string[] = []
    const runner = new ProcessRunner()

    const result = await runner.run({
      id: 'process-line-limit',
      command: {
        bin: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.alloc(${MAX_PENDING_LINE_BYTES + 1}, 120))`],
        cwd: root
      },
      timeoutMs: 20_000,
      stdoutPath,
      stderrPath: join(root, 'stderr.log'),
      onLine: (_stream, line) => lines.push(line)
    })

    expect(result.outputLimitExceeded).toEqual({
      stream: 'stdout',
      boundary: 'pending-line',
      limitBytes: MAX_PENDING_LINE_BYTES
    })
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    expect(lines).toEqual([])
    expect((await stat(stdoutPath)).size).toBeLessThanOrEqual(MAX_RAW_LOG_BYTES)
  })

  it('caps raw logs and terminates newline-delimited output before disk usage can grow without bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-log-limit-'))
    const stdoutPath = join(root, 'stdout.log')
    const runner = new ProcessRunner()
    const lineBytes = 64 * 1024
    const iterations = Math.ceil(MAX_RAW_LOG_BYTES / lineBytes) + 2

    const result = await runner.run({
      id: 'process-log-limit',
      command: {
        bin: process.execPath,
        args: ['-e', `const line=Buffer.alloc(${lineBytes},120);line[line.length-1]=10;for(let i=0;i<${iterations};i++)process.stdout.write(line)`],
        cwd: root
      },
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    })

    expect(result.outputLimitExceeded).toEqual({
      stream: 'stdout',
      boundary: 'raw-log',
      limitBytes: MAX_RAW_LOG_BYTES
    })
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
    expect((await stat(stdoutPath)).size).toBeLessThanOrEqual(MAX_RAW_LOG_BYTES)
  })

  it('terminates and marks a process when a raw log cannot be opened for writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-log-failure-'))
    const runner = new ProcessRunner()

    const result = await runner.run({
      id: 'process-log-failure',
      command: {
        bin: process.execPath,
        args: ['-e', "console.log('first'); setInterval(() => console.log('still-running'), 10)"],
        cwd: root
      },
      timeoutMs: 5_000,
      stdoutPath: root,
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    })

    expect(result.rawLogWriteFailed).toMatchObject({ stream: 'stdout' })
    expect(result.rawLogWriteFailed?.code).toMatch(/^(?:EACCES|EISDIR|EPERM)$/)
    expect(result.timedOut).toBe(false)
    expect(result.cancelled).toBe(false)
  })

  it('rejects when the configured executable does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-process-missing-'))
    const runner = new ProcessRunner()
    await expect(runner.run({
      id: 'process-missing',
      command: { bin: 'definitely-missing-duo-executable', args: [], cwd: root },
      timeoutMs: 1_000,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      onLine: () => undefined
    })).rejects.toThrow()
  })
})
