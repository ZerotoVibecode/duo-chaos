# Architecture

Duo Chaos uses three trust zones.

## Electron main

The main process owns filesystem access, settings, CLI health checks, model-profile detection, child processes, Git, orchestration, raw events, and reveal packets. It is the only process allowed to see private run data.

## Preload bridge

The context-isolated preload exposes a small typed API for bootstrap, settings, health, workspace selection, run lifecycle, CLI terminals, reveal actions, and window controls.

## React renderer

The renderer displays projected `RunSnapshot` values. Before reveal, private event text, metadata, private task names, and reveal packets are stripped or redacted in main.

## Run lifecycle

1. Validate the request, mission profile, and workspace policy. Surprise missions treat the brief as creative direction. Serious missions seal the exact brief, require a substantive acceptance plan whose checks cover key brief terms, and pin its fingerprint/evidence in the supervisor runtime outside the generated workspace. A missing, altered, or jointly rewritten workspace chain is downgraded.
2. Resolve effective Codex and Claude runtime profiles.
3. Create a fresh workspace and canonical `.duo/` protocol tree.
4. Initialize Git and record a checkpoint.
5. Run a seven-call core schedule: four alternating lean debate calls, two fresh deep source contributions, and one reciprocal cross-review. The run ID rotates which provider opens. Higher configured limits reserve only balanced repair pairs, which run after objective failures rather than by default.
6. Run pitch and critique turns as one ephemeral, schema-constrained dialogue capsule. Claude has no tools; Codex has its shell feature disabled, ignores user/project rules, and cannot persist a session. Provider schemas are specialized per turn so pitch cannot drift into tasks/consensus. The main process—not the model—writes the validated public/private protocol and locally adds any omitted private title redactions before public projection.
7. Inject only the compact human brief, current board, and latest private opponent exchange. The capsule preserves private pitches and writes the final consensus name, spec, redactions, and balanced task split into sealed workspace files.
8. Run each normal build contribution as one fresh compact call with selected effort and only essential workspace tools. The first builder must produce app source. The integrating builder may preserve that source only after recorded verification proves no honest edit is needed; this avoids token-heavy performative changes without weakening reciprocal review or the supervisor release gate. The agent receives the sealed brief, compact board, latest teammate handoff, and current files rather than resumed provider history. A provider quota warning pauses before another premium call; a rejection never retries blindly or hands control to the opponent. The older opening/work/verdict executor remains only for durable compatibility with paused v1 battles.
9. Stream bounded CLI activity into safe spectator signals while polling public dispatches, opinions, conflicts, conservative build-failure/repair signals, the shared board, and persisted run state during the active turn. Agent-authored pass claims never certify a release.
10. Persist exactly one short spoiler-safe statement for each structured dialogue turn: an opening, a counter linked to the latest opponent dispatch, or the consensus verdict, plus the active agent's opinion. Source-changing turns file their own evidence and handoff dispatches; no separate spectator model call is launched.
11. Normalize protocol aliases into one event contract, assign stable identities across polls, and project spoiler-safe events to the renderer.
12. Derive a transient Broadcast Director snapshot from projected public events. It rotates exact quotes, factual evidence, scheduled missions, and sourced director context without persisting spectator state back into agent context.
13. After reciprocal review, run a separate supervisor verifier on the exact current source revision. It executes only allowlisted package checks with argument arrays and performs a contained artifact smoke check. Agent-reported pass claims cannot certify release. If proof fails, continue through configured balanced repair pairs until proof passes or the 24-hour default run ceiling is reached.
14. Persist privacy-safe recent-build and provider-usage summaries from a supervisor-owned runtime record outside the generated workspace. A terminal resolution beat overrides stale activity when the run becomes ready.
15. Persist a versioned manifest plus append-only journal at every meaningful boundary. Recoverable provider/host failures become resumable pauses; app downtime does not consume the active run ceiling. Startup reconstruction validates run/workspace identity and ignores a truncated final journal record. A checkpoint mismatch is never auto-restored: Resume hard-stops rather than hiding or discarding a possible human edit.

Reveal handoff is supervisor-owned and defensive. Missing names, shipped work, and direct entrypoints are recovered from bounded sealed specs, completed board tasks, HTML titles, and package metadata. Legacy packet shapes remain readable. Recorded public dispatches and opinions take precedence over closing-agent claims in the drama recap. A `ready` result requires both runnable-artifact evidence and an independent supervisor pass on the current revision. Generated-app launch targets are canonicalized, confined to the run workspace, and limited to HTML files or safe workspace directories.

After reveal, static or built HTML can be captured as pixels for Artifact Premiere. The main process resolves the entrypoint inside the run workspace, renders it in a unique non-persistent offscreen Chromium session behind a contained `duo-artifact://` protocol, blocks external network, navigation, popups, downloads, permissions, and webviews, and sends only a PNG data URL to the renderer. Successful screenshots use a small bounded cache; failed captures are evicted so the user can retry. Dev-only package apps return an unavailable preview and an inspect-workspace action; Duo never starts dependency or package scripts to manufacture a screenshot.

Generated workspaces retain only the compact collaboration protocol in `.duo/public`, `.duo/private`, and `.duo/sealed`. Public events can cross IPC; private and sealed files remain local. Because task-board, claim, and lock records may also contain hidden titles or paths, those files are excluded from Git checkpoints together with private and sealed data by both generated ignore rules and an enforced index cleanup. Run state, raw streams, transcripts, rolling timelines, logs, and prompts live under Electron `userData/runs/<runId>`, outside the agents' working directory. Legacy workspaces with in-repo runtime records remain readable. Broadcast snapshots exist only in the main-process-to-renderer projection, so presentation logic cannot influence later agent prompts.
