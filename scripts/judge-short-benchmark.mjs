/* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDirectory, '..')
const benchmarkRoot = path.join(repoRoot, 'benchmark-results')
const MAX_WEB_FILES = 256
const MAX_WEB_BYTES = 2 * 1024 * 1024
const MAX_DETAIL_LENGTH = 240
const APP_CANDIDATES = ['app/index.html', 'index.html', 'dist/index.html', 'public/index.html']
const WEB_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.cjs'])
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
])

const startedAt = Date.now()
const checks = []
const screenshots = []
let reportDirectory
let workspacePath

function normalizeForComparison(value) {
  const normalized = path.resolve(value).replaceAll('/', path.sep)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isStrictDescendant(parent, child) {
  const relative = path.relative(normalizeForComparison(parent), normalizeForComparison(child))
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sanitizeDetail(value) {
  let detail = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  if (workspacePath) detail = detail.replaceAll(workspacePath, '<workspace>')
  detail = detail.replaceAll(repoRoot, '<repo>')
  detail = detail.replaceAll(homedir(), '<home>')
  return detail.slice(0, MAX_DETAIL_LENGTH)
}

function recordCheck(id, pass, detail) {
  const check = { id, pass: Boolean(pass) }
  const safeDetail = sanitizeDetail(detail)
  if (safeDetail) check.detail = safeDetail
  checks.push(check)
  return check.pass
}

function reportPayload() {
  const entryCheck = checks.find((check) => check.id === 'safe-app-tree' && check.pass)
  const entry = entryCheck?.detail?.startsWith('Entry ') ? entryCheck.detail.slice('Entry '.length) : undefined
  return {
    schemaVersion: 1,
    status: checks.length > 0 && checks.every((check) => check.pass) ? 'pass' : 'fail',
    ...(entry ? { entry } : {}),
    checks: checks.slice(0, 64),
    screenshots: screenshots.slice(0, 4),
    durationMs: Math.min(Date.now() - startedAt, 24 * 60 * 60 * 1000)
  }
}

async function emitReport() {
  const report = reportPayload()
  if (reportDirectory) {
    await mkdir(reportDirectory, { recursive: true })
    await writeFile(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exitCode = report.status === 'pass' ? 0 : 1
}

async function lstatOrUndefined(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertNoLinkedComponents(root, target) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path escaped its approved root.')
  }

  let current = root
  const parts = relative.split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new Error('Linked filesystem content is not allowed.')
  }
}

async function validateWorkspace(requestedPath) {
  await mkdir(benchmarkRoot, { recursive: true })
  const canonicalRoot = await realpath(benchmarkRoot)
  const lexicalTarget = path.resolve(requestedPath)
  if (!isStrictDescendant(canonicalRoot, lexicalTarget)) throw new Error('Workspace must be below benchmark-results.')
  await assertNoLinkedComponents(canonicalRoot, lexicalTarget)
  const metadata = await lstat(lexicalTarget)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Workspace must be an unlinked directory.')
  const canonicalTarget = await realpath(lexicalTarget)
  if (!isStrictDescendant(canonicalRoot, canonicalTarget)) throw new Error('Workspace resolved outside benchmark-results.')
  if (path.basename(canonicalTarget).toLowerCase() !== 'preserved-workspace') {
    throw new Error('Expected a preserved-workspace directory.')
  }
  return canonicalTarget
}

async function safeRegularFile(root, relativePath) {
  const target = path.resolve(root, relativePath)
  if (!isStrictDescendant(root, target)) return undefined
  const metadata = await lstatOrUndefined(target)
  if (!metadata) return undefined
  await assertNoLinkedComponents(root, target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
  return target
}

async function collectSafeTree(root) {
  const files = []
  let totalBytes = 0

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Linked filesystem content is not allowed in the app tree.')
      if (entry.isDirectory()) {
        await visit(target)
        continue
      }
      if (!entry.isFile()) throw new Error('Only regular files and directories are allowed in the app tree.')
      const metadata = await stat(target)
      totalBytes += metadata.size
      files.push(target)
      if (files.length > MAX_WEB_FILES || totalBytes > MAX_WEB_BYTES) {
        throw new Error('App tree exceeded the bounded judge input limit.')
      }
    }
  }

  await visit(root)
  return files
}

function countExternalReferences(source) {
  const patterns = [
    /(?:src|href)\s*=\s*["'](?:https?:)?\/\//giu,
    /url\(\s*["']?(?:https?:)?\/\//giu,
    /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//giu,
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](?:https?:)?\/\//giu
  ]
  return patterns.reduce((count, pattern) => count + [...source.matchAll(pattern)].length, 0)
}

async function inspectWebSources(files) {
  let externalReferences = 0
  let reducedMotion = false
  for (const file of files) {
    if (!WEB_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const source = await readFile(file, 'utf8')
    externalReferences += countExternalReferences(source)
    if (/@media\s*\([^)]*prefers-reduced-motion\s*:/iu.test(source)) reducedMotion = true
  }
  return { externalReferences, reducedMotion }
}

async function inspectAuthoredTestContract(appRoot) {
  const authoredTest = await safeRegularFile(appRoot, 'logic.test.mjs')
  if (!authoredTest) return { pass: false, detail: 'No safe logic.test.mjs file was found beside the app entry.' }
  const source = await readFile(authoredTest, 'utf8')
  const substantive = source.trim().length >= 120
  const importsTest = /(?:from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\))/u.test(source)
  const importsAssert = /(?:from\s+['"]node:assert(?:\/strict)?['"]|require\(\s*['"]node:assert(?:\/strict)?['"]\s*\))/u.test(source)
  const importsLogic = /(?:from\s+['"]\.\/logic\.js['"]|import\(\s*['"]\.\/logic\.js['"]\s*\))/u.test(source)
  const hasCase = /\b(?:test|it)\s*\(/u.test(source)
  const hasAssertion = /\b(?:assert(?:\.[A-Za-z]+)?|expect)\s*\(/u.test(source)
  const pass = substantive && importsTest && importsAssert && importsLogic && hasCase && hasAssertion
  return {
    pass,
    detail: pass
      ? 'logic.test.mjs contains a local node:test contract for logic.js.'
      : 'logic.test.mjs is missing a substantive node:test, assertion, or local logic.js contract.'
  }
}

async function createStaticPreview(root) {
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(405).end()
        return
      }
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const decoded = decodeURIComponent(requestUrl.pathname)
      const relative = decoded === '/' ? 'index.html' : path.posix.normalize(decoded.slice(1))
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        response.writeHead(403).end()
        return
      }
      const file = path.resolve(root, ...relative.split('/'))
      if (!isStrictDescendant(root, file)) {
        response.writeHead(403).end()
        return
      }
      await assertNoLinkedComponents(root, file)
      const metadata = await lstat(file)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        response.writeHead(404).end()
        return
      }
      const body = await readFile(file)
      response.writeHead(200, {
        'content-type': MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(404).end()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Static preview did not bind to a local port.')
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`
  }
}

async function visibleRankingOrder(page, options) {
  const rows = await page.getByTestId('ranking-item').allTextContents()
  return rows.map((row) => options.find((option) => row.includes(option)) ?? '')
}

async function hasVisibleRanking(page) {
  return await page.getByTestId('ranking-item').evaluateAll((nodes) => nodes.some((node) => {
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0
  }))
}

async function runRanking(page, options, choices) {
  await page.getByTestId('options-input').fill(options.join('\n'))
  await page.getByTestId('start').click()
  let decision = 0
  while (!(await hasVisibleRanking(page)) && decision < 24) {
    const side = choices[decision] ?? choices.at(-1) ?? 'left'
    const choice = side === 'left' ? page.getByTestId('choose-left') : page.getByTestId('choose-right')
    if (!(await choice.isVisible())) break
    await choice.click()
    decision += 1
  }
  return visibleRankingOrder(page, options)
}

async function viewportFact(page, width, height, screenshotName) {
  await page.setViewportSize({ width, height })
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight
  }))
  const pass = dimensions.width <= dimensions.clientWidth + 1 && dimensions.height <= dimensions.clientHeight + 1
  const screenshotPath = path.join(reportDirectory, screenshotName)
  await page.screenshot({ path: screenshotPath, fullPage: false })
  screenshots.push(`judge/${screenshotName}`)
  return {
    pass,
    detail: `${dimensions.width}x${dimensions.height} content in ${dimensions.clientWidth}x${dimensions.clientHeight} viewport.`
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    if (!String(error?.message ?? '').includes("Executable doesn't exist")) throw error
  }

  const systemCandidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']

  for (const executablePath of systemCandidates) {
    const metadata = await lstatOrUndefined(executablePath)
    if (metadata?.isFile() && !metadata.isSymbolicLink()) {
      return chromium.launch({ executablePath, headless: true })
    }
  }
  throw new Error('No installed Chromium browser is available for deterministic artifact judging.')
}

async function runBrowserChecks(origin) {
  const browser = await launchBrowser()
  const context = await browser.newContext({
    viewport: { width: 900, height: 640 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  })
  const externalRequests = new Set()
  const browserErrors = []
  const page = await context.newPage()
  const localOrigin = new URL(origin).origin
  let resetInteractionPass = true

  async function resetForNextScenario() {
    const reset = page.getByTestId('reset')
    if (resetInteractionPass) {
      try {
        await reset.click({ timeout: 2_000 })
        return
      } catch {
        resetInteractionPass = false
      }
    }

    // Keep independent benchmark checks runnable after recording that a real
    // user could not operate Reset. DOM activation is only test recovery; it
    // never turns the failed usability requirement into a pass.
    await reset.evaluate((element) => element.click())
  }

  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === localOrigin) {
      await route.continue()
      return
    }
    externalRequests.add(new URL(url).protocol)
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', async (websocket) => {
    let protocol = 'websocket'
    try {
      protocol = new URL(websocket.url()).protocol
    } catch {
      // Keep the generic protocol label for malformed URLs.
    }
    externalRequests.add(`websocket ${protocol}`)
    await websocket.close({ code: 1008, reason: 'External network is disabled by the benchmark judge.' })
  })
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  try {
    await page.goto(`${origin}/`, { waitUntil: 'networkidle', timeout: 15_000 })
    const logicContract = await page.evaluate(async () => {
      try {
        const module = await import('./logic.js?duo-judge-contract=1')
        const functions = Object.entries(module).filter((entry) => typeof entry[1] === 'function')
        const options = ['Amber', 'Blue', 'Crimson']
        const choices = ['left', 'right', 'left']
        for (const [name, candidate] of functions) {
          try {
            const firstOptions = [...options]
            const firstChoices = [...choices]
            const first = candidate(firstOptions, firstChoices)
            if (first && typeof first.then === 'function') continue
            const secondOptions = [...options]
            const secondChoices = [...choices]
            const second = candidate(secondOptions, secondChoices)
            if (second && typeof second.then === 'function') continue
            const stable = first !== undefined
              && JSON.stringify(first) === JSON.stringify(second)
              && JSON.stringify(firstOptions) === JSON.stringify(options)
              && JSON.stringify(firstChoices) === JSON.stringify(choices)
              && JSON.stringify(secondOptions) === JSON.stringify(options)
              && JSON.stringify(secondChoices) === JSON.stringify(choices)
            if (stable) return { pass: true, exportName: name }
          } catch {
            // Another exported function may implement the pure ranking contract.
          }
        }
        return { pass: false }
      } catch {
        return { pass: false }
      }
    })
    recordCheck(
      'logic-export-contract',
      logicContract.pass,
      logicContract.pass
        ? `Imported deterministic non-mutating export ${logicContract.exportName}.`
        : 'logic.js did not expose an importable deterministic non-mutating function.'
    )
    const initialIds = ['options-input', 'start', 'choose-left', 'choose-right', 'reset', 'status']
    const initialContract = await Promise.all(initialIds.map(async (id) => (await page.getByTestId(id).count()) === 1))

    await resetForNextScenario()
    await page.getByTestId('options-input').fill('Amber\nBlue\nCrimson')
    await page.getByTestId('start').focus()
    await page.keyboard.press('Enter')
    const pairOpened = await page.getByTestId('choose-left').isVisible()
    const beforeKeyboardChoice = await page.evaluate(() => JSON.stringify(localStorage))
    await page.getByTestId('choose-left').focus()
    await page.keyboard.press('Enter')
    const afterKeyboardChoice = await page.evaluate(() => JSON.stringify(localStorage))
    recordCheck('keyboard-activation', pairOpened && beforeKeyboardChoice !== afterKeyboardChoice, 'Enter activates start and a pairwise choice.')

    const persistedBeforeReload = await page.evaluate(() => ({
      length: localStorage.length,
      values: Object.values(localStorage).sort()
    }))
    await page.reload({ waitUntil: 'networkidle' })
    const persistedAfterReload = await page.evaluate(() => ({
      length: localStorage.length,
      values: Object.values(localStorage).sort()
    }))
    const resumed = await page.getByTestId('choose-left').isVisible() || (await page.getByTestId('ranking-item').count()) === 3
    recordCheck(
      'reload-persistence',
      persistedBeforeReload.length > 0 && JSON.stringify(persistedBeforeReload) === JSON.stringify(persistedAfterReload) && resumed,
      'Active comparison state survives a reload.'
    )

    let decision = 1
    while ((await page.getByTestId('ranking-item').count()) === 0 && decision < 24) {
      const choice = decision % 2 === 0 ? page.getByTestId('choose-left') : page.getByTestId('choose-right')
      if (!(await choice.isVisible())) break
      await choice.click()
      decision += 1
    }
    const firstRanking = await visibleRankingOrder(page, ['Amber', 'Blue', 'Crimson'])
    recordCheck('three-option-flow', JSON.stringify(firstRanking) === JSON.stringify(['Amber', 'Blue', 'Crimson']), 'The mixed three-option contract reaches the expected stable ranking.')
    recordCheck('testid-contract', initialContract.every(Boolean) && firstRanking.length === 3, 'All required data-testid hooks are present.')

    await resetForNextScenario()
    const secondRanking = await runRanking(page, ['Amber', 'Blue', 'Crimson'], ['left', 'right', 'left'])
    recordCheck(
      'deterministic-ranking',
      firstRanking.length === 3 && JSON.stringify(firstRanking) === JSON.stringify(secondRanking),
      'The same options and decision sequence produce the same ranking.'
    )

    await resetForNextScenario()
    const allLeft = await runRanking(page, ['Amber', 'Blue', 'Crimson'], ['left'])
    await resetForNextScenario()
    const allRight = await runRanking(page, ['Amber', 'Blue', 'Crimson'], ['right'])
    await resetForNextScenario()
    const decisiveMixed = await runRanking(page, ['Amber', 'Blue', 'Crimson'], ['right', 'right', 'left'])
    recordCheck(
      'choice-sensitive-ranking',
      JSON.stringify(allLeft) === JSON.stringify(['Amber', 'Blue', 'Crimson'])
        && JSON.stringify(allRight) === JSON.stringify(['Crimson', 'Blue', 'Amber'])
        && JSON.stringify(decisiveMixed) === JSON.stringify(['Blue', 'Crimson', 'Amber']),
      `Observed left=${JSON.stringify(allLeft)}, right=${JSON.stringify(allRight)}, mixed=${JSON.stringify(decisiveMixed)}.`
    )

    const compact = await viewportFact(page, 900, 640, 'viewport-900x640.png')
    recordCheck('viewport-900x640', compact.pass, compact.detail)
    const full = await viewportFact(page, 1600, 900, 'viewport-1600x900.png')
    recordCheck('viewport-1600x900', full.pass, full.detail)

    await resetForNextScenario()
    const sevenOptions = ['Aster', 'Birch', 'Cedar', 'Dahlia', 'Elm', 'Fir', 'Ginkgo']
    const sevenRanking = await runRanking(page, sevenOptions, ['right'])
    recordCheck('seven-option-flow', JSON.stringify(sevenRanking) === JSON.stringify([...sevenOptions].reverse()), `Observed seven=${JSON.stringify(sevenRanking)}.`)

    await resetForNextScenario()
    await page.getByTestId('options-input').fill('One\nTwo')
    await page.getByTestId('start').click()
    const rejectsTwo = !(await page.getByTestId('choose-left').isVisible()) && !(await hasVisibleRanking(page))
    await page.getByTestId('options-input').fill('1\n2\n3\n4\n5\n6\n7\n8')
    await page.getByTestId('start').click()
    const rejectsEight = !(await page.getByTestId('choose-left').isVisible()) && !(await hasVisibleRanking(page))
    recordCheck('input-boundaries', rejectsTwo && rejectsEight, 'Two and eight options are rejected without entering a comparison.')

    await resetForNextScenario()
    await page.reload({ waitUntil: 'networkidle' })
    const resetPass = resetInteractionPass
      && (await page.getByTestId('ranking-item').count()) === 0
      && await page.getByTestId('options-input').isVisible()
      && (await page.getByTestId('options-input').inputValue()) === ''
    recordCheck(
      'reset',
      resetPass,
      resetInteractionPass
        ? 'Reset remains cleared after reload.'
        : 'Reset could not be operated by a real pointer action after a completed ranking.'
    )
    recordCheck('browser-errors', browserErrors.length === 0, `${browserErrors.length} browser error(s).`)
    recordCheck('service-workers', context.serviceWorkers().length === 0, `${context.serviceWorkers().length} active service worker(s); registrations are blocked.`)
    recordCheck(
      'external-network',
      externalRequests.size === 0,
      externalRequests.size === 0
        ? '0 blocked external request protocols.'
        : `Blocked ${[...externalRequests].sort().join(', ')}.`
    )
  } finally {
    await context.close()
    await browser.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const positional = args.filter((arg) => !arg.startsWith('--'))
  const flags = args.filter((arg) => arg.startsWith('--'))
  if (flags.some((flag) => flag !== '--json') || positional.length !== 1) {
    recordCheck('workspace-boundary', false, 'Usage: benchmark:matrix:judge <preserved-workspace> [--json]')
    await emitReport()
    return
  }

  try {
    workspacePath = await validateWorkspace(positional[0])
    recordCheck('workspace-boundary', true, 'Workspace is a canonical preserved-workspace below benchmark-results.')
  } catch (error) {
    recordCheck('workspace-boundary', false, error?.message ?? 'Workspace validation failed.')
    await emitReport()
    return
  }

  const runRoot = path.dirname(workspacePath)
  reportDirectory = path.join(runRoot, 'judge')
  const existingReportDirectory = await lstatOrUndefined(reportDirectory)
  if (existingReportDirectory?.isSymbolicLink() || (existingReportDirectory && !existingReportDirectory.isDirectory())) {
    recordCheck('safe-app-tree', false, 'Judge output path is not a safe directory.')
    await emitReport()
    return
  }
  await mkdir(reportDirectory, { recursive: true })

  let entryFile
  let entryRelative
  for (const candidate of APP_CANDIDATES) {
    entryFile = await safeRegularFile(workspacePath, candidate)
    if (entryFile) {
      entryRelative = candidate
      break
    }
  }
  if (!entryFile || !entryRelative) {
    recordCheck('safe-app-tree', false, 'No safe generated index.html entry was found.')
    await emitReport()
    return
  }

  const appRoot = path.dirname(entryFile)
  let webFiles
  try {
    webFiles = await collectSafeTree(appRoot)
    recordCheck('safe-app-tree', true, `Entry ${entryRelative}`)
  } catch (error) {
    recordCheck('safe-app-tree', false, error?.message ?? 'App tree validation failed.')
    await emitReport()
    return
  }

  const sourceFacts = await inspectWebSources(webFiles)
  const authoredTestContract = await inspectAuthoredTestContract(appRoot)
  recordCheck('authored-test-contract', authoredTestContract.pass, authoredTestContract.detail)
  recordCheck(
    'external-dependencies',
    sourceFacts.externalReferences === 0,
    `${sourceFacts.externalReferences} external source reference(s).`
  )
  recordCheck(
    'reduced-motion-css',
    sourceFacts.reducedMotion,
    sourceFacts.reducedMotion
      ? 'A prefers-reduced-motion CSS rule is present.'
      : 'No prefers-reduced-motion CSS rule was found.'
  )
  if (sourceFacts.externalReferences > 0) {
    await emitReport()
    return
  }

  let preview
  try {
    preview = await createStaticPreview(appRoot)
    await runBrowserChecks(preview.origin)
  } catch (error) {
    recordCheck('browser-execution', false, error?.message ?? 'Browser judge failed.')
  } finally {
    if (preview) await new Promise((resolve) => preview.server.close(resolve))
  }

  await emitReport()
}

await main().catch(async (error) => {
  recordCheck('judge-runtime', false, error?.message ?? 'Judge failed unexpectedly.')
  await emitReport()
})
