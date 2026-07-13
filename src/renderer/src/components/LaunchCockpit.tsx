import { BriefcaseBusiness, Eye, EyeOff, FolderOpen, Gauge, Play, Radio, RotateCcw, Scale, Shield, Sparkles, TimerReset, TriangleAlert, Zap } from 'lucide-react'
import type { ExecutionMode, MissionProfile, VisibilityMode } from '@shared/types'
import { formatRuntimeProfile } from '@renderer/lib/runtime-label'
import { DEFAULT_SURPRISE_PROMPT, useStudioStore } from '@renderer/store/studio-store'
import { AgentLoadoutPanel } from './AgentLoadoutPanel'
import { RecentBuilds } from './RecentBuilds'

const executionModes: Array<{ id: ExecutionMode; label: string; detail: string; icon: React.ReactNode }> = [
  { id: 'simulation', label: 'Simulation', detail: 'No AI CLIs required', icon: <Sparkles size={15} /> },
  { id: 'safe', label: 'Safe', detail: 'Conservative local edits', icon: <Shield size={15} /> },
  { id: 'chaos', label: 'Chaos', detail: 'Autonomous workspace', icon: <Zap size={15} /> },
  { id: 'yolo-sandbox', label: 'YOLO', detail: 'Container or VM only', icon: <TriangleAlert size={15} /> }
]

const visibilityModes: Array<{ id: VisibilityMode; label: string; detail: string; icon: React.ReactNode }> = [
  { id: 'blind', label: 'Blind', detail: 'Only phase signals', icon: <EyeOff size={15} /> },
  { id: 'spoiler-shield', label: 'Spoiler Shield', detail: 'Drama, nouns redacted', icon: <Shield size={15} /> },
  { id: 'full-chaos', label: 'Full Chaos', detail: 'Raw output may spoil', icon: <Eye size={15} /> }
]

const missionProfiles: Array<{ id: MissionProfile; label: string; detail: string; icon: React.ReactNode }> = [
  { id: 'surprise', label: 'Surprise build', detail: 'Agents invent the product', icon: <Sparkles size={15} /> },
  { id: 'serious', label: 'Serious build', detail: 'Your requirements stay binding', icon: <BriefcaseBusiness size={15} /> }
]

