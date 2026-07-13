import { Check, CircleAlert, RefreshCw, ShieldCheck, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentEffort, AppSettings, CodexEffort, ToolHealth } from '@shared/types'
import { formatRuntimeProfile } from '@renderer/lib/runtime-label'
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

interface AgentLoadoutPanelProps {
  health: ToolHealth[]
  settings?: AppSettings
  busy: boolean
  onRefresh: () => void
  onSave: (settings: AppSettings) => Promise<void>
  onOpenAgentCli: (agent: 'codex' | 'claude') => Promise<void>
}

interface RuntimeDraft {
  codexModel: string
  codexEffort: CodexEffort
  claudeModel: string
  claudeEffort: AgentEffort
}

function draftFrom(settings?: AppSettings): RuntimeDraft {
  return {
    codexModel: settings?.codexModel ?? '',
    codexEffort: settings?.codexEffort ?? 'default',
    claudeModel: settings?.claudeModel ?? '',
    claudeEffort: settings?.claudeEffort ?? 'default'
  }
}

function sameDraft(left: RuntimeDraft, right: RuntimeDraft): boolean {
  return left.codexModel === right.codexModel
    && left.codexEffort === right.codexEffort
    && left.claudeModel === right.claudeModel
    && left.claudeEffort === right.claudeEffort
}

function versionText(item?: ToolHealth): string {
  if (!item?.available) return 'Not detected'
  return item.version?.replace(item.label, '').trim() || 'Ready'
}

function systemLabel(item: ToolHealth): string {
  if (item.id === 'node') {
    const major = item.version?.match(/v?(\d+)/)?.[1]
    return major ? `Node ${major}` : 'Node'
  }
  if (item.id === 'npm') {
    const major = item.version?.match(/(\d+)/)?.[1]
    return major ? `npm ${major}` : 'npm'
  }
  return 'Git'
}

