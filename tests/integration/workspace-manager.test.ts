import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRunWorkspace } from '../../src/main/workspace/workspace-manager'

describe('workspace manager', () => {
  it('creates the canonical public/private/sealed file protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-workspace-test-'))
    const result = await createRunWorkspace({
      root,
      runId: 'duo-run-test',
      prompt: 'Build something surprising.',
      executionMode: 'simulation',
      visibilityMode: 'spoiler-shield'
    })

    expect(result.workspacePath).toBe(join(root, 'duo-run-test'))
    await expect(readFile(join(result.workspacePath, '.duo', 'run.json'), 'utf8')).resolves.toContain(
      'duo-run-test'
    )
    await expect(
      readFile(join(result.workspacePath, '.duo', 'public', 'timeline.jsonl'), 'utf8')
    ).resolves.toBe('')
    await expect(
      readFile(join(result.workspacePath, '.duo', 'public', 'dispatches.jsonl'), 'utf8')
    ).resolves.toBe('')
    await expect(
      readFile(join(result.workspacePath, '.duo', 'private', 'dispatches.jsonl'), 'utf8')
    ).resolves.toBe('')
    await expect(
      readFile(join(result.workspacePath, '.duo', 'private', 'transcript.jsonl'), 'utf8')
    ).resolves.toBe('')
    await expect(readFile(join(result.workspacePath, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'equal AI coding agents'
    )
    await expect(readFile(join(result.workspacePath, 'CLAUDE.md'), 'utf8')).resolves.toContain(
      '@AGENTS.md'
    )
    const gitignore = await readFile(join(result.workspacePath, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.duo/')
  })

  it('rejects path-like run identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-workspace-test-'))
    await expect(
      createRunWorkspace({
        root,
        runId: '../escape',
        prompt: 'Nope',
        executionMode: 'simulation',
        visibilityMode: 'blind'
      })
    ).rejects.toThrow(/run identifier/i)
  })

  it('creates a supervisor-owned binding brief for serious missions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-workspace-serious-'))
    const prompt = 'Build an accessible local reporting tool with CSV export.'
    const result = await createRunWorkspace({
      root,
      runId: 'duo-run-serious',
      prompt,
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      missionProfile: 'serious'
    })

    await expect(readFile(join(result.workspacePath, '.duo', 'sealed', 'human_brief.md'), 'utf8')).resolves.toContain(prompt)
    await expect(readFile(join(result.workspacePath, '.duo', 'sealed', 'serious_contract.json'), 'utf8')).resolves.toContain('briefFingerprint')
  })
})
