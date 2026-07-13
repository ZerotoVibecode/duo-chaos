import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  SupervisorVerifier,
  type SupervisorProcessPort
} from '../../src/main/orchestrator/supervisor-verifier'

describe('supervisor verifier', () => {
  it('independently accepts a complete direct HTML artifact', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-html-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html><head><title>Proof</title></head><body><main>Hello</main></body></html>', 'utf8')
    const processPort: SupervisorProcessPort = { run: vi.fn() }

    const result = await new SupervisorVerifier(processPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'artifact', outcome: 'passed' })
    ]))
    expect(processPort.run).not.toHaveBeenCalled()
  })

  it('runs allowlisted package checks with argument arrays and rejects a failed build', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-package-'))
    await mkdir(join(appPath, 'src'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: {
        build: 'vite build',
        deploy: 'dangerous-publish-command'
      }
    }), 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-12T00:00:00.000Z',
        finishedAt: '2026-07-12T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(processPort.run).toHaveBeenCalledTimes(1)
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: { bin: 'npm', args: ['run', 'build'], cwd: appPath }
    }))
    expect(JSON.stringify(vi.mocked(processPort.run).mock.calls)).not.toContain('deploy')
  })
})
