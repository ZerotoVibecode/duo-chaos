import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it } from 'vitest'

const script = resolve('scripts', 'benchmark-quality-per-token.mjs')
const fixture = resolve('tests', 'fixtures', 'benchmarks', 'quality-per-token.json')
const outputRoot = resolve('test-results', 'quality-per-token-tests')

function execute(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: resolve('.'),
      shell: false,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}

async function patchedFixture(name: string, patch: (value: Record<string, unknown>) => void): Promise<string> {
  const value = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>
  patch(value)
  const path = resolve(outputRoot, 'fixtures', `${name}.json`)
  await mkdir(resolve(outputRoot, 'fixtures'), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
  return path
}

describe('deterministic quality-per-token architecture benchmark', () => {
  beforeEach(async () => {
    await rm(outputRoot, { recursive: true, force: true })
  })

  it('compares monolithic context with bounded batons without making provider calls', async () => {
    const output = resolve(outputRoot, 'valid')
    const result = await execute(['--fixture', fixture, '--output-dir', output])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8')) as {
      providerCallsMade: number
      claudeCommandsMade: number
      directApiCallsMade: number
      comparison: { verdict: string; qualityNonInferior: boolean; deltas: Record<string, number> }
      variants: Array<{ id: string; gates: Record<string, boolean>; score: Record<string, number> }>
    }
    expect(report).toMatchObject({
      providerCallsMade: 0,
      claudeCommandsMade: 0,
      directApiCallsMade: 0,
      comparison: { verdict: 'candidate-preferred', qualityNonInferior: true }
    })
    expect(report.variants.map((variant) => variant.id)).toEqual(['baseline-monolith', 'bounded-baton'])
    expect(report.variants.every((variant) => Object.values(variant.gates).every(Boolean))).toBe(true)
    expect(report.variants[0]?.gates).toMatchObject({
      briefAdherence: true,
      acceptedContributions: true,
      browserEvidence: true,
      usageComplete: true
    })
    expect(report.variants[0]?.score).toMatchObject({
      briefAdherence: 100,
      acceptedContributions: 100,
      browserEvidence: 100,
      usageCompleteness: 100,
      total: 100
    })
    expect(report.comparison.deltas.processedInputReductionPct).toBe(56.3)
    expect(report.comparison.deltas.peakContextReductionPct).toBe(69.9)

    const markdown = await readFile(resolve(output, 'report.md'), 'utf8')
    expect(markdown).toContain('Zero provider calls')
    expect(markdown).toContain('does not prove future model quality or token savings')
    expect(markdown).not.toMatch(/C:\\Users|@|Bearer\s|\bsk-/iu)
  })

  it('writes byte-identical reports for the same deterministic fixture', async () => {
    const first = resolve(outputRoot, 'repeat-a')
    const second = resolve(outputRoot, 'repeat-b')
    expect((await execute(['--fixture', fixture, '--output-dir', first])).code).toBe(0)
    expect((await execute(['--fixture', fixture, '--output-dir', second])).code).toBe(0)

    await expect(readFile(resolve(first, 'report.json'), 'utf8')).resolves.toBe(await readFile(resolve(second, 'report.json'), 'utf8'))
    await expect(readFile(resolve(first, 'report.md'), 'utf8')).resolves.toBe(await readFile(resolve(second, 'report.md'), 'utf8'))
  })

  it.each([
    ['brief adherence', (variant: Record<string, unknown>) => {
      const quality = variant.quality as Record<string, unknown>
      quality.briefAdherence = { passed: 5, total: 6, current: true }
    }, 'briefAdherence'],
    ['accepted contributions', (variant: Record<string, unknown>) => {
      const quality = variant.quality as Record<string, unknown>
      const roles = quality.roles as Record<string, Record<string, unknown>>
      roles.roleB!.acceptedContributions = 0
    }, 'acceptedContributions'],
    ['browser evidence', (variant: Record<string, unknown>) => {
      const quality = variant.quality as Record<string, unknown>
      const browser = quality.browserEvidence as Record<string, unknown>
      browser.fullscreenScreenshot = false
    }, 'browserEvidence'],
    ['usage completeness', (variant: Record<string, unknown>) => {
      const efficiency = variant.efficiency as Record<string, unknown>
      efficiency.usageEvidence = { accountedCalls: 4, totalCalls: 5, evidence: 'provider-partial' }
    }, 'usageComplete']
  ])('marks %s regression as a failed quality gate', async (name, patch, expectedGate) => {
    const regressionFixture = await patchedFixture(`regression-${name.replaceAll(' ', '-')}`, (value) => {
      const variants = value.variants as Array<Record<string, unknown>>
      patch(variants[1]!)
    })
    const output = resolve(outputRoot, `regression-${name.replaceAll(' ', '-')}`)
    const result = await execute(['--fixture', regressionFixture, '--output-dir', output])

    expect(result.code).toBe(0)
    const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8')) as {
      comparison: { verdict: string; qualityNonInferior: boolean }
      variants: Array<{ id: string; gates: Record<string, boolean> }>
    }
    expect(report.comparison).toMatchObject({ verdict: 'quality-regression', qualityNonInferior: false })
    expect(report.variants.find((variant) => variant.id === 'bounded-baton')?.gates[expectedGate]).toBe(false)
  })

  it.each([
    ['claude-command', (value: Record<string, unknown>) => {
      const commands = value.commands as Array<Record<string, unknown>>
      commands[0]!.binary = 'claude'
    }, /Claude invocation is forbidden/iu],
    ['direct-api', (value: Record<string, unknown>) => {
      const commands = value.commands as Array<Record<string, unknown>>
      commands[0]!.transport = 'direct-api'
    }, /direct API.*forbidden/iu],
    ['sol-ultra', (value: Record<string, unknown>) => {
      const commands = value.commands as Array<Record<string, unknown>>
      commands[0]!.model = 'gpt-5.6-sol'
      commands[0]!.effort = 'ultra'
    }, /Sol Ultra is forbidden/iu]
  ])('hard-fails the %s safety violation before writing a report', async (name, patch, error) => {
    const unsafeFixture = await patchedFixture(name, patch)
    const output = resolve(outputRoot, `unsafe-${name}`)
    const result = await execute(['--fixture', unsafeFixture, '--output-dir', output])

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(error)
    await expect(readFile(resolve(output, 'report.json'), 'utf8')).rejects.toThrow()
  })

  it('rejects unsanitized labels and output paths outside ignored test-results', async () => {
    const unsafeFixture = await patchedFixture('private-label', (value) => {
      const variants = value.variants as Array<Record<string, unknown>>
      variants[0]!.label = 'C:\\Users\\private-owner\\secret'
    })
    const privateResult = await execute(['--fixture', unsafeFixture, '--output-dir', resolve(outputRoot, 'private')])
    expect(privateResult.code).toBe(1)
    expect(privateResult.stderr).toMatch(/sanitized public label/iu)

    const outsideResult = await execute(['--fixture', fixture, '--output-dir', resolve('benchmark-output')])
    expect(outsideResult.code).toBe(1)
    expect(outsideResult.stderr).toMatch(/test-results/iu)
  })

  it('contains no provider execution or network primitive in the benchmark implementation', async () => {
    const source = await readFile(script, 'utf8')
    expect(source).not.toMatch(/node:child_process|cross-spawn|\bspawn\s*\(|\bexec(?:File)?\s*\(|\bfetch\s*\(|https?:\/\//u)
  })
})
