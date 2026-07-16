import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunWorkspace } from '../../src/main/workspace/workspace-manager'
import {
  extractRecoveryCapsuleFromCliLine,
  parseRecoveryCapsule,
  writeRecoveryCapsuleProtocol
} from '../../src/main/orchestrator/recovery-capsule'

const temporaryRoots: string[] = []

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'duo-recovery-capsule-'))
  temporaryRoots.push(root)
  return await createRunWorkspace({
    root,
    runId: 'duo-run-recovery-capsule',
    prompt: 'Exercise a bounded recovery contract.',
    executionMode: 'chaos',
    visibilityMode: 'spoiler-shield'
  })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function capsule() {
  return {
    dispatch: {
      publicText: 'I think [APP_NAME] needs the smaller [FEATURE] because that path is directly testable.',
      privateText: 'I think Nebula Pantry needs the smaller seven-click pantry duel because that path is directly testable.'
    },
    opinion: null,
    redactions: [
      { value: 'Nebula Pantry', label: 'APP_NAME' },
      { value: 'seven-click pantry duel', label: 'FEATURE' }
    ]
  }
}

describe('tool-free staged recovery capsule', () => {
  it('parses one strict capsule and rejects prose wrappers or extra fields', () => {
    expect(parseRecoveryCapsule(capsule())).toEqual(capsule())
    expect(() => parseRecoveryCapsule(`Here you go: ${JSON.stringify(capsule())}`)).toThrow(/single|json|capsule/iu)
    expect(() => parseRecoveryCapsule({ ...capsule(), files: ['app/index.html'] })).toThrow(/invalid|unrecognized/iu)
  })

  it('repairs provider mojibake before recovery text enters durable handoffs', () => {
    const parsed = parseRecoveryCapsule({
      dispatch: {
        publicText: 'Claude\u00e2\u20ac\u2122s reply \u00e2\u20ac\u201d ready\u00e2\u20ac\u00a6',
        privateText: 'We\u00e2\u0080\u0099re aligned \u00e2\u0080\u0094 continue.'
      },
      opinion: null,
      redactions: [{ value: 'Builder\u00e2\u20ac\u2122s Bench', label: 'APP_NAME' }]
    })

    expect(parsed.dispatch).toEqual({
      publicText: 'Claude’s reply — ready…',
      privateText: 'We’re aligned — continue.'
    })
    expect(parsed.redactions[0]?.value).toBe('Builder’s Bench')
  })

  it('extracts only final provider responses, never command output', () => {
    const value = capsule()
    const claude = JSON.stringify({ type: 'result', subtype: 'success', structured_output: value })
    const codex = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } })
    const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', output: JSON.stringify(value) } })

    expect(extractRecoveryCapsuleFromCliLine('claude', claude)).toEqual(value)
    expect(extractRecoveryCapsuleFromCliLine('codex', codex)).toEqual(value)
    expect(extractRecoveryCapsuleFromCliLine('codex', command)).toBeUndefined()
  })

  it('salvages one strict Claude wrapper from the first StructuredOutput attempt', () => {
    const value = capsule()
    const wrapped = JSON.stringify([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'StructuredOutput', input: { value: JSON.stringify(value) } }]
        }
      },
      { type: 'result', subtype: 'error_max_turns' }
    ])
    const extraKeys = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'StructuredOutput', input: { value, extra: true } }]
      }
    })

    expect(extractRecoveryCapsuleFromCliLine('claude', wrapped)).toEqual(value)
    expect(extractRecoveryCapsuleFromCliLine('claude', extraKeys)).toBeUndefined()
  })

  it('lets the supervisor write one idempotent spoiler-safe dispatch without touching app source', async () => {
    const run = await workspace()
    const appFile = join(run.appPath, 'index.html')
    await writeFile(appFile, '<!doctype html><title>Accepted app</title>', 'utf8')
    const input = {
      workspacePath: run.workspacePath,
      runId: 'duo-run-recovery-capsule',
      round: 6,
      agent: 'codex' as const,
      targetAgent: 'claude' as const,
      originStage: 'opening' as const,
      replyTo: 'dialogue-prior-claude',
      requireOpinion: false,
      capsule: capsule()
    }

    const first = await writeRecoveryCapsuleProtocol(input)
    const second = await writeRecoveryCapsuleProtocol(input)
    expect(second.dispatch.id).toBe(first.dispatch.id)

    const publicLines = (await readFile(join(run.duoPath, 'public', 'dispatches.jsonl'), 'utf8')).trim().split(/\r?\n/u)
    const privateLines = (await readFile(join(run.duoPath, 'private', 'dispatches.jsonl'), 'utf8')).trim().split(/\r?\n/u)
    expect(publicLines).toHaveLength(1)
    expect(privateLines).toHaveLength(1)
    const publicEvent = JSON.parse(publicLines[0]!) as Record<string, unknown>
    const privateEvent = JSON.parse(privateLines[0]!) as Record<string, unknown>
    expect(publicEvent).toMatchObject({
      id: first.dispatch.id,
      type: 'agent.dispatch',
      agent: 'codex',
      targetAgent: 'claude',
      round: 6,
      dispatchKind: 'opening',
      replyTo: 'dialogue-prior-claude'
    })
    expect(JSON.stringify(publicEvent)).not.toMatch(/Nebula Pantry|seven-click pantry duel/iu)
    expect(privateEvent.privateText).toContain('Nebula Pantry')
    expect(await readFile(appFile, 'utf8')).toContain('Accepted app')
  })

  it('never trusts masked model-authored public recovery text that still contains an unredacted hidden name', async () => {
    const run = await workspace()
    const unsafeCapsule = {
      ...capsule(),
      dispatch: {
        publicText: 'I think [FEATURE] should keep SecretName because the interaction is directly testable.',
        privateText: 'I think SecretName should keep the seven-click pantry duel because the interaction is directly testable.'
      },
      redactions: [
        { value: 'seven-click pantry duel', label: 'FEATURE' }
      ]
    }

    await writeRecoveryCapsuleProtocol({
      workspacePath: run.workspacePath,
      runId: 'duo-run-recovery-capsule',
      round: 9,
      agent: 'codex',
      targetAgent: 'claude',
      originStage: 'work',
      requireOpinion: false,
      capsule: unsafeCapsule
    })

    const publicLine = (await readFile(join(run.duoPath, 'public', 'dispatches.jsonl'), 'utf8')).trim()
    const privateLine = (await readFile(join(run.duoPath, 'private', 'dispatches.jsonl'), 'utf8')).trim()
    const publicEvent = JSON.parse(publicLine) as Record<string, unknown>
    const privateEvent = JSON.parse(privateLine) as Record<string, unknown>
    expect(publicEvent.publicText).toBe('Codex handed Claude a spoiler-sealed build position.')
    expect(JSON.stringify(publicEvent)).not.toContain('SecretName')
    expect(privateEvent.privateText).toContain('SecretName')
  })

  it('writes a required opinion once and rejects a missing one', async () => {
    const run = await workspace()
    const withOpinion = {
      ...capsule(),
      opinion: {
        publicText: 'The smaller [FEATURE] is stronger because it preserves the accepted build boundary.',
        privateText: 'The smaller seven-click pantry duel is stronger because it preserves the accepted build boundary.',
        tone: 'cautious' as const
      }
    }
    const input = {
      workspacePath: run.workspacePath,
      runId: 'duo-run-recovery-capsule',
      round: 7,
      agent: 'claude' as const,
      targetAgent: 'codex' as const,
      originStage: 'verdict' as const,
      requireOpinion: true,
      capsule: withOpinion
    }

    await writeRecoveryCapsuleProtocol(input)
    await writeRecoveryCapsuleProtocol(input)
    const opinions = (await readFile(join(run.duoPath, 'public', 'opinions.jsonl'), 'utf8')).trim().split(/\r?\n/u)
    expect(opinions).toHaveLength(1)
    await expect(writeRecoveryCapsuleProtocol({ ...input, round: 8, capsule: capsule() })).rejects.toThrow(/opinion/iu)
  })
})
