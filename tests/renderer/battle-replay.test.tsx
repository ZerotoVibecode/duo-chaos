// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BattleReplayScene } from '../../src/shared/battle-replay'
import { BattleReplay } from '../../src/renderer/src/components/BattleReplay'

const scenes: BattleReplayScene[] = [
  {
    id: 'scene-challenge',
    kind: 'challenge',
    round: 1,
    agent: 'claude',
    eyebrow: 'Opening challenge',
    headline: 'Claude challenged the first direction',
    body: 'Claude wanted the interaction to stay focused.',
    sourceEventIds: ['challenge'],
    sourceTaskIds: []
  },
  {
    id: 'scene-counter',
    kind: 'counter',
    round: 2,
    agent: 'codex',
    eyebrow: 'Direct counter',
    headline: 'Codex answered with runnable evidence',
    body: 'Codex proposed a smaller path.',
    sourceEventIds: ['counter', 'challenge'],
    sourceTaskIds: []
  }
]

function setReducedMotion(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
}

describe('BattleReplay', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays collapsed until the viewer chooses the Director\'s Cut, then plays once', async () => {
    setReducedMotion(false)
    render(<BattleReplay scenes={scenes} />)

    expect(screen.getByRole('region', { name: /director's cut/i })).toBeVisible()
    expect(screen.getByText(/2 recorded moments/i)).toBeVisible()
    expect(screen.queryByText('Claude challenged the first direction')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /watch director's cut/i }))
    expect(screen.getByText('Claude challenged the first direction')).toBeVisible()
    expect(screen.getByRole('button', { name: /pause director's cut/i })).toBeVisible()

    await act(() => vi.advanceTimersByTime(3_500))
    expect(screen.getByText('Codex answered with runnable evidence')).toBeVisible()
    expect(screen.getByRole('button', { name: /replay director's cut/i })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /show scene 1/i }))
    expect(screen.getByText('Claude challenged the first direction')).toBeVisible()
  })

  it('does not autoplay when reduced motion is requested', async () => {
    setReducedMotion(true)
    render(<BattleReplay scenes={scenes} />)

    fireEvent.click(screen.getByRole('button', { name: /watch director's cut/i }))
    expect(screen.getByRole('button', { name: /play director's cut/i })).toBeVisible()
    await act(() => vi.advanceTimersByTime(7_000))
    expect(screen.getByText('Claude challenged the first direction')).toBeVisible()
  })
})
