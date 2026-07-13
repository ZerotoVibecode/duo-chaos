# Security policy

Duo Chaos launches autonomous local coding CLIs and generated build commands. That is inherently high-risk software.

## Supported version

Security fixes target the latest release on `main`.

## Reporting

Do not open a public issue for a vulnerability that could expose credentials, private transcripts, files outside a run workspace, or command execution on a user's host. Use GitHub private vulnerability reporting when it is enabled for the repository.

Include affected version, platform, execution/visibility mode, reproduction steps, impact, and a minimal proof of concept. Remove prompts, local paths, tokens, and raw transcripts.

## Boundaries

- Simulation Mode does not launch AI CLIs.
- Safe and Chaos modes are workspace-scoped at the application level, not host-isolated.
- YOLO mode is only for an externally isolated disposable environment.
- Generated dependency installation may execute third-party lifecycle scripts.
- Spoiler Shield is best-effort secrecy, not a cryptographic boundary.

See [docs/SAFETY.md](docs/SAFETY.md) for implementation details.
