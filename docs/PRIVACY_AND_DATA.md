# Privacy and local data

Duo Chaos has no Duo-owned analytics service, direct model API integration, or cloud account. The desktop app launches the Codex and Claude Code CLIs already installed and authenticated on the machine. Those CLIs keep their own provider-side account, usage, history, skills, plugins, apps, and MCP behavior.

Smart and Broad toolbelts can use capabilities already configured at the local CLI's user scope. Smart suppresses the global user-skill catalog while retaining Duo's app-owned skill and configured plugins, apps, and MCP connections; Broad restores the full user-skill catalog and therefore carries a higher context/quota cost. Duo does not enumerate or copy capability names, server configuration, or credentials into its settings, run manifests, support summaries, or renderer. A capability may send task context to a service the user previously authorized; that data flow is controlled by the CLI and capability, not by Duo. Generated-workspace project/local settings and hidden subagents remain excluded from supervised runs. Duo requests that user/plugin hooks stay disabled; organization-managed CLI policy may still enforce managed hooks.

## Local data

Generated projects are stored below the workspace root chosen on the launch screen. Supervisor state is stored in Electron's application-data directory:

- Windows: `%APPDATA%/duo-chaos`
- macOS: `~/Library/Application Support/duo-chaos`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/duo-chaos`

Supervisor state can include prompts, public timelines, sealed run state, provider usage totals, and—only when explicitly enabled—sensitive raw provider output. Raw logs are disabled by default. Raw provider payload, private metadata, capability configuration, and credentials never cross the preload bridge, including in Full Chaos and after reveal; the renderer receives projected public records and explicit reveal-safe data only.

## Delete a run

Close Duo Chaos, then delete both the generated workspace folder and the matching run folder under the application-data directory. Remove `settings.json` in the application-data directory to reset local configuration. Review paths before deletion; Duo never deletes generated work automatically.

Deleting Duo data does not delete Codex or Claude Code provider history or records retained by a user-configured plugin, app, or MCP service. Use each CLI's and external service's own history and account controls for that data.

Before publishing a support report, never upload generated workspaces, `.duo/private`, `.duo/sealed`, raw logs, or the application-data `runs` directory without inspecting every file.
