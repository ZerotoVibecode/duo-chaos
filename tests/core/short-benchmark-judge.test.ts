import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const scriptPath = path.join(repoRoot, 'scripts', 'judge-short-benchmark.mjs')
const sourceFixture = path.join(repoRoot, 'tests', 'fixtures', 'benchmarks', 'short-judge')
const casesRoot = path.join(repoRoot, 'benchmark-results', 'judge-contract-tests')

type JudgeReport = {
  schemaVersion: number
  status: 'pass' | 'fail'
  entry?: string
  checks: Array<{ id: string; pass: boolean; detail?: string }>
  screenshots: string[]
}

async function prepareCase(id: string): Promise<string> {
  const runRoot = path.join(casesRoot, id)
  const workspace = path.join(runRoot, 'preserved-workspace')
  await rm(runRoot, { force: true, recursive: true })
  await mkdir(workspace, { recursive: true })
  await cp(sourceFixture, workspace, { recursive: true })
  return workspace
}

async function runJudge(workspace: string): Promise<{ report: JudgeReport; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, workspace, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true
    })
    return { report: JSON.parse(stdout) as JudgeReport, exitCode: 0 }
  } catch (error) {
    const failure = error as Error & { stdout?: string; code?: number }
    if (!failure.stdout) throw error
    return {
      report: JSON.parse(failure.stdout) as JudgeReport,
      exitCode: typeof failure.code === 'number' ? failure.code : 1
    }
  }
}

describe('short benchmark artifact judge', () => {
  beforeAll(async () => {
    await mkdir(casesRoot, { recursive: true })
  })

  afterAll(async () => {
    await rm(casesRoot, { force: true, recursive: true })
  })

  it('passes the fixed Decision Deck contract and writes both viewport screenshots', async () => {
    const workspace = await prepareCase('passing-artifact')
    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(0)
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'pass',
      entry: 'app/index.html'
    })
    expect(report.checks.every((check) => check.pass)).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'workspace-boundary',
        'safe-app-tree',
        'external-dependencies',
        'testid-contract',
        'three-option-flow',
        'choice-sensitive-ranking',
        'seven-option-flow',
        'input-boundaries',
        'reload-persistence',
        'deterministic-ranking',
        'keyboard-activation',
        'reset',
        'browser-errors',
        'external-network',
        'service-workers',
        'authored-test-contract',
        'logic-export-contract',
        'viewport-900x640',
        'viewport-1600x900',
        'reduced-motion-css'
      ])
    )
    expect(report.screenshots).toEqual(['judge/viewport-900x640.png', 'judge/viewport-1600x900.png'])

    const runRoot = path.dirname(workspace)
    const [compactScreenshot, fullScreenshot] = report.screenshots
    if (!compactScreenshot || !fullScreenshot) throw new Error('Expected both bounded judge screenshots.')
    await expect(readFile(path.join(runRoot, 'judge', 'report.json'), 'utf8')).resolves.toContain('"status": "pass"')
    await expect(readFile(path.join(runRoot, compactScreenshot))).resolves.toBeInstanceOf(Buffer)
    await expect(readFile(path.join(runRoot, fullScreenshot))).resolves.toBeInstanceOf(Buffer)
  })

  it('never executes an agent-authored test file while applying repo-owned browser checks', async () => {
    const workspace = await prepareCase('untrusted-test-is-not-executed')
    const marker = path.join(workspace, 'agent-test-executed.txt')
    const authoredTest = path.join(workspace, 'app', 'logic.test.mjs')
    const original = await readFile(authoredTest, 'utf8')
    await writeFile(
      authoredTest,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n${original}`,
      'utf8'
    )

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(0)
    expect(report.status).toBe('pass')
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an empty authored test even when the rendered app still works', async () => {
    const workspace = await prepareCase('empty-authored-test')
    await writeFile(path.join(workspace, 'app', 'logic.test.mjs'), '')

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'authored-test-contract', pass: false }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'logic-export-contract', pass: true }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'three-option-flow', pass: true }))
  })

  it('rejects an empty logic module instead of accepting placeholder required files', async () => {
    const workspace = await prepareCase('empty-logic-module')
    await writeFile(path.join(workspace, 'app', 'logic.js'), '')

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'logic-export-contract', pass: false }))
  })

  it('blocks WebSocket attempts and records them as external network activity', async () => {
    const workspace = await prepareCase('external-websocket')
    const entry = path.join(workspace, 'app', 'index.html')
    const html = await readFile(entry, 'utf8')
    await writeFile(entry, html.replace('</body>', '<script>new WebSocket("wss://example.invalid/socket")</script>\n</body>'))

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    const networkCheck = report.checks.find((check) => check.id === 'external-network')
    expect(networkCheck).toMatchObject({ id: 'external-network', pass: false })
    expect(networkCheck?.detail).toMatch(/websocket|wss/iu)
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'service-workers', pass: true }))
  })

  it('launches the browser judge with service workers blocked before navigation', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toMatch(/newContext\([^)]*serviceWorkers:\s*['"]block['"]/su)
    expect(source).toMatch(/routeWebSocket\([^)]*\*\*\/\*/su)
  })

  it('rejects a workspace outside the ignored benchmark-results root before execution', async () => {
    const outside = path.join(repoRoot, 'tests', 'fixtures', 'benchmarks', 'short-judge')
    const { report, exitCode } = await runJudge(outside)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'workspace-boundary', pass: false })
    )
  })

  it('rejects an external browser dependency without contacting it', async () => {
    const workspace = await prepareCase('external-dependency')
    const entry = path.join(workspace, 'app', 'index.html')
    const html = await readFile(entry, 'utf8')
    await writeFile(entry, html.replace('</body>', '<img src="https://example.com/tracker.png" alt="">\n</body>'))

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'external-dependencies', pass: false })
    )
    expect(report.checks).not.toContainEqual(expect.objectContaining({ id: 'three-option-flow' }))
  })

  it('records missing reduced motion as a quality failure but still runs functional browser checks', async () => {
    const workspace = await prepareCase('missing-reduced-motion')
    const entry = path.join(workspace, 'app', 'index.html')
    const html = await readFile(entry, 'utf8')
    await writeFile(entry, html.replace(/^\s*@media \(prefers-reduced-motion: reduce\).*$/mu, ''))

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'reduced-motion-css',
      pass: false,
      detail: 'No prefers-reduced-motion CSS rule was found.'
    }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'choice-sensitive-ranking', pass: true }))
    expect(report.screenshots).toHaveLength(2)
  })

  it('records an inaccessible completed-state reset without abandoning independent checks', async () => {
    const workspace = await prepareCase('inaccessible-completed-reset')
    const entry = path.join(workspace, 'app', 'index.html')
    const html = await readFile(entry, 'utf8')
    await writeFile(
      entry,
      html.replace('</style>', 'body:has(#result:not([hidden])) [data-testid="reset"] { display: none; }\n    </style>')
    )

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'reset', pass: false }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'choice-sensitive-ranking', pass: true }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'seven-option-flow', pass: true }))
    expect(report.checks).not.toContainEqual(expect.objectContaining({ id: 'browser-execution' }))
    expect(report.screenshots).toHaveLength(2)
  })

  it('rejects linked content instead of traversing it', async () => {
    const workspace = await prepareCase('linked-content')
    await symlink(sourceFixture, path.join(workspace, 'app', 'linked-content'), 'junction')

    const { report, exitCode } = await runJudge(workspace)

    expect(exitCode).toBe(1)
    expect(report.status).toBe('fail')
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'safe-app-tree', pass: false })
    )
  })
})
