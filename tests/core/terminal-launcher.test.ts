import { describe, expect, it, vi } from 'vitest'
import {
  buildTerminalLaunchCandidates,
  launchInteractiveCli,
  type TerminalStarter
} from '../../src/main/process/terminal-launcher'

describe('interactive CLI terminal launcher', () => {
  it('runs Windows CLI shims through PowerShell inside Windows Terminal', () => {
    const candidates = buildTerminalLaunchCandidates({
      binary: "C:\\Tools\\Claude's CLI\\claude.exe",
      cwd: "C:\\Work\\Owner's run",
      platform: 'win32'
    })
    expect(candidates[0]?.program).toBe('wt.exe')
    expect(candidates[0]?.args).toContain('-EncodedCommand')
    const encoded = candidates[0]?.args.at(-1) ?? ''
    expect(encoded).not.toContain(';')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      "Set-Location -LiteralPath 'C:\\Work\\Owner''s run'; & 'C:\\Tools\\Claude''s CLI\\claude.exe'"
    )
    expect(candidates[1]?.program).toBe('powershell.exe')
    expect(candidates[1]?.args.at(-1)).toContain("Owner''s run")
    expect(candidates[1]?.args.at(-1)).toContain("Claude''s CLI")
  })

  it('resolves npm-installed CLI aliases through PowerShell instead of handing them to Windows Terminal', () => {
    const [candidate] = buildTerminalLaunchCandidates({
      binary: 'claude',
      cwd: 'C:\\runs',
      platform: 'win32'
    })

    expect(candidate?.program).toBe('wt.exe')
    expect(candidate?.args).toContain('powershell.exe')
    expect(candidate?.args).toContain('-EncodedCommand')
    expect(Buffer.from(candidate?.args.at(-1) ?? '', 'base64').toString('utf16le'))
      .toBe("Set-Location -LiteralPath 'C:\\runs'; & 'claude'")
  })

  it('builds native macOS and Linux candidates', () => {
    expect(buildTerminalLaunchCandidates({ binary: 'codex', cwd: '/tmp/duo', platform: 'darwin' })[0]?.program)
      .toBe('osascript')
    expect(buildTerminalLaunchCandidates({ binary: 'claude', cwd: '/tmp/duo', platform: 'linux' }).map((item) => item.program))
      .toEqual(['x-terminal-emulator', 'gnome-terminal'])
  })

  it('falls back to the next terminal candidate when the first is missing', async () => {
    const start: TerminalStarter = vi.fn()
      .mockRejectedValueOnce(new Error('wt missing'))
      .mockResolvedValueOnce(undefined)
    await launchInteractiveCli({ binary: 'codex', cwd: 'C:\\runs', platform: 'win32' }, start)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty executable before launching a terminal', async () => {
    await expect(launchInteractiveCli({ binary: ' ', cwd: '/tmp', platform: 'linux' }, vi.fn()))
      .rejects.toThrow(/empty/i)
  })
})
