import type { MissionProfile } from '@shared/types'

export interface MissionPresentation {
  arena: string
  feed: string
  board: string
  completion: string
  replay: string
  evidence: string
}

const presentations: Record<MissionProfile, MissionPresentation> = {
  surprise: {
    arena: 'Conflict arena',
    feed: 'Live rivalry',
    board: 'Task storm',
    completion: 'The build survived',
    replay: "Director's cut",
    evidence: 'Proof trail'
  },
  serious: {
    arena: 'Architecture review',
    feed: 'Decision review',
    board: 'Delivery board',
    completion: 'Delivery gate passed',
    replay: 'Decision history',
    evidence: 'Acceptance evidence'
  }
}

export function missionPresentation(profile: MissionProfile = 'surprise'): MissionPresentation {
  return presentations[profile]
}
