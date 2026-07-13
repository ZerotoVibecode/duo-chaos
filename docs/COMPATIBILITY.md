# Compatibility

## Supported development path

| Component | Supported baseline |
| --- | --- |
| Windows | Windows 11, primary tested desktop platform |
| macOS / Linux | Source development supported; packaged releases require platform-specific validation |
| Node.js | 22.12 or newer |
| npm | 11 or a compatible recent release |
| Git | Current maintained release |
| Codex CLI | A locally authenticated version advertising non-interactive execution and JSON events |
| Claude Code | A locally authenticated version advertising print mode, structured output, effort selection, and tool restrictions |

Duo probes each local CLI before a Real Mode run. Verified missing or unsupported capabilities block the run; unverified catalogs remain warnings because account-specific model aliases can differ.

Simulation Mode needs no model CLI and is the compatibility test to run first.

## Packaged builds

The current project can assemble an unsigned Windows installer. Until a release is code-signed, operating systems may show an unknown-publisher warning. Verify checksums and release provenance before launching a downloaded binary. Source builds remain available through `npm install` and `npm run dev`.
