import { Save, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentEffort, AppSettings, CodexEffort, ToolHealth } from '@shared/types'
import { useStudioStore } from '@renderer/store/studio-store'
import {
  catalogSourceLabel,
  CLAUDE_EFFORT_OPTIONS,
  CODEX_EFFORT_OPTIONS,
  compatibleEffort,
  effortOptionsForModel,
  FALLBACK_CLAUDE_MODELS,
  FALLBACK_CODEX_MODELS,
  runtimeModels
} from '@renderer/lib/runtime-options'
import { ModelSelect } from './ModelSelect'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.closest('[hidden], [aria-hidden="true"]'))
}

export function SettingsSheet(): React.JSX.Element | null {
  const { settings, health, settingsOpen, busy, setSettingsOpen, saveSettings, openAgentCli } = useStudioStore()
  if (!settingsOpen || !settings) return null
  return (
    <SettingsSheetContent
      key={`${settings.codexPath}-${settings.defaultWorkspaceRoot}-${String(settingsOpen)}`}
      settings={settings}
      health={health}
      busy={busy}
      onClose={() => setSettingsOpen(false)}
      onSave={saveSettings}
      onOpenAgentCli={openAgentCli}
    />
  )
}

interface SettingsSheetContentProps {
  settings: AppSettings
  health: ToolHealth[]
  busy: boolean
  onClose: () => void
  onSave: (settings: AppSettings) => Promise<void>
  onOpenAgentCli: (agent: 'codex' | 'claude') => Promise<void>
}

