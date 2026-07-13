import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProcessRunner, type ProcessRunOptions, type ProcessRunResult } from '@main/process/process-runner'

export interface SupervisorProcessPort {
  run: (options: ProcessRunOptions) => Promise<ProcessRunResult>
}

export interface SupervisorVerificationCheck {
  id: string
  label: string
  outcome: 'passed' | 'failed' | 'skipped'
  exitCode?: number | null
  timedOut?: boolean
}

export interface SupervisorVerificationResult {
  outcome: 'passed' | 'failed'
  summary: string
  checks: SupervisorVerificationCheck[]
}

export interface SupervisorVerificationRequest {
  appPath: string
  npmPath: string
  timeoutMs: number
}

export interface SupervisorVerifierPort {
  verify: (request: SupervisorVerificationRequest) => Promise<SupervisorVerificationResult>
}

const ALLOWED_PACKAGE_SCRIPTS = ['typecheck', 'lint', 'test', 'build'] as const

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

async function smallText(path: string, maximumBytes = 1_000_000): Promise<string | undefined> {
  try {
    const value = await readFile(path)
    if (value.length === 0 || value.length > maximumBytes) return undefined
    return value.toString('utf8')
  } catch {
    return undefined
  }
}

async function directArtifact(appPath: string): Promise<{ path: string; valid: boolean } | undefined> {
  for (const relativePath of ['dist/index.html', 'build/index.html', 'index.html']) {
    const content = await smallText(join(appPath, relativePath))
    if (!content) continue
    const valid = /<!doctype\s+html|<html(?:\s|>)/i.test(content) &&
      /<(?:title|body|main|script|style)(?:\s|>)/i.test(content) &&
      !/^(?:\s*|\s*<!--.*?-->\s*)$/s.test(content)
    return { path: relativePath, valid }
  }
  return undefined
}

function nonInteractiveTest(script: string): boolean {
  return /\b(?:vitest\s+run|jest\b|node\s+--test|playwright\s+test|mocha\b|ava\b)/i.test(script)
}

function verificationScripts(scripts: Record<string, unknown>): string[] {
  if (typeof scripts.check === 'string' && scripts.check.trim()) return ['check']
  return ALLOWED_PACKAGE_SCRIPTS.filter((name) => {
    const command = scripts[name]
    if (typeof command !== 'string' || !command.trim()) return false
    return name !== 'test' || nonInteractiveTest(command)
  })
}

export class SupervisorVerifier implements SupervisorVerifierPort {
  constructor(private readonly processPort: SupervisorProcessPort = new ProcessRunner()) {}

  async verify(request: SupervisorVerificationRequest): Promise<SupervisorVerificationResult> {
    const checks: SupervisorVerificationCheck[] = []
    const packageText = await smallText(join(request.appPath, 'package.json'))
    let scripts: Record<string, unknown> = {}
    let hasRunnablePackageCommand = false
    if (packageText) {
      try {
        const packageJson = record(JSON.parse(packageText) as unknown)
        scripts = record(packageJson.scripts)
        hasRunnablePackageCommand = ['dev', 'start', 'preview'].some((name) => {
          const command = scripts[name]
          return typeof command === 'string' && Boolean(command.trim())
        })
      } catch {
        return {
          outcome: 'failed',
          summary: 'Supervisor verification rejected an invalid app/package.json.',
          checks: [{ id: 'package-json', label: 'Parse package metadata', outcome: 'failed' }]
        }
      }
    }

    const scriptsToRun = verificationScripts(scripts)
    const timeoutPerCheck = Math.max(1_000, Math.floor(request.timeoutMs / Math.max(1, scriptsToRun.length)))
    for (const script of scriptsToRun) {
      const result = await this.processPort.run({
        id: `supervisor-${script}-${Date.now().toString(36)}`,
        command: { bin: request.npmPath, args: ['run', script], cwd: request.appPath },
        timeoutMs: timeoutPerCheck,
        stdoutPath: process.platform === 'win32' ? 'NUL' : '/dev/null',
        stderrPath: process.platform === 'win32' ? 'NUL' : '/dev/null',
        onLine: () => undefined
      })
      const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.outputLimitExceeded && !result.rawLogWriteFailed
      checks.push({
        id: `script:${script}`,
        label: `npm run ${script}`,
        outcome: passed ? 'passed' : 'failed',
        exitCode: result.exitCode,
        ...(result.timedOut ? { timedOut: true } : {})
      })
      if (!passed) {
        return {
          outcome: 'failed',
          summary: `Supervisor verification failed at npm run ${script}.`,
          checks
        }
      }
    }

    const artifact = await directArtifact(request.appPath)
    if (artifact) {
      checks.push({
        id: 'artifact',
        label: `Loadable HTML artifact: ${artifact.path}`,
        outcome: artifact.valid ? 'passed' : 'failed'
      })
      if (!artifact.valid) {
        return {
          outcome: 'failed',
          summary: 'Supervisor verification found an incomplete HTML entrypoint.',
          checks
        }
      }
    }

    const runnable = Boolean(artifact?.valid || hasRunnablePackageCommand)
    if (!runnable) {
      checks.push({ id: 'runnable', label: 'Runnable artifact discovery', outcome: 'failed' })
      return {
        outcome: 'failed',
        summary: 'Supervisor verification could not discover a runnable artifact.',
        checks
      }
    }

    if (scriptsToRun.length === 0 && !artifact?.valid) {
      checks.push({ id: 'verification-command', label: 'Independent verification command', outcome: 'failed' })
      return {
        outcome: 'failed',
        summary: 'A package runner exists, but no allowlisted non-interactive verification command is available.',
        checks
      }
    }

    return {
      outcome: 'passed',
      summary: `Supervisor independently passed ${String(checks.filter((check) => check.outcome === 'passed').length)} release check${checks.length === 1 ? '' : 's'}.`,
      checks
    }
  }
}
