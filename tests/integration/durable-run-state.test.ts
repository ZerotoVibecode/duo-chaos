import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DurableRunIdentityError,
  DurableRunStateStore,
  type DurableRunManifest
} from '@main/persistence/durable-run-state'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'duo-durable-state-'))
  temporaryRoots.push(root)
  return root
}

function manifest(overrides: Partial<DurableRunManifest> = {}): DurableRunManifest {
  return {
    schemaVersion: 1,
    planVersion: 'balanced-core-v1',
    revision: 1,
    runId: 'duo-run-fixture-a1b2',
    workspaceId: 'workspace-fixture-a1b2',
    status: 'running',
    updatedAt: '2026-07-11T12:00:00.000Z',
    request: {
      prompt: 'Build a compact local tool.',
      executionMode: 'chaos',
      visibilityMode: 'spoiler-shield',
      missionProfile: 'surprise',
      maxTurns: 10,
      maxRepairLoops: 1,
      turnTimeoutSeconds: 7_200,
      runTimeoutSeconds: 86_400
    },
    loadout: {
      claude: {
        executable: 'claude',
        requestedModel: 'fable',
        requestedEffort: 'max',
        resolvedModel: 'claude-fable-5',
        resolvedEffort: 'max'
      },
      codex: {
        executable: 'codex',
        requestedModel: 'gpt-sol',
        requestedEffort: 'max',
        resolvedModel: 'gpt-sol',
        resolvedEffort: 'max'
      }
    },
    capabilities: {
      claude: {
        adapterVersion: 'claude-cli-v1',
        cliVersion: '2.1.207',
        streamFormat: 'json-array',
        structuredOutput: true,
        sessionResume: true,
        discoveredAt: '2026-07-11T11:59:00.000Z'
      },
      codex: {
        adapterVersion: 'codex-cli-v1',
        cliVersion: '0.144.0',
        streamFormat: 'jsonl',
        structuredOutput: true,
        sessionResume: true,
        discoveredAt: '2026-07-11T11:59:00.000Z'
      }
    },
    cursor: {
      turnIndex: 4,
      stage: 'work',
      attempt: 1,
      idempotencyKey: 'turn-05-work-attempt-01',
      stageReceipt: {
        turnId: 'turn-05',
        agent: 'claude',
        kind: 'code',
        stage: 'work',
        status: 'paused',
        startedAt: '2026-07-11T11:45:00.000Z',
        deadlineAt: '2026-07-11T13:45:00.000Z',
        attempt: 1,
        effort: 'high',
        qualityCeiling: 'max',
        customizationProfile: 'smart',
        inferenceSteps: 8,
        inferenceLimit: 8,
        continuationCount: 1,
        nextAgent: 'codex',
        durableSourceChanged: true,
        durableWorkEvidence: true,
        evidenceFingerprint: 'tree:fixture\nstatus:'
      }
    },
    providerSessions: {
      claude: '11111111-1111-4111-8111-111111111111',
      codex: '22222222-2222-4222-8222-222222222222'
    },
    providerRuntimes: {
      claude: {
        model: 'claude-fable-5',
        effort: 'max',
        source: 'claude-system-init',
        recordedAt: '2026-07-11T12:00:30.000Z'
      },
      codex: {
        model: 'gpt-sol',
        effort: 'max',
        source: 'codex-thread-started',
        recordedAt: '2026-07-11T12:00:35.000Z'
      }
    },
    evidence: {
      acceptedCodeAgents: ['claude'],
      acceptedReviewAgents: [],
      completedTaskAgents: ['claude'],
      appRevision: 3,
      verifiedAppRevision: 2
    },
    git: {
      head: '0123456789abcdef0123456789abcdef01234567',
      appFingerprint: 'tree:fixture\nstatus:'
    },
    timing: {
      remainingLeaseMs: 6_900_000,
      accumulatedActiveMs: 300_000
    },
    usage: {
      claude: {
        processedInputTokens: 5_000,
        cachedInputTokens: 2_000,
        outputTokens: 900,
        reasoningTokens: 0,
        calls: 2,
        reportedCostUsd: 0.42
      },
      codex: {
        processedInputTokens: 4_000,
        cachedInputTokens: 1_000,
        outputTokens: 600,
        reasoningTokens: 200,
        calls: 1
      }
    },
    retries: [
      {
        idempotencyKey: 'turn-03-dialogue-attempt-01',
        attempts: 1,
        lastReason: 'contract-invalid',
        updatedAt: '2026-07-11T11:50:00.000Z'
      }
    ],
    eventCursor: {
      sequence: 37,
      lastEventId: 'event-0037'
    },
    ...overrides
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DurableRunStateStore', () => {
  test('atomically persists and validates the complete restart contract', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const expected = manifest()

    await store.persist(expected)

    await expect(store.readManifest()).resolves.toEqual(expected)
    await expect(store.readJournal()).resolves.toEqual([expected])
    const files = await readdir(root)
    expect(files).toContain('run-manifest.json')
    expect(files).toContain('run-journal.jsonl')
    expect(files.some((file) => file.includes('.tmp-'))).toBe(false)
    expect((await readFile(store.journalPath, 'utf8')).endsWith('\n')).toBe(true)
  })

  test('keeps an append-only snapshot journal across revisions', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const first = manifest()
    const paused = manifest({
      revision: 2,
      status: 'paused',
      updatedAt: '2026-07-11T12:05:00.000Z',
      timing: { remainingLeaseMs: 6_900_000, accumulatedActiveMs: 300_000 },
      pause: {
        reason: 'provider-quota',
        agent: 'claude',
        pausedAt: '2026-07-11T12:05:00.000Z',
        resetAt: '2026-07-11T15:00:00.000Z'
      }
    })

    await store.persist(first)
    const originalJournal = await readFile(store.journalPath, 'utf8')
    await store.persist(paused)

    const journal = await readFile(store.journalPath, 'utf8')
    expect(journal.startsWith(originalJournal)).toBe(true)
    await expect(store.readJournal()).resolves.toEqual([first, paused])
    await expect(store.readManifest()).resolves.toEqual(paused)
  })

  test('round-trips a spoiler-safe quality-repair cursor and its missing evidence categories', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const repair = manifest({
      status: 'paused',
      qualityRepair: {
        attempts: 2,
        missingEvidence: ['Independent verification', 'Codex reply-linked cross-review']
      },
      pause: {
        reason: 'other',
        pausedAt: '2026-07-11T12:05:00.000Z',
        resumable: false,
        detailCode: 'quality-repair'
      }
    })

    await store.persist(repair)

    await expect(store.reconstruct()).resolves.toMatchObject({
      status: 'paused',
      qualityRepair: repair.qualityRepair,
      pause: { reason: 'other', resumable: false, detailCode: 'quality-repair' }
    })
  })

  test('accepts a legacy pause manifest without the restart finality bit', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const legacy = JSON.parse(JSON.stringify(manifest({
      status: 'paused',
      pause: {
        reason: 'other',
        pausedAt: '2026-07-11T12:05:00.000Z',
        detailCode: 'quality-repair'
      }
    }))) as { pause: Record<string, unknown> }
    delete legacy.pause.resumable
    await writeFile(store.manifestPath, `${JSON.stringify(legacy)}\n`, 'utf8')

    await expect(store.readManifest()).resolves.toMatchObject({
      pause: { reason: 'other', detailCode: 'quality-repair' }
    })
  })

  test('reconstructs the newest safe state and ignores a truncated final journal line', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const first = manifest()
    const second = manifest({
      revision: 2,
      status: 'paused',
      updatedAt: '2026-07-11T12:05:00.000Z',
      pause: {
        reason: 'host-interrupted',
        pausedAt: '2026-07-11T12:05:00.000Z'
      }
    })

    await store.persist(first)
    await store.persist(second)
    await writeFile(store.manifestPath, '{"corrupted":', 'utf8')
    const journal = await readFile(store.journalPath, 'utf8')
    await writeFile(store.journalPath, `${journal}{"journalVersion":1,"state":`, 'utf8')

    await expect(store.reconstruct()).resolves.toEqual(second)
  })

  test('uses a newer valid manifest when the journal is stale', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const first = manifest()
    const second = manifest({ revision: 2, updatedAt: '2026-07-11T12:10:00.000Z' })

    await store.persist(first)
    await writeFile(store.manifestPath, `${JSON.stringify(second)}\n`, 'utf8')

    await expect(store.reconstruct()).resolves.toEqual(second)
  })

  test('defaults a legacy manifest without a mission profile to surprise', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const legacy = JSON.parse(JSON.stringify(manifest())) as { request: Record<string, unknown> }
    delete legacy.request.missionProfile
    await writeFile(store.manifestPath, `${JSON.stringify(legacy)}\n`, 'utf8')

    await expect(store.readManifest()).resolves.toMatchObject({ request: { missionProfile: 'surprise' } })
  })

  test('accepts an older manifest without provider runtime observations', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const legacy = JSON.parse(JSON.stringify(manifest())) as Record<string, unknown>
    delete legacy.providerRuntimes
    await writeFile(store.manifestPath, `${JSON.stringify(legacy)}\n`, 'utf8')

    await expect(store.readManifest()).resolves.not.toHaveProperty('providerRuntimes')
  })

  test('rejects a manifest or journal belonging to another run or workspace', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })

    await store.persist(manifest())
    await writeFile(
      store.manifestPath,
      `${JSON.stringify(manifest({ workspaceId: 'workspace-other-c3d4' }))}\n`,
      'utf8'
    )
    await expect(store.readManifest()).rejects.toBeInstanceOf(DurableRunIdentityError)

    await writeFile(store.manifestPath, `${JSON.stringify(manifest())}\n`, 'utf8')
    const wrongRun = manifest({ runId: 'duo-run-other-c3d4', revision: 2 })
    await writeFile(
      store.journalPath,
      `${JSON.stringify({ journalVersion: 1, state: wrongRun })}\n`,
      'utf8'
    )
    await expect(store.readJournal()).rejects.toBeInstanceOf(DurableRunIdentityError)
  })

  test('rejects invalid timing, cursor, and duplicate evidence state', async () => {
    const root = await temporaryRoot()
    const store = new DurableRunStateStore(root, {
      runId: 'duo-run-fixture-a1b2',
      workspaceId: 'workspace-fixture-a1b2'
    })
    const invalid = {
      ...manifest(),
      cursor: { turnIndex: -1, stage: 'work', attempt: 0, idempotencyKey: '' },
      evidence: {
        ...manifest().evidence,
        acceptedCodeAgents: ['claude', 'claude']
      },
      timing: { remainingLeaseMs: -1, accumulatedActiveMs: -1 }
    }

    await expect(store.persist(invalid as DurableRunManifest)).rejects.toThrow(/durable run manifest/i)
  })
})
