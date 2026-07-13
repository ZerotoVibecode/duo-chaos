import type { AppSettings, StartRunRequest } from '@shared/types'

type ResumeLoadout = Pick<AppSettings, 'codexModel' | 'codexEffort' | 'claudeModel' | 'claudeEffort'>

/**
 * A normal resume remains pinned to its admitted loadout. Model-unavailable is
 * the sole exception: the human explicitly applies a replacement model, and
 * only the provider that failed is repinned.
 */
export function repinUnavailableProvider(
  request: StartRunRequest,
  settings: ResumeLoadout,
  provider?: 'claude' | 'codex'
): StartRunRequest {
  if (provider === 'claude') {
    return {
      ...request,
      claudeModel: settings.claudeModel,
      claudeEffort: settings.claudeEffort
    }
  }
  if (provider === 'codex') {
    return {
      ...request,
      codexModel: settings.codexModel,
      codexEffort: settings.codexEffort
    }
  }
  return request
}
