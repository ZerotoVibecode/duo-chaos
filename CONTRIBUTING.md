# Contributing to Duo Chaos

Thanks for helping improve Duo Chaos.

## Setup

```bash
npm ci
npm run dev
```

Simulation Mode must remain usable without Codex or Claude installed.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run test:e2e
```

Add or update tests before changing behavior. Keep global statements, branches, functions, and lines at 80% coverage or better.

## Product boundaries

- Keep Codex and Claude equal: both may pitch, critique, code, review, and repair.
- Keep private data in Electron main; do not send raw/private fields to the renderer before reveal.
- Preserve process-tree cancellation, timeouts, argument-array spawning, and safe defaults.
- Do not add direct OpenAI or Anthropic API integrations to the core app.
- Treat the live criticism feed and Conflict Arena as product features, not debug output.

## Pull requests

Keep changes focused. Explain the user-visible result, safety impact, tests run, and any screenshots needed to review UI changes.
