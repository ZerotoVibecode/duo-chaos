# Offline benchmarking

Duo Chaos has two deterministic benchmark commands. Both make zero provider calls and are safe to run when Claude quota must not be consumed.

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

Live mode is intentionally unsupported. `--live` exits without invoking a provider. Future live benchmarking must be a separate, explicit opt-in path and must still drive authenticated local CLIs rather than direct APIs.

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
