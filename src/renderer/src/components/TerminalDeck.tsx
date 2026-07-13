import { ChevronDown, LockKeyhole, SquareTerminal } from 'lucide-react'
import type { DuoEvent } from '@shared/types'

interface TerminalDeckProps {
  events: DuoEvent[]
  open: boolean
  onToggle: () => void
}

export function TerminalDeck({ events, open, onToggle }: TerminalDeckProps): React.JSX.Element {
  const logs = events.filter((event) => event.type === 'cli.log')
  return (
    <section className={`terminal-deck glass-panel ${open ? 'open' : ''}`}>
      <button className="terminal-toggle" type="button" onClick={onToggle} aria-expanded={open}>
        <span><SquareTerminal size={15} /> Redacted process streams <small>{logs.length} signals</small></span>
        <span><LockKeyhole size={13} /> Raw locked <ChevronDown size={15} /></span>
      </button>
      {open && (
        <div className="terminal-grid">
          <TerminalPane agent="claude" events={logs.filter((event) => event.source === 'claude' || event.agent === 'claude')} />
          <TerminalPane agent="codex" events={logs.filter((event) => event.source === 'codex' || event.agent === 'codex')} />
        </div>
      )}
    </section>
  )
}

function TerminalPane({ agent, events }: { agent: 'claude' | 'codex'; events: DuoEvent[] }): React.JSX.Element {
  return (
    <div className={`terminal-pane terminal-${agent}`}>
      <div><span className="terminal-lights"><i /><i /><i /></span><strong>{agent === 'claude' ? 'CLAUDE.CODE' : 'CODEX.EXEC'}</strong><span>PUBLIC STREAM</span></div>
      <pre>{events.length === 0 ? `$ ${agent} waiting for a turn…` : events.slice(-8).map((event) => `[${event.category ?? 'message'}] ${event.publicText}`).join('\n')}</pre>
    </div>
  )
}
