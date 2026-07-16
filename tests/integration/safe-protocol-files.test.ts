import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  safeAppendProtocolText,
  safeReadProtocolText,
  safeWriteProtocolText
} from '../../src/main/workspace/safe-protocol-files'

describe('safe generated-workspace protocol files', () => {
  it('preserves every record when supervisor events append concurrently', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'duo-safe-protocol-concurrent-'))
    const duoPath = join(workspace, '.duo')
    const publicPath = join(duoPath, 'public')
    const timelinePath = join(publicPath, 'timeline.jsonl')
    await mkdir(publicPath, { recursive: true })
    await writeFile(timelinePath, '', 'utf8')

    const expectedIds = Array.from({ length: 96 }, (_, index) => `event-${String(index).padStart(3, '0')}`)
    await Promise.all(expectedIds.map((id) =>
      safeAppendProtocolText(duoPath, timelinePath, `${JSON.stringify({ id })}\n`)
    ))

    const content = await safeReadProtocolText(duoPath, timelinePath)
    const actualIds = (content ?? '')
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { id: string }).id)
      .sort()
    expect(actualIds).toEqual(expectedIds)
  })

  it('serializes concurrent supervisor replacements without partial files or rename races', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'duo-safe-protocol-replace-'))
    const duoPath = join(workspace, '.duo')
    const privatePath = join(duoPath, 'private')
    const statePath = join(privatePath, 'state.json')
    await mkdir(privatePath, { recursive: true })

    const versions = Array.from({ length: 96 }, (_, index) => `${JSON.stringify({ version: index })}\n`)
    await Promise.all(versions.map((content) => safeWriteProtocolText(duoPath, statePath, content)))

    const content = await safeReadProtocolText(duoPath, statePath)
    expect(versions).toContain(content)
    expect(() => { void JSON.parse(content ?? '') }).not.toThrow()
  })

  it('does not read or overwrite a host directory through a planted protocol junction', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'duo-safe-protocol-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'duo-safe-protocol-outside-'))
    const duoPath = join(workspace, '.duo')
    const privatePath = join(duoPath, 'private')
    const outsideFile = join(outside, 'dispatches.jsonl')
    await mkdir(privatePath, { recursive: true })
    await writeFile(outsideFile, 'HOST_SECRET_DO_NOT_READ_OR_REPLACE\n', 'utf8')
    await rm(privatePath, { recursive: true, force: true })
    await symlink(outside, privatePath, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(safeReadProtocolText(duoPath, join(privatePath, 'dispatches.jsonl'))).rejects.toThrow(/unsafe protocol path/i)
    await expect(safeAppendProtocolText(duoPath, join(privatePath, 'dispatches.jsonl'), '{"safe":true}\n')).rejects.toThrow(/unsafe protocol path/i)
    await expect(safeWriteProtocolText(duoPath, join(privatePath, 'redactions.json'), '{"terms":[]}\n')).rejects.toThrow(/unsafe protocol path/i)
    await expect(safeReadProtocolText(outside, outsideFile)).resolves.toContain('HOST_SECRET_DO_NOT_READ_OR_REPLACE')
  })
})
