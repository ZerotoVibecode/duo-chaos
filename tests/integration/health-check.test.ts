import { describe, expect, it } from 'vitest'
import { checkAllTools, checkExecutable, type HealthCheckDependencies } from '../../src/main/health/health-check'
import { defaultSettings } from '../../src/main/settings/settings-store'
import type { ToolHealth } from '../../src/shared/types'

describe('CLI health check', () => {
  it('detects the running Node executable and captures a version', async () => {
    const health = await checkExecutable({
      id: 'node',
      label: 'Node.js',
      command: process.execPath,
      args: ['--version'],
      timeoutMs: 3_000
    })
    expect(health.available).toBe(true)
    expect(health.version).toMatch(/^v\d+/)
  })

  it('reports a missing executable without throwing', async () => {
    const health = await checkExecutable({
      id: 'codex',
      label: 'Codex',
      command: 'definitely-missing-duo-command',
      args: ['--version'],
      // Coverage instrumentation can delay the Windows spawn error path by
      // more than 500 ms on a busy runner. Keep this comfortably below the
      // real CLI health-check ceiling while still asserting ENOENT itself.
      timeoutMs: 3_000
    })
    expect(health.available).toBe(false)
    expect(health.detail).toMatch(/not found|ENOENT/i)
  })

  it('reports non-zero exits and timeouts as unavailable', async () => {
    const failed = await checkExecutable({ id: 'node', label: 'Node.js', command: process.execPath, args: ['-e', "console.error('bad'); process.exit(3)"], timeoutMs: 2_000 })
    const timedOut = await checkExecutable({ id: 'node', label: 'Node.js', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30 })
    expect(failed).toMatchObject({ available: false })
    expect(failed.detail).toContain('code 3')
    expect(timedOut.detail).toMatch(/timed out/i)
  })

  it('attaches discovered catalogs without making tool health depend on discovery', async () => {
    const settings = defaultSettings('C:\\DuoChaos\\workspaces')
    const check = ({ id, label, command }: { id: ToolHealth['id']; label: string; command: string }): Promise<ToolHealth> => Promise.resolve({
      id, label, command, available: true, version: 'test', checkedAt: '2026-07-10T17:00:00.000Z'
    })
    const dependencies: HealthCheckDependencies = {
      checkExecutable: check,
      resolveAgentRuntimeProfiles: () => Promise.resolve({ codex: { source: 'cli-default' }, claude: { source: 'cli-default' } }),
      discoverAgentRuntimeCatalogs: () => Promise.resolve({
        codex: { agent: 'codex', source: 'cli-live', discoveredAt: '2026-07-10T17:00:00.000Z', models: [{ id: 'gpt-5.6-luna', label: 'Luna', efforts: ['low', 'max'] }] },
        claude: { agent: 'claude', source: 'cli-help', discoveredAt: '2026-07-10T17:00:00.000Z', models: [{ id: 'fable', label: 'Fable', efforts: ['low', 'max'] }] }
      })
    }
    const health = await checkAllTools(settings, dependencies)

    expect(health.find((item) => item.id === 'codex')).toMatchObject({
      available: true,
      catalog: { source: 'cli-live', models: [{ id: 'gpt-5.6-luna' }] }
    })
    expect(health.find((item) => item.id === 'claude')).toMatchObject({
      available: true,
      catalog: { source: 'cli-help', models: [{ id: 'fable' }] }
    })
  })
})
