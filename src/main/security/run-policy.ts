import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import type { StartRunRequest } from '@shared/types'

const runRequestSchema = z.object({
  prompt: z.string().trim().min(3, 'Enter a prompt with at least three characters.').max(8_000),
  workspaceRoot: z.string().trim().min(1),
  executionMode: z.enum(['simulation', 'safe', 'chaos', 'yolo-sandbox']),
  visibilityMode: z.enum(['blind', 'spoiler-shield', 'full-chaos']),
  missionProfile: z.enum(['surprise', 'serious']).default('surprise'),
  maxTurns: z.number().int().min(2).max(50),
  maxRepairLoops: z.number().int().min(0).max(10),
  turnTimeoutSeconds: z.number().int().min(30).max(28_800),
  runTimeoutSeconds: z.number().int().min(60).max(86_400).default(86_400),
  dangerousModeConfirmed: z.boolean(),
  unsafeWorkspaceRootConfirmed: z.boolean(),
  codexCustomizationProfile: z.enum(['core', 'smart', 'full-local']).optional(),
  claudeCustomizationProfile: z.enum(['core', 'smart', 'full-local']).optional(),
  trustedLocalCapabilitiesConfirmed: z.boolean().optional(),
  qualityRoutingProfile: z.enum(['balanced', 'force-selected']).optional(),
  claudeWorkInferenceLimit: z.number().int().min(3).max(20).optional(),
  codexModel: z.string().max(256).optional(),
  codexEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  claudeModel: z.string().max(256).optional(),
  claudeEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
})

function comparable(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value
}

function protectedRoots(): Set<string> {
  const home = homedir()
  return new Set([home, join(home, 'Desktop'), join(home, 'Documents')].map(comparable))
}

interface RunRequestValidationOptions {
  minimumTurns?: number
}

export function validateRunRequest(
  value: unknown,
  options: RunRequestValidationOptions = {}
): StartRunRequest {
  const request = runRequestSchema.parse(value)
  const minimumTurns = options.minimumTurns ?? 7
  if (!Number.isInteger(minimumTurns) || minimumTurns < 2 || minimumTurns > 7) {
    throw new Error('Turn validation minimum must be an integer between 2 and 7.')
  }
  if (request.maxTurns < minimumTurns) {
    throw new Error(`Turn budget must include all ${minimumTurns} required collaboration calls.`)
  }
  const workspaceRoot = resolve(request.workspaceRoot)
  if (!isAbsolute(workspaceRoot)) throw new Error('Workspace root must resolve to an absolute path.')
  if (request.executionMode === 'yolo-sandbox' && !request.dangerousModeConfirmed) {
    throw new Error('YOLO Sandbox requires explicit disposable-environment confirmation.')
  }
  const localCapabilitiesRequested = request.codexCustomizationProfile !== undefined && request.codexCustomizationProfile !== 'core' ||
    request.claudeCustomizationProfile !== undefined && request.claudeCustomizationProfile !== 'core'
  if (request.executionMode === 'safe' && localCapabilitiesRequested) {
    throw new Error('Safe execution supports Core toolbelts only. Choose Chaos for unattended plugins, apps, or MCP tools.')
  }
  if (request.executionMode !== 'simulation' && localCapabilitiesRequested && !request.trustedLocalCapabilitiesConfirmed) {
    throw new Error('Local CLI skills, plugins, and MCP tools require explicit trust confirmation for this run.')
  }
  if (protectedRoots().has(comparable(workspaceRoot)) && !request.unsafeWorkspaceRootConfirmed) {
    throw new Error('The selected path is a protected root. Choose a dedicated nested workspace folder or confirm the risk.')
  }
  return { ...request, workspaceRoot }
}
