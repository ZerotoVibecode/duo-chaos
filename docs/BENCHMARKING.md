# Benchmarking

Duo Chaos has two deterministic offline benchmark commands and one separately gated live harness. Every command is a dry run or makes zero provider calls unless the live harness receives both explicit quota flags.

## Saved run receipts

The local benchmark command compares already-saved, privacy-safe run receipts. It never starts Codex, Claude Code, an API client, or a generated app.

```bash
# Deterministic synthetic smoke report; zero provider calls
npm run benchmark:receipts

# Machine-readable synthetic report
npm run benchmark:receipts -- --json

# Compare one or more saved receipts
npm run benchmark:receipts -- --json path/to/duo-receipt.json path/to/baseline-receipt.json
```

With no receipt paths, the command uses two transparent synthetic fixtures. Synthetic results validate the report pipeline only and do not claim that one model or orchestration strategy is better.

## Opt-in live exact-condition harness

The live harness records one predeclared condition: Duo Chaos in Serious + Chaos + Spoiler Shield with Codex Terra Low and Claude Sonnet Low. Its public brief, limits, loadout, and judge gates live in `tests/fixtures/benchmarks/live/terra-low-sonnet-low.json`. Command-line model, prompt, fixture, and limit overrides are rejected so results stay comparable.

```bash
# Inspect the exact condition; zero provider calls
npm run benchmark:live
npm run benchmark:live -- --json

# After npm run build, explicitly authorize the one live condition
npm run benchmark:live -- --live --i-understand-this-uses-local-cli-quota
```

Both `--live` and `--i-understand-this-uses-local-cli-quota` are required. Supplying only one exits before Electron starts. Live mode drives the installed, authenticated local CLIs through an isolated Electron user-data directory and a fresh temporary workspace; even Electron's startup default workspace is redirected there. Development-renderer and Node-injection environment variables are removed before launch. It does not call a direct API, and `saveRawLogs` is forced off.

The harness starts the condition once. It never resumes a paused battle or launches another attempt. Repair loops are set to zero for this sample. An external watchdog is independent of the in-app run ceiling and stops a harness that no longer reaches a terminal snapshot. Graceful Electron shutdown is bounded; its full process tree is terminated if needed so provider children cannot outlive the sample. Every terminal or harness-failure result is written to the receipt instead of being dropped, and its generated workspace is copied beside the receipt before temporary directories are removed. Shutdown or evidence-copy failure downgrades any provisional pass receipt. If evidence copying fails, the temporary source paths are recorded and deliberately retained. This preserves successful artifacts for blinded human review and incomplete artifacts for local diagnosis.

Live outputs stay under ignored `benchmark-results/live-duo/<run-id>/`. This is deliberately separate from Playwright's `test-results/` directory, which is cleared by E2E runs:

- `receipt.json` contains only bounded status, release gates, supervisor-recorded contributions, verification counts, tasks, usage, and the fixed public condition label;
- `preserved-workspace/` contains the generated source for every terminal outcome and may include the fixed benchmark brief, so it must remain ignored and local. Review this folder blindly before using the receipt to make a product-quality claim.
- `supervisor-runtime/` contains ignored local proof/checkpoint records when they exist. The preserved source deliberately omits its dangling external `.git` pointer; use the runtime copy only for local diagnosis, never as a public fixture.

The deterministic judge is intentionally narrow. It reads only the projected supervisor snapshot and requires a ready release, current verification, all tasks complete, and accepted implementation plus reciprocal review evidence from both agents with a bounded edit ratio. It does not load fixture JavaScript, run fixture shell commands, start the generated app, or pretend to replace blinded human product review. A passing receipt is execution evidence for one condition, not proof that Duo is universally better than either CLI alone.

## Quality-per-token architecture contract

```bash
npm run benchmark:quality

# Write reports to another ignored directory below test-results/
npm run benchmark:quality -- --output-dir test-results/my-quality-check
```

This command validates the bounded-baton comparison pipeline against a strict, privacy-safe fixture. It writes `report.json` and `report.md` below the ignored `test-results/` directory and compares:

- ready artifact, quality-brief coverage, browser proof, and current-verification gates;
- materially balanced implementation plus exact-current reciprocal review evidence;
- a fixture-owned hidden-judge result;
- processed input, output, peak context, tool-output bytes, calls, recovery calls, and active time.

