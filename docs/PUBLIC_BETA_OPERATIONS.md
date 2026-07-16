# Public beta operations

Duo Chaos Real Mode is a local-CLI public beta. It is designed to preserve a battle when a provider, process, or host reaches a recoverable boundary. It is not a promise that an upstream CLI, subscription, generated dependency, or operating system will always behave consistently.

Simulation Mode remains the zero-provider rehearsal path and should be the first test on every machine.

Serious missions create `serious_contract.json`, `human_brief.md`, and a brief-anchored acceptance plan in the sealed workspace. The supervisor pins the accepted specification hash and evidence in its private external runtime; rewriting both workspace files still fails that guard and prevents a `ready` release. Serious + Simulation remains a partial workflow rehearsal because no provider implements the brief.

## Before a Real Mode run

1. Update and authenticate the local `codex` and `claude` CLIs in their own terminals.
2. Start Duo Chaos and refresh **Agent loadout**.
3. Confirm both CLIs are available and that the selected model and effort are advertised by the local catalog.
4. Treat an **unverified** capability as a warning, not proof that a model, structured stream, or session resume will work.
5. Choose a source-stage toolbelt. Core disables user capabilities. Smart (default) uses Duo's compact quality skill plus configured plugins, apps, and MCPs while suppressing the global user-skill catalog. Broad restores the full user-skill catalog and can use substantially more context and quota. Smart and Broad require **Trust my local CLI capabilities**.
6. Use Core for Safe Mode. Choose Chaos for unattended Smart/Broad capability calls; a noninteractive provider cannot stop to request an MCP approval.
7. Review the local CLI's user configuration before granting that trust. Duo does not enumerate capability names or credentials, and generated-workspace project/local settings, hooks, and hidden subagents remain disabled.
8. Use a fresh workspace root with enough disk space and no credentials.
9. Rehearse the current screen layout with Simulation Mode before recording or spending provider usage.

The compatibility preflight pins a per-run snapshot of CLI version, transport formats, structured output, session resume, tool suppression, models, efforts, selected toolbelt profile, and quota-reset support. A verified unsupported model or transport blocks the run. Fallback catalogs remain visibly unverified because Duo cannot prove an account-specific capability from a name alone. Preflight does not inventory or certify an individual skill, plugin, app, or MCP server.

Dialogue uses provider-native structured output with a turn-specific schema. Claude receives no tools; Codex disables its shell feature. If a provider crosses that boundary, Duo rejects the capsule and runs one bounded contract-only recovery without repeating implementation. Source contributions are fresh compact calls that receive a supervisor-built focus baton and must leave a direct teammate handoff. Core uses supervised workspace tools with no user capabilities. Smart uses the app-owned `duo-quality` skill plus configured plugins, apps, and MCPs without advertising the global user-skill catalog. Broad restores that full catalog and accepts the higher context/quota cost. Neither trusted profile imports generated-workspace project/local settings, hooks, or hidden subagents. Missing private candidate-name redactions are repaired locally with canonical title terms, bounded capacity, and punctuation-normalized leak checks because deterministic repair is safer and cheaper than another model call. Workspace-authored protocol remains untrusted: Spoiler Shield shows exact text only when placeholders or the sealed dictionary remove hidden terms, and otherwise substitutes a factual spoiler-sealed handoff.

## Pause and resume contract

**Pause preserves the duel. Stop cancels it.**

When a recoverable boundary is detected, Duo Chaos:

- stops advancing the opponent, so one agent cannot silently take over;
- preserves the generated workspace, Git state, public event record, provider usage, task evidence, and exact logical turn cursor;
- stores a versioned run manifest and append-only journal in the supervisor-owned runtime directory;
- freezes active elapsed time while the battle is paused or the desktop app is closed;
- shows the provider, stage, reason, suggested action, and reset time when the CLI reports one;
- resumes the same logical call before the opponent moves;
- retains the exact call cursor during the Resume-to-provider-launch window. Legacy v1 battles additionally retain their staged work/verdict/recovery cursor.
- pins the selected models, effort ceilings, toolbelt profiles, quality routing, provider-neutral work guard, exact usage checkpoint, stage receipt, continuation count, and durable evidence so later Settings changes cannot silently alter the preserved battle.

