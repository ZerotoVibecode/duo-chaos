# AGENTS.md — Duo Chaos contributor instructions

Duo Chaos is an Electron + Vite + React + TypeScript desktop application by ZeroToVibecode.

If `.codex/PROJECT_CONTEXT.md` exists, read it for local owner context. It is intentionally ignored and is not part of the public repository.

## Product contract

- One human prompt starts a blind autonomous build.
- Local Codex and Claude Code CLIs are equal agents.
- Both agents may pitch, critique, code, review, and repair.
- Writes are turn-based in the single-workspace implementation.
- Live criticism and the Conflict Arena are flagship experiences.
- Spoiler Shield is the default visibility mode.
- Simulation Mode works without either AI CLI.
- Do not add direct OpenAI or Anthropic API integrations to the core app.

## Architecture boundaries

- `src/main/` owns processes, files, settings, Git, orchestration, and private data.
- `src/preload/` exposes a minimal typed bridge.
- `src/renderer/` never receives private text or reveal packets before reveal.
- `src/shared/types.ts` is the canonical TypeScript contract.
- `schemas/` mirrors public contracts.
- Runtime workspaces, raw logs, transcripts, secrets, and build artifacts stay ignored.

## Safety and quality

- Spawn with argument arrays and `shell: false`.
- Preserve sanitized child environments, cancellation, and timeouts.
- Dangerous flags require explicit disposable-environment confirmation.
- Write tests before production changes.
- Run typecheck, lint, coverage, build, and Electron E2E tests before shipping.
- Visually inspect compact and full-screen layouts after UI changes.