The fixture records an explicit local-Codex command selection for each logical variant, but the benchmark does not execute those commands. The parser rejects Claude commands, direct/remote API transports, and Sol Ultra selections. A `candidate-preferred` result means only that the supplied deterministic fixture keeps every quality gate while reducing the tracked context/usage fields. It does not prove future provider quality or token savings.

## Release smoke evidence (2026-07-13)

A separate, manually supervised local smoke used Codex Terra at Low only; Claude and Sol Ultra were not invoked. The bounded Smart source turn repaired exactly two permitted fixture files, printed `LOCAL_VERIFY_PASS`, and ended `SOURCE_SMOKE_READY` in 36.8 seconds. Provider receipts reported 65,118 processed input tokens (46,848 cached) and 566 output tokens. The same fixture before Smart suppressed the machine's large global skill catalog reported 118,488 processed input tokens, so this observed smoke reduced processed input by about 45%. A capability-locked independent reviewer then printed `REVIEW_SMOKE_PASS` in 12.6 seconds, reported 29,552 processed input tokens and 183 output tokens, and changed zero protected files.

These are one-machine release-smoke observations, not a promise about future models or Claude quota. Raw provider JSONL stays under ignored `test-results/`; only bounded counts and pass/fail outcomes belong in public documentation. Deterministic command-contract, provider-neutral work-guard, receipt, and browser-proof tests are the release evidence for Claude because the owner explicitly prohibited consuming Claude quota during this pass.

## Receipt contract

Receipts are bounded regular JSON files. Symlinks and files larger than 256 KB are rejected. Unknown fields—including prompts, paths, and private text—are ignored and never copied into the report.

```json
{
  "schemaVersion": 1,
  "label": "Recorded balanced duel",
  "source": "saved-run",
  "status": "complete",
  "releaseStatus": "ready",
  "elapsedActiveMs": 900000,
  "verification": {
    "passes": 2,
    "failures": 0,
    "current": true
  },
  "contributions": {
    "claude": {
      "acceptedImplementation": true,
      "acceptedCrossReview": true,
      "completedTasks": 1,
      "edits": 2,
      "messages": 5
    },
    "codex": {
      "acceptedImplementation": true,
      "acceptedCrossReview": true,
      "completedTasks": 1,
      "edits": 3,
      "messages": 4
    }
  },
  "usage": {
    "claude": {
      "processedInputTokens": 100,
      "cachedInputTokens": 60,
      "outputTokens": 20,
      "reasoningTokens": 0,
      "calls": 2
    },
    "codex": {
      "processedInputTokens": 80,
      "cachedInputTokens": 40,
      "outputTokens": 15,
      "reasoningTokens": 4,
      "calls": 2
    }
  }
}
```

## Report semantics

The command reports facts rather than a single gameable score:

- **Duo ready** requires a complete/reveal-ready run, a `ready` release packet, current verification, at least one pass, zero current failures, and balanced contributions.
- **Balanced contributions** requires both agents to have accepted implementation, accepted cross-review, at least one completed task, at least one edit, and no worse than a 4:1 edit-count ratio.
- **Verification** reports current passes and failures without treating an agent-authored claim as proof.
- **Usage** sums provider-reported processed input, cache-read input, output, reasoning output, and call counts. It does not invent prices.
- **Active time** excludes paused/offline wall time when the saved receipt was produced by the durable supervisor.

Use the receipt report to compare orchestration efficiency and evidence quality. To test the product claim that a Duo result is better than either agent alone, use the same blinded brief, fixed model/effort loadouts, comparable time/usage ceilings, multiple seeds, and independent human ratings for usefulness, correctness, polish, novelty, and maintainability. One impressive run is a demo, not a benchmark.

## Recommended comparison set

For a meaningful local evaluation, collect at least:

1. Duo Chaos balanced run;
2. Codex-only baseline;
3. Claude-only baseline;
4. repeated runs with the same brief and equivalent ceilings.

Keep the generated artifacts sealed until the evaluator records a score. Report failures and partial results rather than rerunning only the weak conditions; otherwise the comparison is survivor-biased.