After restarting Duo Chaos, active or half-written runs are reconstructed as paused battles. The newest valid manifest or journal record wins; a truncated final journal line is ignored. A run/workspace identity mismatch is rejected. An app-checkpoint mismatch becomes a visible workspace-drift pause and never auto-runs: after reviewing the preserved tree, the user can explicitly Resume to adopt it into a new checkpoint, invalidate stale verification, and reconcile the same logical turn.

Normal lean source calls do not resume provider history. They restart from the preserved Git revision plus a compact evidence baton, which reduces context growth and avoids fragile session replay. Legacy paused v1 battles may still carry a provider session identifier for staged compatibility. Provider-side history is controlled by the provider CLI, not Duo.

Crash recovery is intentionally conservative. Duo can reconstruct its local cursor and evidence, but it cannot guarantee exactly-once billing or exactly-once remote execution if the operating system dies after a provider completed work but before the final response reached the app.

## Failure policy

| Boundary | Default result | What happens next |
| --- | --- | --- |
| Provider quota or usage limit | Pause whole duel | No fresh retry and no solo takeover. Resume after usage returns. |
| Authentication required | Pause | Sign in with that CLI, then resume the same turn. |
| Selected model unavailable | Pause | Choose an advertised model/effort, apply it, then resume. |
| Provider unavailable, lost session, or host interruption | Pause | Existing evidence and cursor remain; resume when available. |
| Object/array/mixed stream compatibility | Local replay first | Duo decodes the bounded local spool before considering another model call. |
| Missing or invalid collaboration contract | One narrow tool-free recovery | Dialogue repair uses the capsule schema and supervisor persistence; expensive implementation is not repeated. Legacy staged handoff recovery remains available only to restored v1 battles. If recovery remains invalid, pause. |
| Planned dialogue or wall-clock source deadline | Timebox | Preserve durable work and advance only according to the balanced call contract. |
| Provider-neutral work guard | Durable handoff | Let productive editing, testing, and capability work finish; bound only genuine no-progress loops. Preserve durable work and allow one explicit fresh compact continuation on Resume. |
| Missing quality evidence | Quality repair pause | Preserve the artifact and append one balanced repair/re-review pair. Resume that pair, or explicitly reveal the result as partial; never manufacture readiness. |
| Supervisor verification failure | Bounded repair | Agent claims are advisory. A result cannot become ready until the independent supervisor passes the exact latest revision. |
| Workspace drift | Explicit adoption pause | Never auto-run changed source. Preserve it, require Resume to adopt a new checkpoint, invalidate stale verification, and reconcile before advancing. |
| Safety violation | Terminal failure | Stop before following linked paths or allowing unsafe workspace changes. |
| Human **Stop** | Cancelled | Terminate process trees, preserve files, and return the prompt for revision. This is not a resumable pause. |

Unknown failures do not become generic terminal failures. They pause with local diagnostics so a user can inspect the preserved battle instead of losing the run.

## Token-saving behavior

Token reduction must not silently reduce the artifact quality gate.

- Product dialogue is schema-constrained, tool-free, and receives bounded board/opponent context rather than raw transcripts.
- Normal Real Mode uses seven provider calls: four tool-free debate calls, two fresh deep source contributions, and one compact reciprocal review. Repair pairs are evidence-triggered.
- Source contributions receive a compact focus baton with the mission, board, teammate handoff, current verification, and bounded app inventory instead of resumed transcript history.
- Core source work uses only supervised workspace tools and no user capabilities. Smart uses the compact app-owned skill plus configured plugins, apps, and MCPs while suppressing the global user-skill catalog. Broad restores that catalog and is the high-context/high-quota option. Neither profile loads generated-workspace project/local settings, hooks, or hidden subagents.
- Balanced quality routing applies the same semantic target to both providers: lean routine dialogue and deterministic verification, strong source work, and the selected premium ceiling for bounded review. The force-selected override is available but intentionally spends more quota.
- Both providers share one soft work guard. Productive tools always finish; only a genuine idle loop is cancelled. Exact completed-call usage above 250,000 effective input tokens—uncached input plus 10% of cached input—or 24,000 output or reasoning tokens is checkpointed and surfaced as an advisory, then the battle continues from a fresh compact baton while the provider still accepts calls. Raw processed and cached totals remain visible in telemetry. These are observability boundaries over provider-reported fields, not estimates, quality claims, or artificial stop conditions.
- Revision-bound contribution receipts preserve material task evidence across handoffs in the supervisor-owned proof store. Review receipts bind each reviewer to the opponent's exact surviving contribution revision and recorded supervisor events, so agent-writable files cannot forge readiness and later edits invalidate stale proof.
- Quality repair is bounded twice: by the configured repair cap and by evidence progress. If a complete repair/re-review pair leaves the same release evidence missing, Duo stops additional paid calls and offers an honest partial reveal instead of retrying blindly.
- The local provider spool is decoded and replayed before a contract-recovery call.
- Narrow recovery fixes missing dialogue records without repeating implementation. It is structured, ephemeral, and tool-free, and the supervisor writes the protocol.
- Both agents still need a material accepted contribution, an owned completed task, exact-current reciprocal review, quality-brief coverage, current supervisor verification, and browser proof before `ready` is truthful.
- If the agents omit only the presentation packet after those objective gates pass, the supervisor reconstructs factual release metadata from the bounded workspace and recorded exchange rather than mislabeling the artifact as partial.

