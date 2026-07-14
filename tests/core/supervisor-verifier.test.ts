import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRunOptions, ProcessRunResult } from '../../src/main/process/process-runner'
import {
  SupervisorVerifier,
  type SupervisorBrowserEvidencePort,
  type SupervisorProcessPort
} from '../../src/main/orchestrator/supervisor-verifier'

function passingBrowserEvidence(): SupervisorBrowserEvidencePort {
  return {
    capture: vi.fn().mockResolvedValue({
      viewports: [
        {
          id: 'compact',
          width: 900,
          height: 640,
          screenshotCaptured: true,
          imageDataUrl: 'data:image/png;base64,Y29tcGFjdA==',
          visibleTextCharacters: 42,
          mainLandmark: true,
          horizontalOverflow: false,
          interactiveElementCount: 1,
          accessibleInteractiveElementCount: 1,
          interactionAttempted: true,
          interactionSucceeded: true,
          consoleErrors: [],
          pageErrors: []
        },
        {
          id: 'full',
          width: 1600,
          height: 900,
          screenshotCaptured: true,
          imageDataUrl: 'data:image/png;base64,ZnVsbA==',
          visibleTextCharacters: 42,
          mainLandmark: true,
          horizontalOverflow: false,
          interactiveElementCount: 1,
          accessibleInteractiveElementCount: 1,
          interactionAttempted: true,
          interactionSucceeded: true,
          consoleErrors: [],
          pageErrors: []
        }
      ]
    })
  }
}

