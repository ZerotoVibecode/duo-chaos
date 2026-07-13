import type { DuoEventType } from '@shared/types'

const CUE_TYPES = new Set<DuoEventType>([
  'agent.dispatch', 'conflict', 'decision', 'build.failed', 'build.passed',
  'repair.completed', 'reveal.ready'
])

export function isCueEvent(type: DuoEventType): boolean {
  return CUE_TYPES.has(type)
}

export function playEventCue(type: DuoEventType): void {
  const AudioContextConstructor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return
  const audio = new AudioContextConstructor()
  const oscillator = audio.createOscillator()
  const gain = audio.createGain()
  const frequency = type === 'reveal.ready'
    ? 760
    : type === 'build.failed'
      ? 180
      : type === 'agent.dispatch'
        ? 420
        : 560
  oscillator.frequency.setValueAtTime(frequency, audio.currentTime)
  oscillator.type = 'sine'
  gain.gain.setValueAtTime(0.0001, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.035, audio.currentTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.11)
  oscillator.connect(gain)
  gain.connect(audio.destination)
  oscillator.start()
  oscillator.stop(audio.currentTime + 0.12)
  oscillator.addEventListener('ended', () => void audio.close(), { once: true })
}