These controls reduce avoidable context and duplicate calls. They do not guarantee a token total; provider system prompts, cache accounting, project size, model behavior, and CLI versions remain outside Duo's control.

## Privacy and support reports

Prompts, sealed ideas, transcripts, raw streams, and provider-owned session data remain local. Raw provider payload, private metadata, capability configuration, and credentials never cross the preload bridge, even in Full Chaos or after reveal. Do not attach the entire runtime or workspace to a public issue.

The main-process support-bundle foundation emits a bounded allowlist of diagnostic facts: run status, pause/failure code, stage cursor, CLI versions/capabilities supplied by the caller, numeric usage totals, public event-type counts, and relative file fingerprints. It excludes raw/private/transcript content, absolute user paths, environment tokens, emails, and hidden product terms. Unknown file names are pseudonymized and large files receive a clearly marked prefix hash.

The support-bundle generator currently has no renderer export button. Until one is added, public issue reports should prefer screenshots with Spoiler Shield plus the visible **Support code** from a suspended battle and non-private CLI versions. Never upload `userData/runs`, `.duo/private`, `.duo/sealed`, raw logs, or generated workspaces without reviewing every file.

## Recording checklist

- Run `npm run benchmark:receipts` and one full Simulation rehearsal after updating the app.
- Confirm the title bar says **Live run** only after both providers pass preflight.
- Use **Chaos + Spoiler Shield** for the intended on-camera experience.
- Verify the selected model and effort on both agent cards before pressing Start.
- Verify the toolbelt and effective effort shown on both agent cards. Use Core when external capabilities are not needed; review the local CLI's user configuration before recording with Smart or Broad.
- Keep raw process streams collapsed; they can contain paths or provider metadata.
- Hide desktop notifications and avoid showing Settings if the workspace path identifies the Windows account.
- Leave sufficient provider quota for both agents. A quota pause is safe, but a long reset is poor live pacing.
- If a battle pauses, keep the same workspace and use **Resume battle** after the displayed action is complete. Do not start a replacement run merely to clear the screen.
- Wait for **The build survived** or **Delivery gate passed**. A partial reveal is useful evidence, not a successful readiness result.
- Inspect generated package scripts before installing or launching the artifact outside the isolated preview.

## Known limits

- Application workspace scoping is not VM/container isolation.
- Upstream CLI output, model aliases, effort flags, usage fields, and session-resume behavior may change.
- Capability snapshots prove only what the local health/catalog probes can observe.
- Smart/Broad capabilities may access user-authorized services beyond the generated workspace; Duo cannot inspect or reduce those external permissions. Broad additionally loads the full user-skill catalog and may consume substantially more context and quota.
- Paused runs require a manual Resume action; Duo does not wait in the background for quota reset.
- Provider-owned session history may remain after a local Duo run is deleted.
- Active-time recovery is local and durable, but remote calls cannot be made exactly-once across power loss.
- Installers are not code-signed.
- Receipt benchmarks compare recorded evidence and efficiency; they are not a substitute for blind human quality evaluation.

See [SAFETY.md](SAFETY.md), [TESTING.md](TESTING.md), and [BENCHMARKING.md](BENCHMARKING.md).
