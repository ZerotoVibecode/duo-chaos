import { useEffect } from 'react'
import { AlertTriangle, LoaderCircle, X } from 'lucide-react'
import { useStudioStore } from './store/studio-store'
import { TopBar } from './components/TopBar'
import { LaunchCockpit } from './components/LaunchCockpit'
import { RunDashboard } from './components/RunDashboard'
import { RevealPanel } from './components/RevealPanel'
import { SettingsSheet } from './components/SettingsSheet'

export default function App(): React.JSX.Element {
  const {
    ready,
    run,
    error,
    soundEnabled,
    bootstrap,
    applySnapshot,
    setSettingsOpen,
    setSoundEnabled,
    clearError
  } = useStudioStore()

  useEffect(() => {
    void bootstrap()
    return window.duo.onRunSnapshot(applySnapshot)
  }, [applySnapshot, bootstrap])

  return (
    <div className="app-frame">
      <div className="ambient-field" aria-hidden="true"><i className="orb orb-one" /><i className="orb orb-two" /><i className="orb orb-three" /><span className="grain" /></div>
      <TopBar
        run={run}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(!soundEnabled)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {!ready ? (
        <main className="boot-screen"><span className="brand-mark large"><i /><i /></span><LoaderCircle className="spin" size={20} /><p>Preparing the local war room…</p></main>
      ) : run?.status === 'complete' && run.revealPacket ? (
        <RevealPanel run={run} />
      ) : run ? (
        <RunDashboard run={run} />
      ) : (
        <LaunchCockpit />
      )}
      {error && run?.status === 'complete' && <div className="toast error-toast"><AlertTriangle size={16} /><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={clearError}><X size={14} /></button></div>}
      <SettingsSheet />
    </div>
  )
}