function formatBudget(seconds: number): string {
  if (seconds >= 3_600) {
    const hours = seconds / 3_600
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`
}

function deepWorkEffort(...efforts: Array<string | undefined>): string {
  if (efforts.includes('ultra')) return 'Ultra effort'
  if (efforts.includes('max')) return 'Max effort'
  if (efforts.includes('xhigh')) return 'Extra High effort'
  if (efforts.includes('high')) return 'High effort'
  return 'Selected effort'
}

export function LaunchCockpit(): React.JSX.Element {
  const {
    form,
    health,
    busy,
    error,
    settings,
    recentBuilds,
    updateForm,
    chooseWorkspace,
    startRun,
    refreshHealth,
    saveSettings,
    openAgentCli,
    openRunFolder,
    recoverRecentBuild,
    resumeRun
  } = useStudioStore()
  const codexHealth = health.find((item) => item.id === 'codex')
  const claudeHealth = health.find((item) => item.id === 'claude')
  const gitHealth = health.find((item) => item.id === 'git')
  const realReady = Boolean(codexHealth?.available && claudeHealth?.available && gitHealth?.available)
  const realUnavailable = form.executionMode !== 'simulation' && !realReady
  const startLabel = form.executionMode === 'simulation'
    ? 'Start simulation'
    : form.missionProfile === 'serious' ? 'Start serious build' : 'Start blind build'
  const canStart = form.prompt.trim().length >= 3 && form.workspaceRoot.length > 0 && !busy && !realUnavailable && Boolean(settings)
  const codexEffort = settings?.codexEffort && settings.codexEffort !== 'default' ? settings.codexEffort : codexHealth?.runtime?.effort
  const claudeEffort = settings?.claudeEffort && settings.claudeEffort !== 'default' ? settings.claudeEffort : claudeHealth?.runtime?.effort
  const codexProfile = formatRuntimeProfile({
    model: settings?.codexModel || codexHealth?.runtime?.model,
    ...(codexEffort ? { effort: codexEffort } : {}),
    source: settings?.codexModel || settings?.codexEffort !== 'default' ? 'studio' : codexHealth?.runtime?.source ?? 'cli-default'
  })
  const claudeProfile = formatRuntimeProfile({
    model: settings?.claudeModel || claudeHealth?.runtime?.model,
    ...(claudeEffort ? { effort: claudeEffort } : {}),
    source: settings?.claudeModel || settings?.claudeEffort !== 'default' ? 'studio' : claudeHealth?.runtime?.source ?? 'cli-default'
  })
  const workLease = formatBudget(settings?.turnTimeoutSeconds ?? 7_200)
  const runCeiling = formatBudget(settings?.runTimeoutSeconds ?? 86_400)
  const deepEffort = deepWorkEffort(codexEffort, claudeEffort)
  const scheduledTurns = settings?.maxTurns ?? 11

  return (
    <main className={`launch-shell mission-${form.missionProfile}`}>
      <section className="launch-grid">
        <div className="glass-panel prompt-cockpit">
          <div className="launch-command-deck">
          <div className="hero-copy">
            <span className="eyebrow"><Radio size={13} /> Local agent showdown / sealed reveal</span>
            <h1>{form.missionProfile === 'serious' ? 'Start the serious build.' : 'Start the blind build.'}</h1>
            <p>{form.missionProfile === 'serious'
              ? 'Your product brief stays binding. Claude and Codex challenge the architecture, UX, and implementation until the strongest version survives.'
              : 'One prompt. Two rivals. One surviving build. Claude and Codex open with a position, challenge the weak parts, and ship only what survives.'}</p>
          </div>

          <section className="battle-briefing" aria-label="Battle briefing">
            <div className="briefing-matchup">
              <article className="briefing-agent briefing-claude">
                <span><b>Claude</b><em> enters with</em></span>
                <strong>{claudeProfile}</strong>
              </article>
              <div className="briefing-vs" aria-label="versus"><span>VS</span></div>
              <article className="briefing-agent briefing-codex">
                <span><b>Codex</b><em> enters with</em></span>
                <strong>{codexProfile}</strong>
              </article>
            </div>
            <div className="briefing-contract">
              <span>4-call debate</span><i aria-hidden="true" />
              <span>2 deep builds <strong>{workLease}</strong></span><i aria-hidden="true" />
              <span>1 cross-review</span>
              <em>Run ceiling {runCeiling}</em>
            </div>
          </section>
          </div>

          <section className="resilience-rail" role="region" aria-label="Battle resilience">
            <article><Scale size={15} /><span><strong>Reciprocal authority</strong><small>7 core calls · {Math.max(0, scheduledTurns - 7)} adaptive capacity</small></span></article>
            <article><RotateCcw size={15} /><span><strong>Crash-safe resume</strong><small>Durable local checkpoint</small></span></article>
            <article><TimerReset size={15} /><span><strong>Soft work leases</strong><small>{workLease} handoff · work preserved</small></span></article>
            <article><Gauge size={15} /><span><strong>{deepEffort}</strong><small>Reserved for source · dialogue stays lean</small></span></article>
          </section>

          <div className="prompt-field">
            <div className="prompt-heading">
              <label htmlFor="opening-prompt"><b>Opening prompt</b><em>{form.missionProfile === 'serious'
                ? 'Your requirements stay binding. The agents decide how to build them.'
                : 'Set the direction. The agents decide the product.'}</em></label>
              <div className="mission-switch" role="group" aria-label="Mission profile">
                {missionProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={form.missionProfile === profile.id ? 'selected' : ''}
                    aria-label={profile.label}
                    aria-pressed={form.missionProfile === profile.id}
                    title={profile.detail}
                    onClick={() => updateForm({
                      missionProfile: profile.id,
                      ...(profile.id === 'serious' && form.prompt === DEFAULT_SURPRISE_PROMPT
                        ? { prompt: '' }
                        : profile.id === 'surprise' && form.prompt.trim() === ''
                          ? { prompt: DEFAULT_SURPRISE_PROMPT }
                          : {})
                    })}
                  >
                    {profile.icon}<span>{profile.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <textarea
              id="opening-prompt"
              value={form.prompt}
              onChange={(event) => updateForm({ prompt: event.target.value })}
              placeholder={form.missionProfile === 'serious'
                ? 'Describe the product, requirements, constraints, and what success looks like…'
                : 'Give both agents a direction, not an idea…'}
              maxLength={8000}
            />
            <small>{form.prompt.length.toLocaleString()} / 8,000</small>
          </div>

          <div className="workspace-control">
            <div>
              <span className="control-label">Workspace destination</span>
              <strong
                data-testid="workspace-destination"
                title={form.workspaceRoot ? 'Exact path hidden for camera privacy' : 'Choose a dedicated local folder'}
                aria-label={form.workspaceRoot
                  ? 'Workspace selected. Exact path hidden for camera privacy.'
                  : 'No workspace selected. Choose a dedicated local folder.'}
              >
                {form.workspaceRoot ? 'Dedicated local folder selected' : 'Choose a dedicated folder'}
              </strong>
            </div>
            <button className="secondary-button" type="button" onClick={() => void chooseWorkspace()}><FolderOpen size={15} /> Choose</button>
          </div>

          <fieldset className="mode-fieldset">
            <legend>Execution</legend>
            <div className="mode-grid execution-grid">
              {executionModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`mode-card ${form.executionMode === mode.id ? 'selected' : ''} ${mode.id !== 'simulation' && !realReady ? 'unavailable' : ''}`}
                  aria-pressed={form.executionMode === mode.id}
                  aria-label={mode.label}
                  onClick={() => updateForm({ executionMode: mode.id, dangerousModeConfirmed: false })}
                >
                  <span className="mode-icon">{mode.icon}</span>
                  <span><strong>{mode.label}</strong><small>{mode.detail}</small></span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="mode-fieldset visibility-fieldset">
            <legend>What you see</legend>
            <div className="mode-grid visibility-grid">
              {visibilityModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`visibility-card ${form.visibilityMode === mode.id ? 'selected' : ''}`}
                  aria-pressed={form.visibilityMode === mode.id}
                  onClick={() => updateForm({ visibilityMode: mode.id })}
                >
                  {mode.icon}<span><strong>{mode.label}</strong><small>{mode.detail}</small></span>
                </button>
              ))}
            </div>
          </fieldset>

          {form.executionMode === 'yolo-sandbox' && (
            <label className="danger-confirm">
              <input type="checkbox" checked={form.dangerousModeConfirmed} onChange={(event) => updateForm({ dangerousModeConfirmed: event.target.checked })} />
              <span><strong>I am inside a disposable container or VM.</strong> This removes routine agent permission barriers.</span>
            </label>
          )}

          {error && <div className="inline-error" role="alert"><TriangleAlert size={16} />{error}</div>}
          {realUnavailable && <div className="inline-error quiet"><TriangleAlert size={16} />Real Mode needs Codex, Claude Code, and Git ready—or switch back to Simulation.</div>}

          <div className="launch-actions">
            <div className="safety-copy"><Shield size={15} /><span>Generated runs stay in a fresh local workspace. Nothing is published.</span></div>
            <div className="launch-primary-action">
              <small>Fresh sealed workspace</small>
            <button className="primary-button" type="button" onClick={() => void startRun()} disabled={!canStart || (form.executionMode === 'yolo-sandbox' && !form.dangerousModeConfirmed)}>
              <Play size={16} fill="currentColor" />{busy ? 'Preparing war room…' : startLabel}
            </button>
            </div>
          </div>
        </div>

        <aside className="launch-side-rail">
          <AgentLoadoutPanel
            key={`${settings?.codexModel ?? ''}:${settings?.codexEffort ?? 'default'}:${settings?.claudeModel ?? ''}:${settings?.claudeEffort ?? 'default'}`}
            health={health}
            settings={settings}
            busy={busy}
            onRefresh={() => void refreshHealth()}
            onSave={(nextSettings) => saveSettings(nextSettings, { syncLaunchDefaults: false })}
            onOpenAgentCli={openAgentCli}
          />
          <RecentBuilds
            builds={recentBuilds}
            onRecover={recoverRecentBuild}
            onResume={(build) => void resumeRun(build.runId)}
            onOpen={(build) => void openRunFolder(build.runId)}
          />
        </aside>
      </section>

      <section className="sequence-rail" aria-label="Run sequence">
        <div><span>01</span><strong>{form.missionProfile === 'serious' ? 'Solution chamber' : 'Pitch chamber'}</strong><small>{form.missionProfile === 'serious' ? 'Both agents propose approaches to your brief.' : 'Both agents propose hidden ideas.'}</small></div>
        <i />
        <div><span>02</span><strong>Conflict arena</strong><small>Weak choices are challenged in public.</small></div>
        <i />
        <div><span>03</span><strong>Build & repair</strong><small>Reciprocal edits, evidence, checkpoints.</small></div>
        <i />
        <div><span>04</span><strong>Reveal</strong><small>Only the surviving app is unlocked.</small></div>
      </section>
    </main>
  )
}