function formatDuration(seconds: number): string {
  const roundedMinutes = Math.max(1, Math.round(seconds / 60))
  const hours = Math.floor(roundedMinutes / 60)
  const minutes = roundedMinutes % 60
  if (hours === 0) return `${String(minutes)}m`
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`
}

function SettingsSheetContent({ settings, health, busy, onClose, onSave, onOpenAgentCli }: SettingsSheetContentProps): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const initialFocus = closeButtonRef.current ?? dialogRef.current
    initialFocus?.focus()

    return () => {
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [])

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = focusableElements(dialogRef.current)
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }

    const first = focusable.at(0)
    const last = focusable.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const codex = health.find((item) => item.id === 'codex')
  const claude = health.find((item) => item.id === 'claude')
  const codexModels = runtimeModels(codex, FALLBACK_CODEX_MODELS)
  const claudeModels = runtimeModels(claude, FALLBACK_CLAUDE_MODELS)
  const codexEfforts = effortOptionsForModel(draft.codexModel || codex?.runtime?.model || '', codexModels, CODEX_EFFORT_OPTIONS)
  const claudeEfforts = effortOptionsForModel(draft.claudeModel || claude?.runtime?.model || '', claudeModels, CLAUDE_EFFORT_OPTIONS)
  const effectiveCodexEffort = compatibleEffort(draft.codexEffort, draft.codexModel || codex?.runtime?.model || '', codexModels)
  const effectiveClaudeEffort = compatibleEffort(draft.claudeEffort, draft.claudeModel || claude?.runtime?.model || '', claudeModels) as AgentEffort
  const maxTurns = Number.isFinite(draft.maxTurns) ? Math.max(0, Math.floor(draft.maxTurns)) : 0
  const repairLoops = Number.isFinite(draft.maxRepairLoops) ? Math.max(0, Math.floor(draft.maxRepairLoops)) : 0
  const dialogueTurns = Math.min(4, maxTurns)
  const coreWorkTurns = Math.max(0, Math.min(7, maxTurns) - 4)
  const repairPairs = maxTurns > 7
    ? Math.min(repairLoops, Math.floor((maxTurns - 7) / 2))
    : 0
  const repairPairsLimited = repairPairs < repairLoops
  const turnsForConfiguredRepairs = 7 + repairLoops * 2
  const configuredRepairLabel = repairLoops === 2 ? 'both repair pairs' : `all ${String(repairLoops)} repair pairs`
  const plannedWorkTurns = coreWorkTurns + repairPairs * 2
  const projectedWorkSeconds = plannedWorkTurns * draft.turnTimeoutSeconds
  const fixedStageSeconds = dialogueTurns * 600
  const projectedRunSeconds = projectedWorkSeconds + fixedStageSeconds
  const runBudgetTight = projectedRunSeconds > draft.runTimeoutSeconds

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => setDraft((current) => current ? { ...current, [key]: value } : current)
  const updateCodexModel = (model: string): void => setDraft((current) => ({
    ...current,
    codexModel: model,
    codexEffort: compatibleEffort(current.codexEffort, model || codex?.runtime?.model || '', codexModels)
  }))
  const updateClaudeModel = (model: string): void => setDraft((current) => ({
    ...current,
    claudeModel: model,
    claudeEffort: compatibleEffort(current.claudeEffort, model || claude?.runtime?.model || '', claudeModels) as AgentEffort
  }))
  return (
    <div className="sheet-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
        <div className="sheet-heading"><div><span className="eyebrow">Local configuration</span><h2 id="settings-title">Studio settings</h2></div><button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>
        <div className="settings-content">
          <section><h3>Agent runtime</h3><p className="settings-help">Pin a model for repeatable runs, or leave it blank to inherit the local CLI configuration.</p><div className="runtime-settings-grid">
            <article className="runtime-config-card runtime-codex"><div><strong>Codex</strong><button type="button" className="text-button" onClick={() => void onOpenAgentCli('codex')}><SquareTerminal size={13} /> Open Codex CLI</button></div><ModelSelect label="Codex model" value={draft.codexModel} suggestions={codexModels} fieldClassName="settings-field" onChange={updateCodexModel} /><label className="settings-field"><span>Codex effort</span><select value={effectiveCodexEffort} onChange={(event) => update('codexEffort', event.target.value as CodexEffort)}>{codexEfforts.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><small className="runtime-capability-note" title={codex?.catalog?.note}>{catalogSourceLabel(codex?.catalog)}</small></article>
            <article className="runtime-config-card runtime-claude"><div><strong>Claude Code</strong><button type="button" className="text-button" onClick={() => void onOpenAgentCli('claude')}><SquareTerminal size={13} /> Open Claude CLI</button></div><ModelSelect label="Claude model" value={draft.claudeModel} suggestions={claudeModels} fieldClassName="settings-field" onChange={updateClaudeModel} /><label className="settings-field"><span>Claude effort</span><select value={effectiveClaudeEffort} onChange={(event) => update('claudeEffort', event.target.value as AppSettings['claudeEffort'])}>{claudeEfforts.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><small className="runtime-capability-note" title={claude?.catalog?.note}>{catalogSourceLabel(claude?.catalog)}</small></article>
          </div></section>
          <section><h3>Executables</h3>{([['codexPath', 'Codex'], ['claudePath', 'Claude Code'], ['gitPath', 'Git'], ['nodePath', 'Node'], ['npmPath', 'npm']] as const).map(([key, label]) => <label className="settings-field" key={key}><span>{label}</span><input value={draft[key]} onChange={(event) => update(key, event.target.value)} /></label>)}</section>
          <section>
            <h3>Run limits</h3>
            <p className="settings-help">The normal path is seven calls: four lean debates, two deep contributions, and one reciprocal review. Extra repairs run only after recorded evidence finds a defect.</p>
            <div className="settings-numbers">
              <label className="settings-field"><span>Max agent calls</span><input type="number" min="7" max="50" value={draft.maxTurns} onChange={(event) => update('maxTurns', Number(event.target.value))} /></label>
              <label className="settings-field"><span>Repair loops</span><input type="number" min="0" max="10" value={draft.maxRepairLoops} onChange={(event) => update('maxRepairLoops', Number(event.target.value))} /></label>
              <label className="settings-field"><span>Long work lease (minutes)</span><input type="number" min="1" max="480" value={Math.round(draft.turnTimeoutSeconds / 60)} onChange={(event) => update('turnTimeoutSeconds', Number(event.target.value) * 60)} /></label>
              <label className="settings-field"><span>Overall run ceiling (hours)</span><input type="number" min="1" max="24" step="0.5" value={draft.runTimeoutSeconds / 3_600} onChange={(event) => update('runTimeoutSeconds', Number(event.target.value) * 3_600)} /></label>
            </div>
            {repairLoops > 0 && (
              <p className="settings-help repair-capacity-note">
                {repairPairs} of {repairLoops} configured repair pairs fit inside {maxTurns} agent calls.
                {repairPairsLimited && ` Use ${String(turnsForConfiguredRepairs)} max agent calls to schedule ${configuredRepairLabel}.`}
              </p>
            )}
            {runBudgetTight && (
              <p className="settings-warning budget-warning" role="status">
                The configured ceiling reserves up to {formatDuration(projectedRunSeconds)}: {formatDuration(projectedWorkSeconds)} of source work plus {formatDuration(fixedStageSeconds)} for debate. This exceeds the {formatDuration(draft.runTimeoutSeconds)} run ceiling, so later evidence-triggered repairs may timebox.
              </p>
            )}
          </section>
          <section>
            <h3>Workspace</h3>
            <label className="settings-field">
              <span>Default mission profile</span>
              <select value={draft.defaultMissionProfile} onChange={(event) => update('defaultMissionProfile', event.target.value as AppSettings['defaultMissionProfile'])}>
                <option value="surprise">Surprise build</option>
                <option value="serious">Serious build</option>
              </select>
            </label>
            <label className="settings-field"><span>Default workspace root</span><input value={draft.defaultWorkspaceRoot} onChange={(event) => update('defaultWorkspaceRoot', event.target.value)} /></label>
            <label className="toggle-field"><input type="checkbox" checked={draft.saveRawLogs} onChange={(event) => update('saveRawLogs', event.target.checked)} /><span><strong>Save private raw logs</strong><small>Optional sensitive provider output, stored only in local app data. Keep disabled unless diagnosing a run.</small></span></label>
          </section>
          <div className="settings-warning">Real Mode launches authenticated local CLIs and may consume paid usage. Source contributions use fresh compact sessions; quota pressure pauses before another premium call. Duo Chaos sends no product analytics or Duo-owned telemetry. Provider CLIs keep their own local account and history behavior.</div>
        </div>
        <div className="sheet-footer"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="button" disabled={busy} onClick={() => void onSave({ ...draft, codexEffort: effectiveCodexEffort, claudeEffort: effectiveClaudeEffort })}><Save size={15} /> Save settings</button></div>
      </aside>
    </div>
  )
}
