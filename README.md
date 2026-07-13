# Duo Chaos

**Duo Chaos by ZeroToVibecode** is a local desktop war room where Codex CLI and Claude Code pitch, argue, build, review, break, and repair one product together from a single prompt.

![Duo Chaos live run](docs/assets/dashboard.png)

The app drives the CLIs already installed and authenticated on your machine. It does not integrate directly with the OpenAI or Anthropic APIs. Simulation Mode works without either CLI and is the fastest way to explore the product.

## Why it is different

- Claude and Codex are equal agents; both can pitch, criticize, code, review, and repair.
- **Surprise build** lets the agents secretly invent the product. **Serious build** seals a fingerprinted copy of the human brief, requires a brief-anchored acceptance plan, and pins that plan in the supervisor's external runtime so later workspace edits cannot silently redefine success.
- Real Mode normally uses seven provider calls: four lean debate calls, two fresh deep source contributions, and one reciprocal cross-review. Opening authority rotates between runs. Extra capacity is reserved as balanced Claude-Codex repair pairs and runs only when recorded evidence finds a defect.
- Agent Comms presents direct, reply-linked dialogue in plain English, so agreements, objections, evidence, and handoffs read like a real collaboration.
- Each structured exchange records one authentic statement from the active agent—opening, direct counter, or verdict—rather than manufacturing both sides of a conversation from one model response.
- A live broadcast stage rotates through exact agent quotes, director context, failures, repairs, missions, and workspace evidence without inventing drama.
- Evidence Momentum keeps both agents' recorded challenges, accepted calls, edits, tasks, repair saves, and shared verification proof visible without inventing a score or winner.
- A full-text criticism feed exposes product and engineering disagreements without attacking personalities or clipping long statements.
- Real Mode watches the shared protocol continuously, so spoiler-safe opinions, CLI activity, tasks, and build pressure appear during long agent turns rather than after they finish.
- Claude and Codex alternate every accepted Real Mode call. Dialogue contract failures get one narrow, schema-constrained recovery with every workspace tool disabled, so expensive implementation is not repeated. A provider quota rejection pauses the whole balanced duel with durable work preserved—no doomed fresh retry and no silent solo takeover.
- Product debate uses one schema-constrained, tool-free capsule per call. Source work uses a fresh compact provider context with only essential workspace tools, keeping selected Max/Ultra effort concentrated on implementation and evidenced repairs. Review is capped at High. The default long-work lease is two hours and the independent overall run ceiling is 24 hours.
- Spoiler Shield keeps the generated idea hidden while preserving the drama.
- Recent Builds shows the latest eight local runs, restores cancelled/interrupted prompts without exposing sealed ideas, resumes durable paused battles from their saved logical turn, returns restart-interrupted reveal-ready runs to the Reveal button, retains privacy-safe proof summaries, and can reopen completed workspaces.
- Provider-reported token usage and contribution evidence remain visible per agent; Duo does not invent prices that a CLI did not report.
- A terminal completion scene clearly distinguishes a fully ready build from a partial result with documented caveats.
- Instant Battle Replay reconstructs the reveal from public event and task evidence, with source-backed scenes, manual controls, and reduced-motion support. It launches no additional model calls.
- Artifact Premiere shows an isolated proof-of-life image of static or built output. Generated code renders in a contained offscreen Chromium session; the Studio renderer receives pixels only, and package scripts are never started for the preview.
- Reveal recovery accepts useful alternate agent packets, restores product names from sealed specs or HTML titles, and fills **What shipped** from completed work instead of showing a run-folder name or an empty card.
- Explicit model and effort controls include Sol Ultra, Fable Max, and a custom model-ID path for newer CLI-supported models.
- Stop requires a permanent-cancellation confirmation, then terminates active child processes, preserves the workspace, and returns you to an editable prompt. A stopped battle cannot be resumed.
- The dashboard adapts from a compact 1000×700 window to large full-screen displays.
- A responsive readability scale keeps interface text at 10px or larger while preserving compact and full-screen layouts.
- Every run gets a fresh local workspace and Git checkpoints. Supervisor timelines, prompts, transcripts, and raw streams live in Electron's private application-data directory, outside the workspace the agents can inspect. Private, sealed, task-board, claim, and lock coordination stays local but is forcibly excluded from every generated-workspace checkpoint, even if an agent tries to stage it.

## Quick start

Requirements:

- Node.js 22.12 or newer
- npm 11 or a compatible recent release
- Git
- Optional for Real Mode: authenticated `codex` and `claude` CLIs

```bash
git clone https://github.com/ZerotoVibecode/duo-chaos.git
cd duo-chaos
npm install
npm run dev
```

Choose **Simulation**, enter a prompt, and select **Start simulation**. No AI CLI or paid model usage is required.

## Real Mode

Real Mode launches local child processes with argument arrays and streams their machine-readable output into the dashboard. The app detects missing CLIs and explains the problem instead of failing silently.