describe('supervisor verifier', () => {
  it('independently accepts a complete direct HTML artifact', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-html-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Proof</title></head><body><main><h1>Hello</h1><button type="button">Begin</button></main></body></html>', 'utf8')
    const processPort: SupervisorProcessPort = { run: vi.fn() }
    const browserPort = passingBrowserEvidence()

    const result = await new SupervisorVerifier(processPort, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'artifact', outcome: 'passed' }),
      expect.objectContaining({ id: 'static:accessibility', outcome: 'passed' }),
      expect.objectContaining({ id: 'browser:compact', outcome: 'passed' }),
      expect.objectContaining({ id: 'browser:full', outcome: 'passed' }),
      expect.objectContaining({ id: 'browser:interaction', outcome: 'passed' })
    ]))
    expect(result.browserEvidence?.viewports).toHaveLength(2)
    expect(processPort.run).not.toHaveBeenCalled()
  })

  it('rejects obvious placeholder copy and inaccessible controls before browser capture', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-static-quality-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><h1>TODO replace this placeholder text</h1><button aria-label=""></button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'static:placeholder-copy', outcome: 'failed' }),
      expect.objectContaining({ id: 'static:accessibility', outcome: 'failed' })
    ]))
    expect(browserPort.capture).not.toHaveBeenCalled()
  })

  it('does not require an interaction from a semantic content-only artifact', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-content-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Field notes</title></head><body><main><h1>Field notes</h1><p>A complete locally readable reference.</p></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    vi.mocked(browserPort.capture).mockResolvedValue({
      viewports: [
        { id: 'compact', width: 900, height: 640, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,YQ==', visibleTextCharacters: 52, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 0, accessibleInteractiveElementCount: 0, interactionAttempted: false, interactionSucceeded: false, consoleErrors: [], pageErrors: [] },
        { id: 'full', width: 1600, height: 900, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,Yg==', visibleTextCharacters: 52, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 0, accessibleInteractiveElementCount: 0, interactionAttempted: false, interactionSucceeded: false, consoleErrors: [], pageErrors: [] }
      ]
    })

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'browser:interaction', outcome: 'skipped' }))
  })

  it('requires a rendered interaction when the artifact declares app behavior', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-interactive-app-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Interactive proof</title></head><body><div id="app"></div><script src="app.js"></script></body></html>', 'utf8')
    await writeFile(join(appPath, 'app.js'), 'document.querySelector("#app").innerHTML = "<main><h1>Rendered but inert</h1></main>"', 'utf8')
    const browserPort = passingBrowserEvidence()
    vi.mocked(browserPort.capture).mockResolvedValue({
      viewports: [
        { id: 'compact', width: 900, height: 640, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,YQ==', visibleTextCharacters: 18, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 0, accessibleInteractiveElementCount: 0, interactionAttempted: false, interactionSucceeded: false, consoleErrors: [], pageErrors: [] },
        { id: 'full', width: 1600, height: 900, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,Yg==', visibleTextCharacters: 18, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 0, accessibleInteractiveElementCount: 0, interactionAttempted: false, interactionSucceeded: false, consoleErrors: [], pageErrors: [] }
      ]
    })

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'browser:interaction', outcome: 'failed' }))
  })

  it('rejects browser evidence with viewport overflow or console failures', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-browser-quality-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><button>Begin</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({
      entryPath: join(appPath, 'index.html'),
      resourceRoot: appPath
    })
    const compactEvidence = evidence.viewports[0]
    if (!compactEvidence) throw new Error('Missing compact browser evidence fixture.')
    evidence.viewports[0] = {
      ...compactEvidence,
      horizontalOverflow: true,
      consoleErrors: ['Uncaught TypeError']
    }
    vi.mocked(browserPort.capture).mockResolvedValue(evidence)

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser:compact', outcome: 'failed' }),
      expect.objectContaining({ id: 'browser:console', outcome: 'failed' })
    ]))
  })

  it('can enforce supervisor-owned brief evidence without guessing from marketing copy', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-brief-fit-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><h1>Offline workspace</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [
          { id: 'offline', label: 'Works offline', polarity: 'require', evidenceTerms: ['offline'] },
          { id: 'export', label: 'Exports the result', polarity: 'require', evidenceTerms: ['export'] }
        ]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:export', outcome: 'failed' }))
  })

  it('does not accept a brief criterion without artifact evidence terms', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-unproven-brief-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><h1>Finished</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{ id: 'useful', label: 'Completes the core workflow', polarity: 'require', evidenceTerms: [] }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:useful', outcome: 'failed' }))
  })

  it('does not treat sealed consensus provenance as artifact proof of a human constraint', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-consensus-is-not-artifact-proof-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><h1>Generic finished page</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'csv-export',
          label: 'Exports a creator-ready CSV report',
          polarity: 'require',
          evidenceTerms: ['export', 'creator', 'csv', 'report']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:csv-export', outcome: 'failed' }))
  })

  it('passes a human constraint only when sealed provenance and implementation artifacts both support it', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-artifact-backed-brief-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button>Export CSV</button></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'csv-export',
          label: 'Exports a creator-ready CSV report',
          polarity: 'require',
          evidenceTerms: ['export', 'creator', 'csv', 'report']
        }]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'brief:consensus-provenance', outcome: 'passed' }),
      expect.objectContaining({ id: 'brief:csv-export', outcome: 'passed' })
    ]))
  })

  it('keeps sealed consensus provenance as an independent release check', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-provenance-separated-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button>Export CSV</button></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: false },
        criteria: [{
          id: 'csv-export',
          label: 'Exports a creator-ready CSV report',
          polarity: 'require',
          evidenceTerms: ['export', 'creator', 'csv', 'report']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'brief:consensus-provenance', outcome: 'failed' }),
      expect.objectContaining({ id: 'brief:csv-export', outcome: 'passed' })
    ]))
  })

  it('fails a prohibited brief constraint when implementation artifacts affirm the prohibited choice', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-prohibited-artifact-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Cloud workspace</title></head><body><main><h1>Cloud workspace</h1><p>This product requires a remote backend.</p></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'local-only',
          label: 'Do not require a remote backend',
          polarity: 'forbid',
          evidenceTerms: ['remote', 'backend']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:local-only', outcome: 'failed' }))
  })

  it('ignores restriction markers while distinguishing compliant and affirmative prohibited source', async () => {
    const compliantPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-negative-constraint-ok-'))
    await writeFile(join(compliantPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Local proof</title></head><body><main><h1>Local workspace</h1><p>Works without a remote backend.</p></main></body></html>', 'utf8')
    const contract = {
      consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
      criteria: [{
        id: 'local-only',
        label: 'Never use a remote backend',
        polarity: 'forbid' as const,
        evidenceTerms: ['never', 'use', 'remote', 'backend']
      }]
    }

    const compliant = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath: compliantPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: contract
    })

    const violatingPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-negative-constraint-bad-'))
    await writeFile(join(violatingPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Remote proof</title></head><body><main><h1>Cloud workspace</h1><p>The product uses a remote backend.</p></main></body></html>', 'utf8')
    const violating = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath: violatingPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: contract
    })

    expect(compliant.outcome).toBe('passed')
    expect(compliant.checks).toContainEqual(expect.objectContaining({ id: 'brief:local-only', outcome: 'passed' }))
    expect(violating.outcome).toBe('failed')
    expect(violating.checks).toContainEqual(expect.objectContaining({ id: 'brief:local-only', outcome: 'failed' }))
  })

  it('does not treat package metadata or comments as behavioral brief evidence', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-comment-only-brief-'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      name: 'creator-csv-export-report',
      description: 'Exports creator-ready CSV reports'
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Finished workspace</title></head><body><main><h1>Finished workspace</h1><button>Continue</button><script src="app.js"></script></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'app.js'), '// Export a creator-ready CSV report\ndocument.querySelector("button")?.addEventListener("click", () => undefined)\n', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'csv-export',
          label: 'Exports a creator-ready CSV report',
          polarity: 'require',
          evidenceTerms: ['export', 'creator', 'csv', 'report']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:csv-export', outcome: 'failed' }))
  })

  it('refuses to mark a browser artifact ready when browser proof is unavailable', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-headless-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><h1>Headless proof</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, null).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser:compact', outcome: 'failed' }),
      expect.objectContaining({ id: 'browser:full', outcome: 'failed' })
    ]))
  })

  it('runs an allowlisted UI build after check and captures the generated browser artifact', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-ui-build-'))
    await mkdir(join(appPath, 'src'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: {
        check: 'node check.js',
        build: 'vite build',
        dev: 'vite',
        deploy: 'dangerous-publish-command'
      },
      dependencies: { react: '^19.0.0', vite: '^7.0.0' }
    }), 'utf8')
    await writeFile(join(appPath, 'src', 'main.tsx'), 'document.querySelector("#root")?.replaceChildren("ready")\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn(async (options: ProcessRunOptions) => {
        const script = options.command.args[1]
        if (script === 'build') {
          await mkdir(join(appPath, 'dist'), { recursive: true })
          await writeFile(join(appPath, 'dist', 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Built UI</title></head><body><main><h1>Built UI</h1><button type="button">Begin</button></main></body></html>', 'utf8')
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          startedAt: '2026-07-12T00:00:00.000Z',
          finishedAt: '2026-07-12T00:00:01.000Z'
        }
      })
    }
    const browserPort = passingBrowserEvidence()

    const result = await new SupervisorVerifier(processPort, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('passed')
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: { bin: 'npm', args: ['run', 'check'], cwd: appPath }
    }))
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: { bin: 'npm', args: ['run', 'build'], cwd: appPath }
    }))
    expect(JSON.stringify(vi.mocked(processPort.run).mock.calls)).not.toContain('deploy')
    expect(browserPort.capture).toHaveBeenCalledWith(expect.objectContaining({
      entryPath: join(appPath, 'dist', 'index.html'),
      resourceRoot: join(appPath, 'dist')
    }))
  })

  it('fails a discoverable UI package that cannot produce a browser artifact without a dev server', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-ui-no-build-'))
    await mkdir(join(appPath, 'src'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite', test: 'vitest run' },
      dependencies: { react: '^19.0.0', vite: '^7.0.0' }
    }), 'utf8')
    await writeFile(join(appPath, 'src', 'main.tsx'), 'document.querySelector("#root")?.replaceChildren("ready")\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-12T00:00:00.000Z',
        finishedAt: '2026-07-12T00:00:01.000Z'
      })
    }
    const browserPort = passingBrowserEvidence()

    const result = await new SupervisorVerifier(processPort, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'browser:artifact',
      outcome: 'failed'
    }))
    expect(browserPort.capture).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(processPort.run).mock.calls)).not.toMatch(/\bdev\b/)
  })

  it('does not invoke browser evidence for a runnable non-UI service package', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-service-'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { start: 'node server.js', test: 'node --test' }
    }), 'utf8')
    await writeFile(join(appPath, 'server.js'), 'console.log("ready")\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-12T00:00:00.000Z',
        finishedAt: '2026-07-12T00:00:01.000Z'
      })
    }
    const browserPort = passingBrowserEvidence()

    const result = await new SupervisorVerifier(processPort, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('passed')
    expect(browserPort.capture).not.toHaveBeenCalled()
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'browser:not-applicable',
      outcome: 'skipped'
    }))
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

  it('forwards cancellation to an in-flight verification command', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-abort-'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build' }
    }), 'utf8')
    const controller = new AbortController()
    let processSettled = false
    const processPort: SupervisorProcessPort = {
      run: vi.fn((options: ProcessRunOptions) => new Promise<ProcessRunResult>((resolve) => {
        const finish = (): void => {
          processSettled = true
          resolve({
            exitCode: null,
            signal: null,
            timedOut: false,
            cancelled: true,
            cancelReason: 'user',
            startedAt: '2026-07-12T00:00:00.000Z',
            finishedAt: '2026-07-12T00:00:01.000Z'
          })
        }
        options.abortSignal?.addEventListener('abort', finish, { once: true })
        if (options.abortSignal?.aborted) finish()
      }))
    }

    const verification = new SupervisorVerifier(processPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 600_000,
      abortSignal: controller.signal
    })
    await vi.waitFor(() => expect(processPort.run).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(verification).resolves.toMatchObject({ outcome: 'failed' })
    expect(processSettled).toBe(true)
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
      timeoutMs: 600_000
    }))
  })
})
