import { describe, expect, it } from 'vitest'
import { missionPresentation } from '../../src/renderer/src/lib/mission-presentation'

describe('mission presentation', () => {
  it('keeps Surprise cinematic and Serious evidence-forward without changing recorded data', () => {
    expect(missionPresentation('surprise')).toMatchObject({
      arena: 'Conflict arena', feed: 'Live rivalry', board: 'Task storm', completion: 'The build survived'
    })
    expect(missionPresentation('serious')).toMatchObject({
      arena: 'Architecture review', feed: 'Decision review', board: 'Delivery board', completion: 'Delivery gate passed'
    })
  })
})