The spectator pipeline also polls each run's `.duo/public/` dispatches, opinions, conflicts, and shared board while a CLI is active. A deterministic Broadcast Director turns only those public records into rotating on-screen beats; it does not call another model, add cost, or invent quotes, winners, emotions, concessions, or confidence. Event aliases are normalized, duplicate polls receive stable identities, private task details stay sealed, and older reveal packets receive a factual drama recap from the run record. Missing confidence or heat remains visibly unscored.

Claude receives its multiline assignment over stdin instead of a fragile Windows command-line argument. Structured product dialogue publishes a direct dispatch and opinion. Normal build contributions are cohesive, fresh calls with a required teammate handoff, not separate narration calls. The first builder must create a real app delta. The integrating builder must improve the source when evidence warrants it, but may preserve an already-correct tree after recorded verification rather than inventing a cosmetic edit. Reciprocal review, owned tasks, and independent final verification still gate release. Optional raw streams remain local outside generated workspaces and never become agent context.

Workspace-authored public protocol is treated as untrusted. In Spoiler Shield, an exact argument remains visible only when it uses explicit placeholders such as `[FEATURE]` or is actually changed by the sealed redaction dictionary. Otherwise Duo replaces it with a truthful spoiler-sealed handoff instead of trusting an agent-supplied zero-risk label. Full Chaos and post-reveal transcripts retain the original detail.

Normal source contributions are fresh, compact provider calls: the orchestrator passes the human brief, sealed decision, compact board, and latest private teammate exchange without replaying a growing provider session. Product debate is also ephemeral and tool-free. Legacy paused battles retain their exact staged session cursor for compatibility. Provider-owned history remains controlled by the installed Codex/Claude CLI and may outlive a Duo workspace.

The supervisor normally assembles the reveal from bounded workspace evidence. Legacy agent-authored packets are adapted defensively. A claimed `ready` status is downgraded unless a runnable artifact exists and the separate supervisor verifier passes the exact final source revision. Agent-reported test commands remain useful repair evidence but cannot unlock release. Direct-open HTML targets are confined to the generated workspace; traversal, external absolute paths, and executable launch targets are rejected. Package-based apps prefer built `dist`/`build` output and do not open a Vite source index through `file://`.

Mission, execution, and visibility are separate:

| Mission | Behavior |
| --- | --- |
| Surprise build | The prompt is creative direction; the agents privately invent and select the product. Default. |
| Serious build | The prompt is a binding product brief; the agents must preserve its requirements and seal concrete acceptance checks before implementation. |

| Execution | Behavior |
| --- | --- |
| Simulation | Deterministic demo with no AI CLI usage. |
| Safe | Conservative local editing permissions. |
| Chaos | Autonomous turns inside a fresh workspace. Recommended Real Mode. |
| YOLO Sandbox | Dangerous bypass flags; available only after explicit disposable-environment confirmation. |

Simulation is a workflow rehearsal, not a product generator. A Serious + Simulation run is revealed as **partial** and directs the user to Real Mode; it never pretends the canned sample artifact implemented the binding brief.

| Visibility | Behavior |
| --- | --- |
| Blind | Shows only phase and health signals. |
| Spoiler Shield | Shows spoiler-safe criticism, conflicts, tasks, and failures. Default. |
| Full Chaos | Shows unredacted detail and may spoil the idea. |

### Models and effort

**Agent loadout** exposes model and effort controls directly on the launch screen while still showing the detected CLI profile. Blank model fields and **CLI default** effort inherit your local configuration. Duo reads Codex's visible local model catalog and Claude Code's advertised aliases when those capabilities are available, falls back to a safe built-in catalog when they are not, and retains **Custom model ID** for account-specific identifiers.

Model names are passed through to the installed CLI. Effort choices are constrained per selected model, so `ultra` appears only when that local Codex model advertises it and stale incompatible choices reset to **CLI default**. Internal hidden Codex entries and unknown effort values are filtered out. Claude Code's automated effort flag currently supports values through `max`; interactive Ultracode is not sent as an unsupported `--effort` value.

The live agent cards show provider-reported processed input, cached input, output, call counts, and reported cost when a CLI supplies it. These numbers are telemetry, not estimates. The selected Max/Ultra effort is preserved where it affects the artifact—implementation, visual polish, and evidenced repair—while routine debate and verification use bounded stage-specific effort. This cuts tool-loop waste without silently downgrading the build itself.

### Token and quota behavior

