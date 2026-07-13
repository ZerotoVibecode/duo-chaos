import { Minus, Settings2, Square, Volume2, VolumeX, X } from 'lucide-react'
import type { RunSnapshot } from '@shared/types'

interface TopBarProps {
  run?: RunSnapshot
  soundEnabled: boolean
  onToggleSound: () => void
  onOpenSettings: () => void
}

export function TopBar({ run, soundEnabled, onToggleSound, onOpenSettings }: TopBarProps): React.JSX.Element {
  const status = run?.status === 'running'
    ? run.phase === 'preflight' ? 'Preflight' : 'Live run'
    : run?.status === 'paused'
      ? 'Paused'
    : run?.status === 'reveal-ready'
      ? 'Reveal ready'
      : run?.status === 'complete'
        ? 'Revealed'
        : run?.status === 'cancelled'
          ? 'Stopped'
          : run?.status === 'failed'
            ? 'Needs attention'
            : 'Standing by'
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><i /><i /></span>
        <span className="brand-name">Duo Chaos <small>by ZeroToVibecode</small></span>
        <span className={`status-chip status-${run?.status ?? 'idle'}`}><span className="status-dot" />{status}</span>
      </div>
      <div className="topbar-actions">
        <button
          className={`icon-button ${soundEnabled ? 'active' : ''}`}
          type="button"
          aria-label="Sound cues"
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >{soundEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
        <button className="icon-button" type="button" aria-label="Open settings" onClick={onOpenSettings}><Settings2 size={17} /></button>
        <span className="window-divider" />
        <button className="window-button" type="button" aria-label="Minimize window" onClick={() => void window.duo.minimizeWindow()}><Minus size={15} /></button>
        <button className="window-button" type="button" aria-label="Maximize window" onClick={() => void window.duo.toggleMaximizeWindow()}><Square size={12} /></button>
        <button className="window-button close" type="button" aria-label="Close window" onClick={() => void window.duo.closeWindow()}><X size={16} /></button>
      </div>
    </header>
  )
}
