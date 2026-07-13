# Safety model

## Defaults

- Simulation launches no AI CLIs.
- Safe and Chaos use workspace-write/conservative permission modes.
- YOLO bypass flags require explicit confirmation that the host is disposable.
- Dialogue, source work, bounded recovery, supervisor verification, and the whole run have explicit ceilings. POSIX processes receive a short SIGTERM grace period and then group SIGKILL; Windows uses `taskkill /T /F`.
- Child environments remove common secret, credential, auth, cookie, token, password, and runtime-injection variables.
- Executable health checks and local model-catalog probes use the same filtered environment and terminate the complete process tree on timeout or oversized output.
- Product dialogue and contract recovery always run with tools and customizations disabled. Core source work stays on supervised workspace tools with no user capabilities. Smart and Broad source/review work requires explicit confirmation before using authenticated user-level capabilities.
- Smart uses Duo's compact app-owned skill plus configured plugins, apps, and MCP connections while suppressing the global user-skill catalog. Broad also loads the full user-skill catalog and is explicitly high-context/high-quota. Neither profile loads generated-workspace project/local settings, hooks, or hidden subagents.
- Safe Mode is Core-only. Smart/Broad run in Chaos or an explicitly confirmed disposable YOLO Sandbox because an unattended provider process cannot ask the human to approve an MCP call.
- Child processes receive a sanitized environment. Arbitrary credential variables are not forwarded; connected capabilities must use their CLI-supported user configuration or keychain authentication.

## Limits

Workspace scoping is not host isolation. A CLI, dependency installer, or generated script may still interact with host resources available to the process. Run unrestricted modes only in a VM, container, or devcontainer.

User-authorized skills, plugins, apps, and MCP tools may intentionally reach services or files outside the generated workspace. Duo does not enumerate their names, inspect their credentials, or narrow the permissions already granted in the local CLI. Review that CLI's user configuration before enabling Smart or Broad, prefer Core where external tools are unnecessary, and use Broad only when the mission justifies its much larger skill context.

Spoiler Shield is a layered redaction system, not encryption. Record the curated UI and inspect exported logs before publishing video or screenshots.

Normal source-changing work uses fresh compact provider calls with no Duo-managed session persistence. Product dialogue is ephemeral, tool-free, and stored by the orchestrator. Legacy paused v1 battles may still resume a staged provider session. Provider CLIs can retain their own local history outside the generated workspace; use each CLI's history controls when that retention is not acceptable.

Supervisor telemetry is not stored in generated workspaces. Run state, prompts, timelines, transcripts, and raw streams are written beneath Electron's private `userData/runs` directory. Compact agent protocol and sealed product files remain in the generated workspace because the two agents need them to collaborate.

Raw provider payload, private metadata, capability configuration, and credentials never cross Electron IPC. Full Chaos can reveal unredacted projected collaboration text, and reveal can unlock explicit reveal-safe product data, but neither mode turns the renderer into a raw-log or MCP-configuration viewer.

## Generated code

Treat every generated app as untrusted. Review package scripts before installing dependencies and do not place credentials inside generated workspaces.

Artifact Premiere does not execute package scripts. It previews only an existing static or built HTML entrypoint in a disposable offscreen Chromium session with no Node integration, preload, permissions, external network, popups, downloads, navigation, or webviews. Resource requests are realpath-confined to the artifact root, and the Studio renderer receives pixels rather than generated markup. This lowers preview risk; it does not make launching or installing the generated app trusted.