- Claude debate receives an empty tool set. Codex debate disables the shell feature and uses a stage-specific output schema: pitch turns structurally require two pitches and forbid tasks/consensus, while consensus turns require the sealed decision shape. Any remaining observed command/file activity still rejects the capsule.
- The capsule retains two private pitches, direct opening/counter/verdict speech, an opinion, and—at consensus—the chosen name, sealed spec, redactions, and balanced task split.
- If a provider omits a private candidate title from its redaction list, the supervisor adds a canonical title locally before public projection, reserves redaction capacity for mandatory names, and compares punctuation-normalized whole phrases. This strengthens Spoiler Shield without another model call or changing the agent's statement.
- Source work starts from a fresh compact context, batches reads and searches, and uses only essential workspace tools. It does not replay the full debate or a growing provider transcript.
- Claude automated source calls use fresh no-session-persistence mode with a small Read/Glob/Grep/Edit/Write/Bash tool set. Safe mode keeps local OAuth/keychain authentication available while prompt suggestions, project/global skills, plugins, hooks, MCP servers, and auto-memory stay disabled.
- Provider quota warnings appear as live pressure events. A hard rejection pauses the entire duel before the opponent moves. The workspace, balanced turn cursor, usage, and evidence remain resumable; Duo neither retries blindly nor permits a one-agent takeover.
- Restored lean battles continue at the saved call boundary from Git plus a compact evidence baton. Legacy staged battles retain their exact work/verdict/recovery cursor. Previously recorded protocol is re-projected through the current Spoiler Shield.
- Recoverable authentication, model, compatibility, provider, session, host, and protocol boundaries pause with a specific action. Object/array/mixed provider output is replayed from the bounded local spool before any contract-recovery call.
- This is usage reduction, not a fixed token guarantee. Model providers, CLI versions, prompts, and generated projects still determine actual usage.

## Pause, resume, stop

A recoverable provider or host boundary creates **Battle suspended**, not **Failed**. Active elapsed time freezes, the supervisor persists a versioned manifest and append-only journal outside the workspace, and **Resume battle** continues the same logical turn before the opponent moves. Active runs found after an app restart are reconstructed as paused rather than auto-running provider calls in the background. If the generated app no longer matches its recorded checkpoint, Resume hard-stops instead of silently discarding possible human edits.

Pause and Stop are intentionally different. Stop is a human cancellation:

Stopping a run:

1. aborts the orchestrator;
2. terminates the active process tree;
3. marks the run cancelled;
4. preserves its generated workspace and logs;
5. enables **Back to prompt**, retaining the previous prompt for editing.

See [docs/PUBLIC_BETA_OPERATIONS.md](docs/PUBLIC_BETA_OPERATIONS.md) for the exact failure policy, quota behavior, crash recovery, recording checklist, privacy guidance, and current limits.

## Safety model

- The Electron renderer has no Node access and receives data through a typed preload bridge.
- Private event text and reveal packets stay in the main process until reveal.
- Child processes use `shell: false`, sanitized environments, timeouts, and process-tree cancellation.
- Workspace-write modes are scoped to a fresh run directory.
- YOLO mode is not host isolation. Use a disposable VM, container, or devcontainer.
- Generated code and dependency scripts remain untrusted until reviewed.

See [docs/SAFETY.md](docs/SAFETY.md), [docs/PRIVACY_AND_DATA.md](docs/PRIVACY_AND_DATA.md), [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), and [SECURITY.md](SECURITY.md).

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:e2e
npm run benchmark:receipts
npm run pack
```

`npm run check` runs typecheck, lint, unit/integration tests, and the production build. Electron E2E tests cover the complete Simulation reveal, cancelled-run recovery, recent builds, terminal completion, broadcast cadence and provenance, and responsive window/full-screen layouts with long dialogue.

CI also runs `npm run pack` on Windows to verify that Electron Builder can assemble an unpacked application. This packaging check does not claim that the installer or packaged binary has been launched; perform that smoke test on the intended release machine before publishing an installer.

`npm run benchmark:receipts` is offline by default. With no arguments it compares deterministic synthetic receipts and makes zero provider calls. Pass saved, privacy-safe receipt JSON files to compare Duo readiness, contribution balance, verification, provider-reported usage/calls, and active elapsed time. See [docs/BENCHMARKING.md](docs/BENCHMARKING.md).

## Architecture

```text
React renderer
  └─ typed, isolated preload bridge
      └─ Electron main process
          ├─ run orchestrator and state machine
          ├─ Spoiler Shield projection
          ├─ settings and runtime-profile detection
          ├─ workspace and Git checkpoint managers
          └─ local Codex / Claude child processes
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the process and data boundaries.

## What gets committed vs what stays local

Committed:

- application source, tests, schemas, resources, configuration, and lockfile;
- contributor/security documentation and GitHub workflows.

Ignored and local:

- `node_modules/`, `out/`, `release/`, coverage, and screenshots;
- `workspaces/`, `runs/`, and `.duo/` generated content;
- prompts entered by users, hidden specs, transcripts, raw logs, and reveal packets;
- `.env` files, credentials, tokens, and machine configuration.

## Status

Simulation Mode is release-ready. Real Mode is a public beta because upstream CLI output formats, model aliases, and quota reporting can evolve, and application-level workspace scoping is not an operating-system sandbox. Recoverable failures preserve a resumable battle, but no local supervisor can guarantee exactly-once remote execution across power loss.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and focused improvements are welcome; protect Simulation Mode, equal-agent behavior, process cancellation, and Spoiler Shield.

## Independence

Duo Chaos is an independent open-source project by ZeroToVibecode. It is not affiliated with or endorsed by OpenAI, Anthropic, or Apple. Codex and Claude are trademarks of their respective owners.

## License

MIT © 2026 ZeroToVibecode.
