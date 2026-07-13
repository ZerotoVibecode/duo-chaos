import { Pause, Play, RotateCcw, Swords } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { BattleReplayScene } from '@shared/battle-replay'
import './BattleReplay.css'

const SCENE_DURATION_MS = 3_500

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function agentLabel(agent: BattleReplayScene['agent']): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  return 'Director'
}

export function BattleReplay({ scenes, label = "Director's cut" }: { scenes: BattleReplayScene[]; label?: string }): React.JSX.Element | null {
  const reducedMotion = useMemo(() => prefersReducedMotion(), [])
  const [activeIndex, setActiveIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const active = scenes[activeIndex]
  const atEnd = activeIndex === scenes.length - 1

  useEffect(() => {
    if (!expanded || !playing || scenes.length < 2) return
    const timeout = window.setTimeout(() => {
      setActiveIndex((current) => {
        if (current >= scenes.length - 1) {
          setPlaying(false)
          return current
        }
        const next = current + 1
        if (next === scenes.length - 1) setPlaying(false)
        return next
      })
    }, SCENE_DURATION_MS)
    return () => window.clearTimeout(timeout)
  }, [activeIndex, expanded, playing, scenes.length])

  if (!active) return null

  const openReplay = (): void => {
    setExpanded(true)
    setActiveIndex(0)
    setPlaying(!reducedMotion && scenes.length > 1)
  }

  const togglePlayback = (): void => {
    if (atEnd) {
      setActiveIndex(0)
      setPlaying(!reducedMotion && scenes.length > 1)
      return
    }
    setPlaying((current) => !current)
  }

  const controlLabel = atEnd
    ? "Replay director's cut"
    : playing
      ? "Pause director's cut"
      : "Play director's cut"

  return (
    <section className={`battle-replay ${expanded ? 'is-expanded' : ''}`} role="region" aria-label="Director's cut">
      <header className="battle-replay-heading">
        <div>
          <span className="eyebrow"><Swords size={13} /> {label}</span>
          <h2>{expanded ? 'The build, in recorded moves' : `${String(scenes.length)} recorded moments`}</h2>
        </div>
        {expanded ? (
          <button className="battle-replay-control" type="button" aria-label={controlLabel} onClick={togglePlayback}>
            {atEnd ? <RotateCcw size={15} /> : playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            <span>{atEnd ? 'Replay' : playing ? 'Pause' : 'Play'}</span>
          </button>
        ) : (
          <button className="battle-replay-control" type="button" aria-label="Watch director's cut" onClick={openReplay}>
            <Play size={15} fill="currentColor" /><span>Watch replay</span>
          </button>
        )}
      </header>

      {expanded && (
        <>
          <div className={`battle-replay-stage agent-${active.agent}`} key={active.id}>
            <div className="battle-replay-signal" aria-hidden="true"><i /><i /><span /></div>
            <div className="battle-replay-copy">
              <span className="battle-replay-meta">Round {active.round} · {agentLabel(active.agent)} · {active.eyebrow}</span>
              <h3>{active.headline}</h3>
              <p>{active.body}</p>
            </div>
            <span className="battle-replay-count">{String(activeIndex + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')}</span>
          </div>

          <nav className="battle-replay-rail" aria-label="Director's cut scenes">
            {scenes.map((item, index) => (
              <button
                className={index === activeIndex ? 'active' : ''}
                type="button"
                key={item.id}
                aria-label={`Show scene ${index + 1}: ${item.eyebrow}`}
                aria-current={index === activeIndex ? 'step' : undefined}
                onClick={() => {
                  setActiveIndex(index)
                  setPlaying(false)
                }}
              >
                <i />
                <span>{item.eyebrow}</span>
              </button>
            ))}
          </nav>
        </>
      )}
    </section>
  )
}
