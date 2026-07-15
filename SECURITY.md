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
- Smart and Broad toolbelt profiles can invoke user-authorized capabilities. Smart keeps the global user-skill catalog suppressed while retaining Duo's app-owned skill and configured plugins, apps, and MCP connections. Broad restores the full user-skill catalog and is deliberately high-context/high-quota. Any connected capability may reach services or data beyond the generated workspace according to the user's existing CLI configuration.
- Generated-workspace project and local settings are not loaded by Smart or Broad. Duo requests that user/plugin hooks stay disabled and blocks hidden subagent or fanout tools in every toolbelt profile. Organization-managed CLI policy is authoritative and may enforce managed hooks that the app cannot override.
- Safe Mode is Core-only and keeps Claude source turns shell-free. Smart/Broad require an autonomous Chaos workspace or an explicitly confirmed disposable YOLO Sandbox; their configured MCP namespace is preapproved only after the explicit local-capability trust confirmation because an unattended CLI cannot display an approval prompt.
- Chaos preapproves a bounded build toolbelt for Claude (`node --check`, `node --test`, and npm install/run/test shapes), not arbitrary inline Node, `npx`, or alternate package-manager commands. npm package scripts still execute generated code and must be treated as untrusted.
- The child environment deliberately excludes arbitrary credential variables. User capabilities should authenticate through supported CLI user configuration or keychain mechanisms; secret values are never copied into run state or IPC.
- YOLO mode is only for an externally isolated disposable environment.
- Generated dependency installation may execute third-party lifecycle scripts.
- Spoiler Shield is best-effort secrecy, not a cryptographic boundary.

See [docs/SAFETY.md](docs/SAFETY.md) for implementation details.
