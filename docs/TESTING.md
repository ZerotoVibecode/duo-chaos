# Testing

The repository uses Vitest, Testing Library, and Playwright's Electron driver.

```bash
npm test
npm run test:coverage
npm run test:e2e
```

Coverage thresholds are 80% for statements, branches, functions, and lines.

The Electron suite verifies:

- full Simulation Mode through reveal;
- cancelled-run recovery back to an editable prompt;
- a continuously changing broadcast with agent, director, and evidence provenance, both agent voices, at least four scene types, and no silent gap longer than six seconds;
- no horizontal/page overflow in a 1000×700 window;
- launch and run dashboards fill a 2048×1152 display;
- long and unbroken criticism text remains inside its natural-height card without line clamping or hidden overflow;
- factual, deduplicated Live Pulse activity remains visible while a provider is working;
- the active effort, selected quality ceiling, toolbelt profile, and Claude inference-message lease remain truthful in the run UI.

Real Mode regression coverage retains fixtures from the original completed 12-turn Codex/Claude audit, then verifies the current seven-call contract: stdin prompt delivery, schema-constrained tool-free dialogue, local normalization before contract retry, sealed consensus persistence, fresh compact source calls, supervisor-built context batons, whole-duel quota suspension, durable pause/resume, crash reconstruction, pinned model/effort/toolbelt/routing/lease state, persisted work receipts, legacy staged-run migration, bounded recovery, Git evidence, evidence-triggered repair pairs, independent supervisor verification, exact-revision invalidation, graceful wall-clock and inference-message timeboxing, one compact no-edit continuation, supervisor runtime isolation, deterministic protocol ingestion, stable deduplication, strict alternation, spoiler-safe task projection, sourced broadcast beats, truthful completion, and non-empty reveal drama. Command-builder tests prove that Core disables user capabilities, Smart retains the app-owned skill plus configured plugins/apps/MCPs while suppressing the global user-skill catalog, Broad restores that catalog, and dialogue/recovery remain isolated. Provider-envelope regressions include JSONL objects, top-level arrays, nested batches, pretty-printed spools, usage/session extraction, and quota signals. The Broadcast Director contract rejects invented verdicts, winners, concessions, confidence, and source IDs.

`npm run benchmark:receipts` is a deterministic offline evidence-report test. It makes no provider calls. The default synthetic pair verifies report plumbing; saved receipt comparisons remain explicit local inputs.

`npm run benchmark:quality` is a separate deterministic architecture-contract benchmark. It makes zero provider calls, forbids Claude/direct-API/Sol-Ultra command selections in its fixture, checks quality gates before efficiency deltas, and writes only sanitized reports below the ignored `test-results/` directory. Its synthetic verdict validates comparison plumbing, not future model quality or token savings.

Reveal regressions reproduce the real `Seed Garden` handoff: an alternate ready packet must recover the product title, completed work, checks, quotes, caveats, and `app/index.html` target. Legacy generic fallbacks are migrated from workspace evidence, status-only readiness is rejected, planned spec bullets cannot replace completed work, and launch-target tests reject traversal, external absolute paths, and executable files while preferring built package output.

External paid CLIs are deterministic fakes in automated tests. Live CLI smoke tests are opt-in and never run in CI. An earlier July 2026 token-efficiency smoke used one local Sol Medium dialogue call: 32.3 seconds, zero tool calls, 10,937 processed input tokens, 963 output tokens, and 321 reasoning tokens. The newer bounded Smart source/reviewer smoke is recorded in [BENCHMARKING.md](BENCHMARKING.md). Both validate command/schema/privacy paths, not statistical quality or future provider pricing.

The Windows CI job runs `npm run pack` after the cross-platform verification job. It proves that Electron Builder can assemble the unpacked Windows application from a clean checkout; it does not launch that packaged binary or certify an installer. Release owners must still open the packaged app and rehearse Simulation Mode on the target Windows machine.
