import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildContextBaton } from '../../src/main/orchestrator/context-baton'

describe('deterministic context baton', () => {
  it('focuses the next agent without leaking host paths, raw logs, or secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duo-baton-'))
    await mkdir(join(root, 'app', 'src'), { recursive: true })
    await mkdir(join(root, '.duo', 'private'), { recursive: true })
    await writeFile(join(root, 'app', 'src', 'main.ts'), 'export const ready = true\n')
    await writeFile(join(root, '.duo', 'private', 'raw.log'), 'BEARER super-secret\n')

    const baton = await buildContextBaton({
      workspacePath: root,
      agent: 'claude',
      mission: 'Implement the accessible interaction.',
      tasks: [{ id: 'task-1', title: 'Accessible interaction', status: 'claimed', claimedBy: 'claude', files: ['app/src/main.ts'] }],
      verificationDigest: 'npm test failed: expected keyboard activation',
      hardConstraints: ['Must remain local-only', 'Must support keyboard activation'],
      acceptanceChecks: ['Primary interaction works by keyboard', 'Compact viewport remains readable'],
      decisionDelta: ['Keep the existing state machine; replace only the input layer.'],
      opponentPosition: 'Codex requests proof that focus is restored after activation.',
      contributionReceipt: 'Previous slice changed 2 files; verification failed on keyboard activation.',
      maxCharacters: 2_000
    })

    expect(baton).toContain('app/src/main.ts')
    expect(baton).toContain('expected keyboard activation')
    expect(baton).toContain('Must remain local-only')
    expect(baton).toContain('Keep the existing state machine')
    expect(baton).toContain('Codex requests proof')
    expect(baton).toContain('Previous slice changed 2 files')
    expect(baton).not.toContain(root)
    expect(baton).not.toContain('super-secret')
    expect(baton.length).toBeLessThanOrEqual(2_000)
  })
})
