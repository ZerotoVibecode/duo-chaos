import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'

describe('settings store', () => {
  it('returns safe defaults when no settings file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-'))
    const store = new SettingsStore(join(root, 'settings.json'), join(root, 'workspaces'))
    const settings = await store.load()
    expect(settings).toMatchObject({
      codexPath: 'codex',
      claudePath: 'claude',
      defaultExecutionMode: 'simulation',
      defaultVisibilityMode: 'spoiler-shield',
      defaultMissionProfile: 'surprise',
      codexModel: '',
      codexEffort: 'default',
      claudeModel: '',
      claudeEffort: 'default',
      saveRawLogs: false,
      maxTurns: 11,
      maxRepairLoops: 2,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 86_400
    })
  })

  it('persists work leases up to eight hours and run ceilings up to twenty-four hours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-budgets-'))
    const store = new SettingsStore(join(root, 'settings.json'), join(root, 'workspaces'))
    const defaults = await store.load()

    await expect(store.save({
      ...defaults,
      turnTimeoutSeconds: 28_800,
      runTimeoutSeconds: 86_400
    })).resolves.toMatchObject({ turnTimeoutSeconds: 28_800, runTimeoutSeconds: 86_400 })

    await expect(store.save({ ...defaults, turnTimeoutSeconds: 28_801 })).rejects.toThrow(/turn|work|lease/i)
    await expect(store.save({ ...defaults, runTimeoutSeconds: 86_401 })).rejects.toThrow(/run|timeout|ceiling/i)
  })

  it('adds the default run ceiling without overwriting a legacy saved turn lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-migration-'))
    const path = join(root, 'settings.json')
    await writeFile(path, JSON.stringify({ turnTimeoutSeconds: 480 }), 'utf8')
    const store = new SettingsStore(path, join(root, 'workspaces'))

    await expect(store.load()).resolves.toMatchObject({
      turnTimeoutSeconds: 480,
      runTimeoutSeconds: 86_400,
      defaultMissionProfile: 'surprise'
    })
  })

  it('persists a serious mission as the next-run default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-mission-'))
    const path = join(root, 'settings.json')
    const store = new SettingsStore(path, join(root, 'workspaces'))

    const saved = await store.save({ ...(await store.load()), defaultMissionProfile: 'serious' })

    expect(saved).toMatchObject({ defaultMissionProfile: 'serious' })
    await expect(store.load()).resolves.toMatchObject({ defaultMissionProfile: 'serious' })
  })

  it('merges valid partial settings and persists atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-'))
    const path = join(root, 'settings.json')
    const store = new SettingsStore(path, join(root, 'workspaces'))
    const saved = await store.save({
      ...(await store.load()),
      codexPath: 'C:\\Tools\\codex.exe',
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'ultra',
      maxTurns: 18
    })
    expect(saved.codexPath).toBe('C:\\Tools\\codex.exe')
    expect(saved.codexModel).toBe('gpt-5.6-sol')
    expect(saved.codexEffort).toBe('ultra')
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { maxTurns?: number; codexModel?: string }
    expect(persisted.maxTurns).toBe(18)
    expect(persisted.codexModel).toBe('gpt-5.6-sol')
  })

  it('quarantines corrupt settings by falling back to defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-settings-'))
    const path = join(root, 'settings.json')
    await writeFile(path, '{broken json', 'utf8')
    const store = new SettingsStore(path, join(root, 'workspaces'))
    await expect(store.load()).resolves.toMatchObject({ codexPath: 'codex' })
  })
})