export function AgentLoadoutPanel({ health, settings, busy, onRefresh, onSave, onOpenAgentCli }: AgentLoadoutPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<RuntimeDraft>(() => draftFrom(settings))
  const previousSettings = useRef(settings)

  useEffect(() => {
    if (!settings || previousSettings.current === settings) return
    const previousDraft = draftFrom(previousSettings.current)
    previousSettings.current = settings
    setDraft((current) => sameDraft(current, previousDraft) ? draftFrom(settings) : current)
  }, [settings])

  const codex = health.find((item) => item.id === 'codex')
  const claude = health.find((item) => item.id === 'claude')
  const git = health.find((item) => item.id === 'git')
  const codexModels = runtimeModels(codex, FALLBACK_CODEX_MODELS)
  const claudeModels = runtimeModels(claude, FALLBACK_CLAUDE_MODELS)
  const effectiveCodexModel = draft.codexModel || codex?.runtime?.model || ''
  const effectiveClaudeModel = draft.claudeModel || claude?.runtime?.model || ''
  const codexEfforts = effortOptionsForModel(effectiveCodexModel, codexModels, CODEX_EFFORT_OPTIONS)
  const claudeEfforts = effortOptionsForModel(effectiveClaudeModel, claudeModels, CLAUDE_EFFORT_OPTIONS)
  const effectiveCodexEffort = compatibleEffort(draft.codexEffort, effectiveCodexModel, codexModels)
  const effectiveClaudeEffort = compatibleEffort(draft.claudeEffort, effectiveClaudeModel, claudeModels) as AgentEffort
  const systemTools = health.filter((item) => item.id === 'git' || item.id === 'node' || item.id === 'npm')
  const realReady = Boolean(codex?.available && claude?.available && git?.available)
  const systemReady = systemTools.filter((item) => item.available).length
  const dirty = settings !== undefined && (
    draft.codexModel !== settings.codexModel ||
    effectiveCodexEffort !== settings.codexEffort ||
    draft.claudeModel !== settings.claudeModel ||
    effectiveClaudeEffort !== settings.claudeEffort
  )

  const update = <K extends keyof RuntimeDraft>(key: K, value: RuntimeDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const updateCodexModel = (model: string): void => {
    setDraft((current) => ({
      ...current,
      codexModel: model,
      codexEffort: compatibleEffort(current.codexEffort, model || codex?.runtime?.model || '', codexModels)
    }))
  }

  const updateClaudeModel = (model: string): void => {
    setDraft((current) => ({
      ...current,
      claudeModel: model,
      claudeEffort: compatibleEffort(current.claudeEffort, model || claude?.runtime?.model || '', claudeModels) as AgentEffort
    }))
  }

  const apply = async (): Promise<void> => {
    if (!settings || !dirty) return
    await onSave({
      ...settings,
      ...draft,
      codexEffort: effectiveCodexEffort,
      claudeEffort: effectiveClaudeEffort
    })
  }

  return (
    <aside className="glass-panel agent-loadout-panel" aria-labelledby="agent-loadout-title">
      <div className="panel-heading loadout-heading">
        <div>
          <span className="eyebrow">Run configuration</span>
          <h2 id="agent-loadout-title">Agent loadout</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Refresh CLI health" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
        </button>
      </div>

      <p className="loadout-intro">Choose the models entering the next build. Available loadouts are read from each local CLI when supported.</p>

      <div className="loadout-agents">
        <article className="loadout-agent loadout-codex">
          <div className="loadout-agent-heading">
            <div className="loadout-agent-identity">
              <span className={`loadout-status ${codex?.available ? 'ready' : 'missing'}`}>{codex?.available ? <Check size={12} /> : <CircleAlert size={12} />}</span>
              <span><strong>Codex</strong><small title={codex?.version}>{versionText(codex)}</small></span>
            </div>
            <button className="terminal-button" type="button" aria-label="Open Codex CLI" title="Open Codex CLI" onClick={() => void onOpenAgentCli('codex')} disabled={busy}>
              <SquareTerminal size={14} />
            </button>
          </div>
          <div className="loadout-controls">
            <ModelSelect label="Codex model" value={draft.codexModel} suggestions={codexModels} fieldClassName="loadout-field" onChange={updateCodexModel} disabled={busy} />
            <label className="loadout-field"><span>Effort</span><select aria-label="Codex effort" value={effectiveCodexEffort} onChange={(event) => update('codexEffort', event.target.value as CodexEffort)} disabled={busy}>{codexEfforts.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </div>
          <div className="loadout-effective" title={codex?.catalog?.note}><span>{catalogSourceLabel(codex?.catalog)}</span><strong>{formatRuntimeProfile(codex?.runtime)}</strong></div>
        </article>

        <article className="loadout-agent loadout-claude">
          <div className="loadout-agent-heading">
            <div className="loadout-agent-identity">
              <span className={`loadout-status ${claude?.available ? 'ready' : 'missing'}`}>{claude?.available ? <Check size={12} /> : <CircleAlert size={12} />}</span>
              <span><strong>Claude</strong><small title={claude?.version}>{versionText(claude)}</small></span>
            </div>
            <button className="terminal-button" type="button" aria-label="Open Claude CLI" title="Open Claude CLI" onClick={() => void onOpenAgentCli('claude')} disabled={busy}>
              <SquareTerminal size={14} />
            </button>
          </div>
          <div className="loadout-controls">
            <ModelSelect label="Claude model" value={draft.claudeModel} suggestions={claudeModels} fieldClassName="loadout-field" onChange={updateClaudeModel} disabled={busy} />
            <label className="loadout-field"><span>Effort</span><select aria-label="Claude effort" value={effectiveClaudeEffort} onChange={(event) => update('claudeEffort', event.target.value as AgentEffort)} disabled={busy}>{claudeEfforts.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </div>
          <div className="loadout-effective" title={claude?.catalog?.note}><span>{catalogSourceLabel(claude?.catalog)}</span><strong>{formatRuntimeProfile(claude?.runtime)}</strong></div>
        </article>
      </div>

      <section className="system-checks" role="group" aria-label="System checks">
        <div className="system-checks-heading"><span>System checks</span><strong>{systemReady}/{systemTools.length}</strong></div>
        <div className="system-check-list">
          {systemTools.map((item) => (
            <span className={`system-check ${item.available ? 'ready' : 'missing'}`} key={item.id} title={item.available ? item.version : item.detail}>
              {item.available ? <Check size={11} /> : <CircleAlert size={11} />}<strong>{systemLabel(item)}</strong>
            </span>
          ))}
        </div>
      </section>

      <div className={`readiness-note ${realReady ? 'ready' : ''}`}>
        <ShieldCheck size={15} />
        <span>{realReady ? 'Real Mode ready' : 'Simulation stays ready'}</span>
      </div>

      <button className="primary-button loadout-apply" type="button" onClick={() => void apply()} disabled={busy || !dirty}>
        {busy ? 'Checking configuration…' : dirty ? 'Apply loadout' : 'Loadout applied'}
      </button>
    </aside>
  )
}
