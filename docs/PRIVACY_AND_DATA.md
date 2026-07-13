# Privacy and local data

Duo Chaos has no Duo-owned analytics service, direct model API integration, or cloud account. The desktop app launches the Codex and Claude Code CLIs already installed and authenticated on the machine. Those CLIs keep their own provider-side account, usage, and history behavior.

## Local data

Generated projects are stored below the workspace root chosen on the launch screen. Supervisor state is stored in Electron's application-data directory:

- Windows: `%APPDATA%/duo-chaos`
- macOS: `~/Library/Application Support/duo-chaos`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/duo-chaos`

Supervisor state can include prompts, public timelines, sealed run state, provider usage totals, and—only when explicitly enabled—sensitive raw provider output. Raw logs are disabled by default.

## Delete a run

Close Duo Chaos, then delete both the generated workspace folder and the matching run folder under the application-data directory. Remove `settings.json` in the application-data directory to reset local configuration. Review paths before deletion; Duo never deletes generated work automatically.

Deleting Duo data does not delete Codex or Claude Code provider history. Use each CLI's own history and account controls for that data.

Before publishing a support report, never upload generated workspaces, `.duo/private`, `.duo/sealed`, raw logs, or the application-data `runs` directory without inspecting every file.
