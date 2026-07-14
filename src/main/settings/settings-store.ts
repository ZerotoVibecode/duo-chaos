import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AppSettings } from '@shared/types'

const settingsSchema = z.object({
  codexPath: z.string().min(1),
  claudePath: z.string().min(1),
  gitPath: z.string().min(1),
  nodePath: z.string().min(1),
  npmPath: z.string().min(1),
  codexExtraArgs: z.array(z.string()),
  claudeExtraArgs: z.array(z.string()),
  codexModel: z.string(),
  codexEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  claudeModel: z.string(),
  claudeEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']),
  codexCustomizationProfile: z.enum(['core', 'smart', 'full-local']),
  claudeCustomizationProfile: z.enum(['core', 'smart', 'full-local']),
  trustedLocalCapabilitiesConfirmed: z.boolean(),
  qualityRoutingProfile: z.enum(['balanced', 'force-selected']),
  workInferenceLimit: z.number().int().min(3).max(20),
  defaultWorkspaceRoot: z.string().min(1),
  defaultExecutionMode: z.enum(['simulation', 'safe', 'chaos', 'yolo-sandbox']),
  defaultVisibilityMode: z.enum(['blind', 'spoiler-shield', 'full-chaos']),
  defaultMissionProfile: z.enum(['surprise', 'serious']),
  saveRawLogs: z.boolean(),
  maxTurns: z.number().int().min(7).max(50),
  maxRepairLoops: z.number().int().min(0).max(10),
  turnTimeoutSeconds: z.number().int().min(30).max(28_800),
  runTimeoutSeconds: z.number().int().min(60).max(86_400)
})

export function defaultSettings(defaultWorkspaceRoot: string): AppSettings {
  return {
    codexPath: 'codex',
    claudePath: 'claude',
    gitPath: 'git',
    nodePath: 'node',
    npmPath: 'npm',
    codexExtraArgs: [],
    claudeExtraArgs: [],
    codexModel: '',
    codexEffort: 'default',
    claudeModel: '',
    claudeEffort: 'default',
    codexCustomizationProfile: 'smart',
    claudeCustomizationProfile: 'smart',
    trustedLocalCapabilitiesConfirmed: false,
    qualityRoutingProfile: 'balanced',
    workInferenceLimit: 8,
    defaultWorkspaceRoot,
    defaultExecutionMode: 'simulation',
    defaultVisibilityMode: 'spoiler-shield',
    defaultMissionProfile: 'surprise',
    saveRawLogs: false,
    maxTurns: 11,
    maxRepairLoops: 2,
    turnTimeoutSeconds: 7_200,
    runTimeoutSeconds: 86_400
  }
}

export class SettingsStore {
  constructor(
    private readonly path: string,
    private readonly defaultWorkspaceRoot: string
  ) {}

  async load(): Promise<AppSettings> {
    const defaults = defaultSettings(this.defaultWorkspaceRoot)
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      const saved = typeof raw === 'object' && raw ? raw as Record<string, unknown> : {}
      const legacyTurnBudget = typeof saved.maxTurns === 'number' &&
        Number.isInteger(saved.maxTurns) && saved.maxTurns >= 2 && saved.maxTurns < 7
      const legacyWorkInferenceLimit = typeof saved.claudeWorkInferenceLimit === 'number' &&
        Number.isInteger(saved.claudeWorkInferenceLimit) && saved.claudeWorkInferenceLimit >= 3 &&
        saved.claudeWorkInferenceLimit <= 20 && saved.workInferenceLimit === undefined
      const validated = settingsSchema.parse({
        ...defaults,
        ...saved,
        ...(legacyWorkInferenceLimit ? { workInferenceLimit: saved.claudeWorkInferenceLimit } : {}),
        ...(legacyTurnBudget ? { maxTurns: 7 } : {})
      })
      if (legacyTurnBudget || legacyWorkInferenceLimit) await this.writeValidated(validated).catch(() => undefined)
      return validated
    } catch (error) {
      if (error instanceof SyntaxError) {
        await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined)
      }
      return defaults
    }
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const legacy = settings as AppSettings & { claudeWorkInferenceLimit?: number }
    const validated = settingsSchema.parse({
      ...settings,
      workInferenceLimit: settings.workInferenceLimit ?? legacy.claudeWorkInferenceLimit ?? 8
    })
    await this.writeValidated(validated)
    return validated
  }

  private async writeValidated(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.path)
  }
}
