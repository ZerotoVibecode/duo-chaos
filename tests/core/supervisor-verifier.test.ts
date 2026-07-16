import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
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
          interactionAttemptCount: 1,
          interactionSuccessCount: 1,
          pointerInteractionAttempted: true,
          pointerInteractionSucceeded: true,
          keyboardInteractionAttempted: true,
          keyboardInteractionSucceeded: true,
          externalNetworkRequestCount: 0,
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
          interactionAttemptCount: 1,
          interactionSuccessCount: 1,
          pointerInteractionAttempted: true,
          pointerInteractionSucceeded: true,
          keyboardInteractionAttempted: true,
          keyboardInteractionSucceeded: true,
          externalNetworkRequestCount: 0,
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

  it('requires the browser smoke to exercise multiple controls when they are available', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-multi-control-smoke-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Interactive proof</title></head><body><main><button type="button">First</button><button type="button">Second</button><button type="button">Third</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    vi.mocked(browserPort.capture).mockResolvedValue({
      viewports: [
        { id: 'compact', width: 900, height: 640, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,YQ==', visibleTextCharacters: 18, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 3, accessibleInteractiveElementCount: 3, interactionAttempted: true, interactionSucceeded: true, interactionAttemptCount: 1, interactionSuccessCount: 1, consoleErrors: [], pageErrors: [] },
        { id: 'full', width: 1600, height: 900, screenshotCaptured: true, imageDataUrl: 'data:image/png;base64,Yg==', visibleTextCharacters: 18, mainLandmark: true, horizontalOverflow: false, interactiveElementCount: 3, accessibleInteractiveElementCount: 3, interactionAttempted: true, interactionSucceeded: true, interactionAttemptCount: 1, interactionSuccessCount: 1, consoleErrors: [], pageErrors: [] }
      ]
    })

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'browser:interaction',
      outcome: 'failed'
    }))
  })

  it('rejects browser evidence with viewport overflow or console failures', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-browser-quality-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><button>Begin</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({
      entryPath: join(appPath, 'index.html'),
      resourceRoot: appPath
    })
    const compactEvidence = evidence.viewports.find((viewport) => viewport.id === 'compact')
    if (!compactEvidence) throw new Error('Missing compact browser evidence fixture.')
    evidence.viewports[evidence.viewports.findIndex((viewport) => viewport.id === 'compact')] = {
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

  it('rejects a windowed layout that fits the viewport but collapses text into character columns', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-compact-wrap-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><button>Begin</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({
      entryPath: join(appPath, 'index.html'),
      resourceRoot: appPath
    })
    const compactEvidence = evidence.viewports.find((viewport) => viewport.id === 'compact')
    if (!compactEvidence) throw new Error('Missing compact browser evidence fixture.')
    compactEvidence.severeTextWrapCount = 3
    vi.mocked(browserPort.capture).mockResolvedValue(evidence)

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'browser:compact',
      outcome: 'failed',
      detail: '3 severely wrapped visible text elements'
    }))
  })

  it('blocks reveal when native browser module loading rejects a CSS import by MIME type', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-css-module-mime-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Proof</title></head><body><main><button>Begin</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({
      entryPath: join(appPath, 'index.html'),
      resourceRoot: appPath
    })
    const compactEvidence = evidence.viewports.find((viewport) => viewport.id === 'compact')
    if (!compactEvidence) throw new Error('Missing compact browser evidence fixture.')
    evidence.viewports[evidence.viewports.findIndex((viewport) => viewport.id === 'compact')] = {
      ...compactEvidence,
      consoleErrors: [
        'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/css.'
      ]
    }
    vi.mocked(browserPort.capture).mockResolvedValue(evidence)

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'browser:console',
      outcome: 'failed'
    }))
    expect(result.summary).toMatch(/console defect/i)
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

  it('rejects an unrelated discovered built-in test as proof of a serious behavior contract', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-serious-tests-required-'))
    await mkdir(join(appPath, 'tests'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: {
        check: 'node check.js',
        test: 'node --test tests/*.test.js'
      }
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button type="button">Export CSV report</button></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'tests', 'math.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("math", () => assert.equal(1 + 1, 2))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-15T00:00:00.000Z',
        finishedAt: '2026-07-15T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
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
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'script:automated-tests',
      outcome: 'passed'
    }))
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'brief-test:csv-export',
      outcome: 'failed'
    }))
    expect(processPort.run).toHaveBeenCalledTimes(2)
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: { bin: 'npm', args: ['run', 'check'], cwd: appPath },
      stdoutPath: devNull,
      stderrPath: devNull
    }))
  })

  it('accepts serious test evidence when the executed check delegates to a real test runner', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-serious-tests-passed-'))
    await mkdir(join(appPath, 'tests'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: {
        check: 'npm run test && node check.js',
        test: 'node --test tests/*.test.js'
      }
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button type="button">Export CSV report</button></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'tests', 'export.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("exports creator CSV report", () => assert.match(exportCreatorCsvReport(), /csv/))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-15T00:00:00.000Z',
        finishedAt: '2026-07-15T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
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
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'script:automated-tests',
      outcome: 'passed'
    }))
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'brief-test:csv-export',
      outcome: 'passed'
    }))
  })

  it('executes assertion-bearing built-in node tests for a package-free serious artifact', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-package-free-node-test-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Decision deck</title></head><body><main><h1>Sort options</h1><button type="button">Sort options</button></main><script type="module" src="logic.js"></script></body></html>', 'utf8')
    await writeFile(join(appPath, 'logic.js'), 'export function rankOptions(options) { return [...options].sort() }\n', 'utf8')
    await writeFile(join(appPath, 'logic.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { rankOptions } from "./logic.js"\ntest("sort options", () => assert.deepEqual(rankOptions(["B", "A"]), ["A", "B"]))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      nodePath: 'C:\\Tools\\node.exe',
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'sort-options',
          label: 'Sorts the entered options',
          polarity: 'require',
          evidenceTerms: ['sort', 'options']
        }]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'script:node-test', outcome: 'passed' }),
      expect.objectContaining({ id: 'script:automated-tests', outcome: 'passed' }),
      expect.objectContaining({ id: 'brief-test:sort-options', outcome: 'passed' })
    ]))
    expect(processPort.run).toHaveBeenCalledTimes(1)
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        bin: 'C:\\Tools\\node.exe',
        args: ['--test', 'logic.test.mjs'],
        cwd: appPath
      },
      stdoutPath: devNull,
      stderrPath: devNull
    }))
  })

  it('fails closed when a discovered package-free built-in node test fails', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-package-free-node-test-failure-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Decision deck</title></head><body><main><h1>Sort options</h1></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'logic.js'), 'export function rankOptions(options) { return [...options].sort() }\n', 'utf8')
    await writeFile(join(appPath, 'logic.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("sort options", () => assert.equal(1, 2))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{ id: 'sort-options', kind: 'required-outcome', label: 'Sorts options', polarity: 'require', evidenceTerms: ['sort', 'options'] }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'script:node-test', outcome: 'failed', exitCode: 1 }))
    expect(result.summary).toMatch(/discovered built-in Node tests/i)
  })

  it('discovers package-free node tests deterministically without executing fixture tests', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-package-free-node-test-scope-'))
    await mkdir(join(appPath, 'tests', 'fixtures'), { recursive: true })
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Decision deck</title></head><body><main><h1>Sort options</h1></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'logic.js'), 'export function rankOptions(options) { return [...options].sort() }\n', 'utf8')
    const testSource = 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("sort options", () => assert.deepEqual(["A"], ["A"]))\n'
    await writeFile(join(appPath, 'z.test.mjs'), testSource, 'utf8')
    await writeFile(join(appPath, 'a.test.mjs'), testSource, 'utf8')
    await writeFile(join(appPath, 'tests', 'fixtures', 'failing.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("fixture must not execute", () => assert.fail("fixture"))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{ id: 'sort-options', kind: 'required-outcome', label: 'Sorts options', polarity: 'require', evidenceTerms: ['sort', 'options'] }]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(processPort.run).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        bin: 'node',
        args: ['--test', 'a.test.mjs', 'z.test.mjs'],
        cwd: appPath
      }
    }))
  })

  it('routes offline, static-server, mouse, and keyboard criteria to concrete supervisor evidence', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-concrete-platform-proof-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Decision deck</title></head><body><main><label for="options">Options</label><textarea id="options"></textarea><button type="button">Start ranking</button><output>Ready</output></main><script type="module" src="logic.js"></script></body></html>', 'utf8')
    await writeFile(join(appPath, 'logic.js'), 'export function rankOptions(options) { return [...options].sort() }\nwindow.addEventListener("keydown", () => document.querySelector("output").textContent = "Chosen")\n', 'utf8')
    await writeFile(join(appPath, 'logic.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\nimport { rankOptions } from "./logic.js"\ntest("sort options", () => assert.deepEqual(rankOptions(["B", "A"]), ["A", "B"]))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [
          { id: 'sort-options', kind: 'required-outcome', label: 'Sorts the entered options', polarity: 'require', evidenceTerms: ['sort', 'options'] },
          { id: 'offline', kind: 'platform', label: 'The artifact must work completely offline', polarity: 'require', evidenceTerms: ['artifact', 'work', 'offline'] },
          { id: 'static-server', kind: 'platform', label: 'Runnable from a simple local static server', polarity: 'require', evidenceTerms: ['local', 'static', 'server'] },
          { id: 'input', kind: 'capability', label: 'Support mouse and keyboard input', polarity: 'require', evidenceTerms: ['mouse', 'keyboard', 'input'] },
          { id: 'no-network', kind: 'restriction', label: 'No packages, CDNs, network calls, or build step', polarity: 'forbid', evidenceTerms: ['package', 'cdns', 'network', 'call', 'build', 'step'] }
        ]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'brief:offline', outcome: 'skipped' }),
      expect.objectContaining({ id: 'brief:static-server', outcome: 'skipped' }),
      expect.objectContaining({ id: 'brief:input', outcome: 'skipped' }),
      expect.objectContaining({ id: 'brief:no-network', outcome: 'skipped' }),
      expect.objectContaining({ id: 'supervisor:offline', outcome: 'passed' }),
      expect.objectContaining({ id: 'supervisor:static-server', outcome: 'passed' }),
      expect.objectContaining({ id: 'supervisor:input', outcome: 'passed' }),
      expect.objectContaining({ id: 'supervisor:no-network', outcome: 'passed' })
    ]))
    expect(result.checks).not.toContainEqual(expect.objectContaining({ id: 'brief-test:offline' }))
    expect(result.checks).not.toContainEqual(expect.objectContaining({ id: 'brief-test:static-server' }))
    expect(result.checks).not.toContainEqual(expect.objectContaining({ id: 'brief-test:input' }))
  })

  it('rejects an offline contract when source or browser evidence reaches for the network', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-offline-network-rejected-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Remote deck</title></head><body><main><h1>Remote deck</h1><button type="button">Load</button></main><script src="app.js"></script></body></html>', 'utf8')
    await writeFile(join(appPath, 'app.js'), 'document.querySelector("button").addEventListener("click", () => fetch("https://example.com/data.json"))\n', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({ entryPath: join(appPath, 'index.html'), resourceRoot: appPath })
    evidence.viewports = evidence.viewports.map((viewport) => ({ ...viewport, externalNetworkRequestCount: 1 }))
    vi.mocked(browserPort.capture).mockResolvedValue(evidence)

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'offline',
          kind: 'platform',
          label: 'The artifact must work completely offline',
          polarity: 'require',
          evidenceTerms: ['artifact', 'work', 'offline']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'supervisor:offline', outcome: 'failed' }))
  })

  it('rejects a dormant external XMLHttpRequest that runtime interaction did not exercise', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-offline-dormant-xhr-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Offline deck</title></head><body><main><h1>Offline deck</h1></main><script src="app.js"></script></body></html>', 'utf8')
    await writeFile(join(appPath, 'app.js'), 'function dormantSync() { const xhr = new XMLHttpRequest(); xhr.open("GET", "https://example.com/data.json"); return xhr }\n', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'offline',
          kind: 'platform',
          label: 'The artifact must work completely offline',
          polarity: 'require',
          evidenceTerms: ['artifact', 'work', 'offline']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'supervisor:offline', outcome: 'failed' }))
  })

  it('rejects a keyboard capability when the browser never observes keyboard-driven behavior', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-keyboard-proof-required-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Mouse only</title></head><body><main><button type="button">Choose</button></main></body></html>', 'utf8')
    const browserPort = passingBrowserEvidence()
    const evidence = await browserPort.capture({ entryPath: join(appPath, 'index.html'), resourceRoot: appPath })
    evidence.viewports = evidence.viewports.map((viewport) => ({
      ...viewport,
      nativeKeyboardControlCount: 1,
      keyboardInteractionAttempted: true,
      keyboardInteractionSucceeded: false
    }))
    vi.mocked(browserPort.capture).mockResolvedValue(evidence)

    const result = await new SupervisorVerifier({ run: vi.fn() }, browserPort).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'keyboard',
          kind: 'capability',
          label: 'Support keyboard input',
          polarity: 'require',
          evidenceTerms: ['keyboard', 'input']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'supervisor:keyboard', outcome: 'failed' }))
  })

  it('keeps non-input behavioral capabilities bound to relevant automated tests', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-behavioral-capability-tests-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Report</title></head><body><main><button type="button">Export CSV report</button></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'logic.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("unrelated arithmetic", () => assert.equal(2 + 2, 4))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'csv-export',
          kind: 'capability',
          label: 'Support creator-ready CSV export',
          polarity: 'require',
          evidenceTerms: ['creator', 'csv', 'export']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief-test:csv-export', outcome: 'failed' }))
  })

  it('proves every clause of a compound no-network, no-package, and no-build restriction', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-compound-restriction-'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { build: 'node build.js' },
      dependencies: { leftpad: 'latest' }
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Deck</title></head><body><main><h1>Deck</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'contained',
          kind: 'restriction',
          label: 'No packages, CDNs, network calls, or build step',
          polarity: 'forbid',
          evidenceTerms: ['package', 'cdn', 'network', 'call', 'build', 'step']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    const containedCheck = result.checks.find((check) => check.id === 'supervisor:contained')
    expect(containedCheck).toMatchObject({
      id: 'supervisor:contained',
      outcome: 'failed'
    })
    expect(containedCheck?.detail).toMatch(/no-dependencies.*no-build-step/)
  })

  it('does not silently skip an unknown platform criterion without a concrete proof route', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-unknown-platform-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Deck</title></head><body><main><h1>Deck</h1></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'linux',
          kind: 'platform',
          label: 'Runs as a native Linux desktop application',
          polarity: 'require',
          evidenceTerms: ['native', 'linux', 'desktop']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:linux', outcome: 'failed' }))
    expect(result.checks).not.toContainEqual(expect.objectContaining({ id: 'supervisor:linux' }))
  })

  it('keeps a kinded remote-backend restriction under affirmative source enforcement', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-kinded-remote-backend-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Cloud workspace</title></head><body><main><h1>Cloud workspace</h1><p>This product requires a remote backend.</p></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'local-only',
          kind: 'restriction',
          label: 'Never use a remote backend',
          polarity: 'forbid',
          evidenceTerms: ['never', 'use', 'remote', 'backend']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'brief:local-only', outcome: 'failed' }))
  })

  it('does not drop supervisor-routed obligations on a non-browser artifact path', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-non-browser-routed-contract-'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: {
        start: 'node service.js',
        test: 'node --test service.test.mjs'
      }
    }), 'utf8')
    await writeFile(join(appPath, 'service.js'), 'export const status = () => "ready"\n', 'utf8')
    await writeFile(join(appPath, 'service.test.mjs'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("service status", () => assert.equal("ready", "ready"))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-16T00:00:00.000Z',
        finishedAt: '2026-07-16T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'offline',
          kind: 'platform',
          label: 'Works completely offline',
          polarity: 'require',
          evidenceTerms: ['work', 'offline']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'supervisor:offline', outcome: 'failed' }))
  })

  it('does not confuse inert URL copy with a runtime network dependency', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-offline-url-copy-'))
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Reference</title></head><body><main><h1>Reference</h1><p>Example syntax: https://example.com/path</p></main></body></html>', 'utf8')

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'offline',
          kind: 'platform',
          label: 'Works completely offline',
          polarity: 'require',
          evidenceTerms: ['work', 'offline']
        }]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'supervisor:offline', outcome: 'passed' }))
  })

  it('rejects an unrelated passing test as proof of a serious behavior criterion', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-serious-unrelated-test-'))
    await mkdir(join(appPath, 'tests'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test tests/*.test.js' }
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button type="button">Export CSV report</button></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'tests', 'math.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("math", () => assert.equal(1 + 1, 2))\n', 'utf8')
    const processPort: SupervisorProcessPort = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        startedAt: '2026-07-15T00:00:00.000Z',
        finishedAt: '2026-07-15T00:00:01.000Z'
      })
    }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
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
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'script:automated-tests',
      outcome: 'passed'
    }))
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'brief-test:csv-export',
      outcome: 'failed'
    }))
  })

  it('ignores a matching serious test file when the executed command selects a different test', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-serious-unexecuted-test-'))
    await mkdir(join(appPath, 'tests'))
    await writeFile(join(appPath, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test tests/math.test.js' }
    }), 'utf8')
    await writeFile(join(appPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Creator report</title></head><body><main><h1>Creator report</h1><button type="button">Export CSV report</button></main></body></html>', 'utf8')
    await writeFile(join(appPath, 'tests', 'math.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("math", () => assert.equal(1 + 1, 2))\n', 'utf8')
    await writeFile(join(appPath, 'tests', 'export.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("exports creator CSV report", () => assert.match("creator CSV export report", /export/))\n', 'utf8')
    const processPort: SupervisorProcessPort = { run: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      startedAt: '2026-07-15T00:00:00.000Z',
      finishedAt: '2026-07-15T00:00:01.000Z'
    }) }

    const result = await new SupervisorVerifier(processPort, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        missionProfile: 'serious',
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
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'script:automated-tests',
      outcome: 'passed'
    }))
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'brief-test:csv-export',
      outcome: 'failed'
    }))
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

  it('verifies prohibited phrase groups without rejecting unrelated words or morphology', async () => {
    const compliantPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-phrase-group-ok-'))
    await writeFile(join(compliantPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Local layout</title></head><body><main><h1>Local-first layout</h1><p>The garden uses an overflow chip and no remote fonts.</p></main></body></html>', 'utf8')
    const criteria = [{
      id: 'layout-network',
      label: 'No horizontal overflow or remote fonts',
      polarity: 'forbid' as const,
      evidenceTerms: ['horizontal', 'overflow', 'remote', 'fonts'],
      evidenceGroups: [['horizontal', 'overflow'], ['remote', 'fonts']]
    }]

    const compliant = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath: compliantPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria
      }
    })

    const violatingPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-phrase-group-bad-'))
    await writeFile(join(violatingPath, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Remote layout</title></head><body><main><h1>Remote layout</h1><p>The page loads a remote font and enables horizontal overflow.</p></main></body></html>', 'utf8')
    const violating = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath: violatingPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria
      }
    })

    expect(compliant.checks).toContainEqual(expect.objectContaining({ id: 'brief:layout-network', outcome: 'passed' }))
    expect(violating.checks).toContainEqual(expect.objectContaining({ id: 'brief:layout-network', outcome: 'failed' }))
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

  it('does not let a healthy generic browser artifact satisfy a specific required outcome', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-required-outcome-'))
    await writeFile(
      join(appPath, 'index.html'),
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Healthy shell</title></head><body><main><h1>Healthy shell</h1><button>Continue</button></main></body></html>',
      'utf8'
    )

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [{
          id: 'encrypted-backup',
          kind: 'required-outcome',
          label: 'Produce a downloadable encrypted backup archive',
          polarity: 'require',
          evidenceTerms: ['downloadable', 'encrypted', 'backup', 'archive']
        }]
      }
    })

    expect(result.outcome).toBe('failed')
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'brief:encrypted-backup',
      outcome: 'failed'
    }))
    expect(result.checks).not.toContainEqual(expect.objectContaining({
      id: 'browser:qualitative-contract',
      outcome: 'passed'
    }))
  })

  it('routes qualitative browser requirements to rendered proof instead of brittle source wording', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'duo-supervisor-rendered-quality-'))
    await writeFile(
      join(appPath, 'index.html'),
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Garden</title></head><body><main><h1>Garden</h1><button>Plant task</button></main></body></html>',
      'utf8'
    )

    const result = await new SupervisorVerifier({ run: vi.fn() }, passingBrowserEvidence()).verify({
      appPath,
      npmPath: 'npm',
      timeoutMs: 30_000,
      qualityContract: {
        consensusProvenance: { verified: true, evidenceHandle: 'consensus-provenance:sealed-fingerprint' },
        criteria: [
          {
            id: 'visual-quality',
            kind: 'required-outcome',
            label: 'Produce a distinctive, cinematic, cohesive visual direction rather than a generic dashboard',
            polarity: 'require',
            evidenceTerms: ['distinctive', 'cinematic', 'cohesive', 'visual', 'generic']
          },
          {
            id: 'common-visual-language',
            kind: 'required-outcome',
            label: 'Build a good-looking modern website',
            polarity: 'require',
            evidenceTerms: ['good', 'looking', 'modern', 'website']
          }
        ]
      }
    })

    expect(result.outcome).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'brief:visual-quality', outcome: 'skipped' }),
      expect.objectContaining({ id: 'brief:common-visual-language', outcome: 'skipped' }),
      expect.objectContaining({ id: 'browser:qualitative-contract', outcome: 'passed' })
    ]))
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
    const invokedDevScript = vi.mocked(processPort.run).mock.calls.some(([request]) => (
      request.command.args[0] === 'run' && request.command.args[1] === 'dev'
    ))
    expect(invokedDevScript).toBe(false)
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
