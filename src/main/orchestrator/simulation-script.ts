import { randomUUID } from 'node:crypto'
import type { AgentId, DuoEvent, DuoEventType, MissionProfile, RevealPacket } from '@shared/types'

export const SIMULATION_ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Afterglow Atlas</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#060812;color:#f6f2ea}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;overflow:hidden;background:radial-gradient(circle at 24% 20%,#213768 0,transparent 34%),radial-gradient(circle at 78% 76%,#43265e 0,transparent 38%),#060812}
    main{min-height:100vh;display:grid;grid-template-columns:minmax(320px,.78fr) 1.22fr;align-items:center;gap:5vw;padding:8vw}
    .copy{position:relative;z-index:2}.kicker{font:700 12px/1.2 ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:#9fe8ff}
    h1{max-width:720px;margin:20px 0 16px;font-size:clamp(58px,8vw,126px);line-height:.82;letter-spacing:-.075em;background:linear-gradient(115deg,#fff3dc,#d5b9ff 55%,#a8eeff);background-clip:text;color:transparent}
    p{max-width:540px;margin:0;color:#bdc6d8;font-size:clamp(17px,1.4vw,24px);line-height:1.55}.note{display:inline-flex;margin-top:30px;padding:11px 15px;border:1px solid #ffffff22;border-radius:999px;color:#e8e3f2;background:#ffffff09;font-size:13px}
    .atlas{position:relative;aspect-ratio:1;max-width:700px;width:100%;justify-self:end}.orbit{position:absolute;inset:8%;border:1px solid #b89cff38;border-radius:50%;animation:turn 28s linear infinite}.orbit:nth-child(2){inset:21%;border-color:#8ce9ff42;animation-direction:reverse;animation-duration:22s}.orbit:nth-child(3){inset:34%;border-color:#ffc4863d;animation-duration:17s}
    .star{position:absolute;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 0 18px 5px #b8a0ff88}.s1{left:14%;top:28%;background:#ffc486}.s2{right:11%;top:44%;background:#8ce9ff}.s3{left:43%;bottom:9%;background:#d2b5ff}.core{position:absolute;inset:43%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#d6b7ff 32%,#5c48a7 72%);box-shadow:0 0 60px 22px #a483ff55;animation:pulse 3s ease-in-out infinite}
    @keyframes turn{to{transform:rotate(360deg)}}@keyframes pulse{50%{transform:scale(1.08);box-shadow:0 0 80px 30px #a483ff66}}
    @media(max-width:760px){main{grid-template-columns:1fr;padding:12vw}.atlas{position:absolute;right:-22%;width:75%;opacity:.46}h1{font-size:clamp(56px,18vw,96px)}}
    @media(prefers-reduced-motion:reduce){*{animation:none!important}}
  </style>
</head>
<body><main><section class="copy"><span class="kicker">A sealed build survived</span><h1>Afterglow Atlas</h1><p>A private constellation of tiny moments, captured locally and replayed as an ambient memory map.</p><span class="note">Simulation artifact · no network · no account</span></section><section class="atlas" aria-label="Animated memory constellation"><i class="orbit"></i><i class="orbit"></i><i class="orbit"></i><i class="star s1"></i><i class="star s2"></i><i class="star s3"></i><i class="core"></i></section></main></body>
</html>`

export interface SimulationStep {
  delayMs: number
  event: DuoEvent
}

const revealPacket: RevealPacket = {
  appName: 'Afterglow Atlas',
  idea: 'A private constellation of tiny moments that turns daily memories into an explorable ambient map.',
  summary: 'Claude and Codex shipped a tactile local-first memory atlas with an animated constellation canvas, quick capture, and a cinematic replay mode.',
  features: ['Constellation memory canvas', 'Fast local capture', 'Ambient replay mode', 'Local-only persistence'],
  runCommand: 'Open app/index.html directly in a browser.',
  appPath: 'app/index.html',
  status: 'ready',
  whatWorked: ['Production build passed', 'Core interaction survived review', 'Spoiler Shield stayed intact'],
  knownIssues: [],
  agentDramaSummary: [
    'Claude won the first-interaction argument.',
    'Codex removed a risky animation dependency after the build failed.',
    'Both agents rejected the first layout as too generic.'
  ],
  gitCheckpoints: ['run initialized', 'idea sealed', 'task storm complete', 'repair passed', 'reveal ready'],
  agentQuotes: {
    claude: 'Codex was right about the dependency. I was right about the atmosphere.',
    codex: 'The reveal works because we cut the clever part that kept breaking it.'
  }
}

function event(
  runId: string,
  round: number,
  type: DuoEventType,
  agent: AgentId,
  publicText: string,
  additions: Partial<DuoEvent> = {}
): DuoEvent {
  return {
    id: randomUUID(),
    type,
    runId,
    round,
    timestamp: new Date(Date.now() + round * 1_000).toISOString(),
    agent,
    publicText,
    spoilerRisk: 0.2,
    severity: 'low',
    ...additions
  }
}

export function buildSimulationScript(
  runId: string,
  prompt: string,
  missionProfile: MissionProfile = 'surprise'
): SimulationStep[] {
  const opening = missionProfile === 'serious'
    ? 'Serious mission workflow rehearsal started. Real Mode is required to implement the binding brief. Spoiler Shield armed.'
    : 'Workspace created. Surprise mission armed. Spoiler Shield armed.'
  const missionRevealPacket: RevealPacket = missionProfile === 'serious'
    ? {
        ...revealPacket,
        appName: 'Afterglow Atlas · workflow rehearsal',
        idea: 'A canned sample artifact used to rehearse the Duo Chaos serious-build workflow without spending provider usage.',
        summary: 'The orchestration UI completed its rehearsal. The requested human brief was not implemented because Simulation Mode never launches the local AI CLIs.',
        status: 'partial',
        knownIssues: ['Use Real Mode to implement and verify the binding serious brief.']
      }
    : revealPacket
  return [
    { delayMs: 120, event: event(runId, 0, 'run.started', 'director', opening, { metadata: { prompt, missionProfile } }) },
    { delayMs: 520, event: event(runId, 1, 'phase.changed', 'director', 'Both agents entered the private pitch chamber.', { metadata: { phase: 'round.pitch' } }) },
    {
      delayMs: 760,
      event: event(runId, 1, 'opinion', 'claude', 'Claude thinks Codex is already trying to turn the [FEATURE] into three products at once.', {
        targetAgent: 'codex', dispatchKind: 'challenge', topic: 'scope', tone: 'skeptical', confidence: 0.77, heat: 0.58, severity: 'medium', spoilerRisk: 0.72,
        privateText: 'Claude thinks Codex is turning the memory constellation into capture, journaling, and social sharing at once.'
      })
    },
    {
      delayMs: 680,
      event: event(runId, 1, 'opinion', 'codex', "Codex says Claude's visual direction is beautiful, but suspiciously allergic to finishing the first screen.", {
        targetAgent: 'claude', dispatchKind: 'counter', topic: 'design', tone: 'amused', confidence: 0.7, heat: 0.46, severity: 'medium', spoilerRisk: 0.22
      })
    },
    { delayMs: 620, event: event(runId, 2, 'phase.changed', 'director', 'Critique round opened. The app idea remains sealed.', { metadata: { phase: 'round.critique' } }) },
    {
      delayMs: 780,
      event: event(runId, 2, 'conflict', 'director', 'Conflict opened: cinematic first impression versus the fastest stable core loop.', {
        publicTopic: 'Atmosphere vs buildability', privateTopic: 'Animated constellation entrance vs a static memory canvas',
        claudePosition: 'The first interaction must feel magical enough to justify the reveal.',
        codexPosition: 'The hidden core loop must work before a single flourish is added.', impact: 'high', status: 'open', severity: 'high', spoilerRisk: 0.6
      })
    },
    {
      delayMs: 720,
      event: event(runId, 2, 'decision', 'director', 'Codex wins the first cut. Claude keeps one signature interaction for the polish pass.', {
        winner: 'codex', resolution: 'Ship the stable interaction first and reserve one cinematic transition.', severity: 'high'
      })
    },
    { delayMs: 500, event: event(runId, 3, 'phase.changed', 'director', 'Consensus reached. Hidden idea and redaction dictionary sealed.', { metadata: { phase: 'round.tasking' } }) },
    {
      delayMs: 540,
      event: event(runId, 3, 'task.created', 'claude', 'Claude proposed the premium first-run interaction.', {
        task: { id: 'task-polish', publicTitle: 'Shape the first-run atmosphere', privateTitle: 'Build the constellation entrance', status: 'open', claimedBy: 'claude', risk: 'medium', files: ['app/src/components/RevealCanvas.tsx'] }
      })
    },
    {
      delayMs: 420,
      event: event(runId, 3, 'task.created', 'codex', 'Codex proposed the local state and runnable app shell.', {
        task: { id: 'task-shell', publicTitle: 'Build the stable local core', privateTitle: 'Build memory capture and local storage', status: 'open', claimedBy: 'codex', risk: 'low', files: ['app/src/state.ts', 'app/src/App.tsx'] }
      })
    },
    { delayMs: 420, event: event(runId, 3, 'task.claimed', 'codex', 'Codex claimed the stable local core and locked two files.', { relatedTaskIds: ['task-shell'] }) },
    { delayMs: 360, event: event(runId, 3, 'task.claimed', 'claude', 'Claude claimed the interaction pass and promised not to touch Codex’s state files.', { relatedTaskIds: ['task-polish'] }) },
    { delayMs: 580, event: event(runId, 4, 'agent.started', 'codex', 'Codex started the first implementation turn.', { metadata: { phase: 'round.code' } }) },
    { delayMs: 520, event: event(runId, 4, 'cli.log', 'codex', 'Created the local state layer and first working route.', { source: 'codex', stream: 'stdout', category: 'file', evidenceFiles: ['app/src/state.ts'] }) },
    {
      delayMs: 650,
      event: event(runId, 4, 'opinion', 'codex', 'Codex thinks Claude’s proposed motion layer is still too expensive for an unverified shell.', {
        targetAgent: 'claude', topic: 'dependency-risk', tone: 'cautious', confidence: 0.83, heat: 0.62, severity: 'medium'
      })
    },
    { delayMs: 520, event: event(runId, 5, 'agent.started', 'claude', 'Claude started an equal implementation turn.', { metadata: { phase: 'round.code' } }) },
    { delayMs: 580, event: event(runId, 5, 'cli.log', 'claude', 'Reframed the opening composition and removed two generic dashboard sections.', { source: 'claude', stream: 'stdout', category: 'file', evidenceFiles: ['app/src/App.tsx'] }) },
    {
      delayMs: 620,
      event: event(runId, 5, 'opinion', 'claude', 'Claude says the core is technically clean but currently looks like settings software wearing a gradient.', {
        targetAgent: 'codex', topic: 'ux', tone: 'annoyed', confidence: 0.88, heat: 0.78, severity: 'high'
      })
    },
    { delayMs: 480, event: event(runId, 6, 'build.started', 'director', 'Verification started. Both agents are watching the same build.') },
    { delayMs: 760, event: event(runId, 6, 'build.failed', 'director', 'Build failed: a renamed visual module still has one stale import.', { severity: 'critical', category: 'error', evidenceFiles: ['app/src/App.tsx'] }) },
    {
      delayMs: 560,
      event: event(runId, 6, 'opinion', 'codex', 'Codex blames Claude’s rename; Claude says Codex skipped the alias update during review.', {
        targetAgent: 'claude', topic: 'build', tone: 'annoyed', confidence: 0.91, heat: 0.9, severity: 'critical'
      })
    },
    { delayMs: 500, event: event(runId, 7, 'repair.started', 'claude', 'Claude claimed the repair and admitted the rename was under-documented.', { severity: 'high' }) },
    { delayMs: 620, event: event(runId, 7, 'repair.completed', 'claude', 'Import repaired. Claude also removed the animation package Codex distrusted.', { severity: 'medium', evidenceFiles: ['app/src/App.tsx', 'app/package.json'] }) },
    {
      delayMs: 520,
      event: event(runId, 7, 'opinion', 'claude', 'Claude admits the first motion plan was too elaborate and backs the smaller CSS-driven reveal.', {
        targetAgent: 'claude', topic: 'self-review', tone: 'self-critical', confidence: 0.86, heat: 0.34, severity: 'low'
      })
    },
    { delayMs: 580, event: event(runId, 8, 'build.passed', 'director', 'Production build passed. One final cross-review remains.', { severity: 'low' }) },
    {
      delayMs: 260,
      event: event(runId, 8, 'task.updated', 'claude', 'Claude completed the first-run atmosphere mission.', {
        task: {
          id: 'task-polish',
          publicTitle: 'Shape the first-run atmosphere',
          privateTitle: 'Build the constellation entrance',
          status: 'done',
          claimedBy: 'claude',
          risk: 'medium',
          files: ['app/src/components/RevealCanvas.tsx']
        }
      })
    },
    {
      delayMs: 260,
      event: event(runId, 8, 'task.updated', 'codex', 'Codex completed the stable local core mission.', {
        task: {
          id: 'task-shell',
          publicTitle: 'Build the stable local core',
          privateTitle: 'Build memory capture and local storage',
          status: 'done',
          claimedBy: 'codex',
          risk: 'low',
          files: ['app/src/state.ts', 'app/src/App.tsx']
        }
      })
    },
    {
      delayMs: 500,
      event: event(runId, 8, 'opinion', 'codex', 'Codex says Claude’s smaller reveal finally earns its complexity and no longer threatens the build.', {
        targetAgent: 'claude', topic: 'final-review', tone: 'impressed', confidence: 0.92, heat: 0.28, severity: 'low'
      })
    },
    ...(missionProfile === 'surprise' ? [{
      delayMs: 320,
      event: event(runId, 8, 'decision', 'director', 'Both agents delivered accepted source work and reviewed the current shared result.', {
        topic: 'quality-evidence-state',
        proof: {
          kind: 'quality-state',
          acceptedContributionAgents: ['claude', 'codex'],
          acceptedReviewAgents: ['claude', 'codex']
        },
        metadata: { synthetic: true, source: 'simulation-script' }
      })
    }] : []),
    { delayMs: 700, event: event(runId, 8, 'git.checkpoint', 'director', 'Checkpoint recorded: reveal-ready build.') },
    {
      delayMs: 780,
      event: event(runId, 8, 'reveal.ready', 'director', missionProfile === 'serious'
        ? 'Serious workflow rehearsal complete. Real Mode is required to build the brief.'
        : 'Build fully complete and ready for reveal.', {
        spoilerRisk: 1,
        severity: missionProfile === 'serious' ? 'medium' : 'high',
        privateText: `Reveal ready: ${missionRevealPacket.appName}.`,
        revealPacket: missionRevealPacket
      })
    }
  ]
}
