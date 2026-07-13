import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function schema(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(process.cwd(), 'schemas', name), 'utf8')) as Record<string, unknown>
}

describe('public JSON schema contracts', () => {
  it('uses canonical opinion names and numeric spoiler risk', async () => {
    const value = await schema('opinion-event.schema.json')
    const required = value.required as string[]
    const properties = value.properties as Record<string, { type?: string }>
    expect(required).toEqual(expect.arrayContaining(['runId', 'round', 'timestamp', 'publicText', 'tone', 'heat']))
    expect(properties.public).toBeUndefined()
    expect(properties.mood).toBeUndefined()
    expect(properties.spoilerRisk?.type).toBe('number')
  })

  it('uses publicTitle/privateTitle on task board records', async () => {
    const value = await schema('board.schema.json')
    const properties = value.properties as { tasks: { items: { properties: Record<string, unknown>; required: string[] } } }
    expect(properties.tasks.items.required).toContain('publicTitle')
    expect(properties.tasks.items.properties).toHaveProperty('privateTitle')
    expect(properties.tasks.items.properties).not.toHaveProperty('titlePublic')
  })

  it('separates default execution and visibility modes in settings', async () => {
    const value = await schema('settings.schema.json')
    expect(value.properties).toHaveProperty('defaultExecutionMode')
    expect(value.properties).toHaveProperty('defaultVisibilityMode')
    expect(value.properties).toHaveProperty('defaultMissionProfile')
    expect(value.properties).toHaveProperty('codexModel')
    expect(value.properties).toHaveProperty('codexEffort')
    expect(value.properties).toHaveProperty('claudeModel')
    expect(value.properties).toHaveProperty('claudeEffort')
    const properties = value.properties as Record<string, { enum?: string[]; default?: number; maximum?: number }>
    expect(properties.codexEffort?.enum).toContain('ultra')
    expect(properties.claudeEffort?.enum).not.toContain('ultracode')
    expect((value.properties as Record<string, { default?: unknown }>).maxTurns?.default).toBe(11)
    expect((value.properties as Record<string, { default?: unknown }>).saveRawLogs?.default).toBe(false)
    expect(properties.turnTimeoutSeconds).toMatchObject({ default: 7_200, maximum: 28_800 })
    expect(properties.runTimeoutSeconds).toMatchObject({ default: 86_400, maximum: 86_400 })
    expect(value.required).toEqual(expect.arrayContaining([
      'codexExtraArgs', 'claudeExtraArgs', 'defaultMissionProfile', 'turnTimeoutSeconds', 'runTimeoutSeconds'
    ]))
  })

  it('mirrors release readiness and provider usage on run snapshots', async () => {
    const value = await schema('run-state.schema.json')
    expect(value.properties).toHaveProperty('releaseStatus')
    expect(value.properties).toHaveProperty('agentUsage')
    expect(value.properties).toHaveProperty('turnStage')
    const definitions = value.$defs as Record<string, { properties?: Record<string, { enum?: string[] }> }>
    expect(definitions.turnStage?.properties?.stage?.enum).toEqual(['dialogue', 'opening', 'work', 'verdict', 'recovery'])
    expect(definitions.agentRuntime?.properties?.effort?.enum).toContain('ultra')
  })

  it('publishes agent dispatch and broadcast provenance contracts', async () => {
    const event = await schema('duo-event.schema.json')
    const eventProperties = event.properties as { type: { enum: string[] }; dispatchKind?: unknown; claimKey?: unknown; replyTo?: unknown }
    expect(eventProperties.type.enum).toContain('agent.dispatch')
    expect(eventProperties).toHaveProperty('dispatchKind')
    expect(eventProperties).toHaveProperty('claimKey')
    expect(eventProperties).toHaveProperty('replyTo')

    const broadcast = await schema('broadcast-state.schema.json')
    expect(broadcast.properties).toHaveProperty('activeBeat')
    expect(broadcast.properties).toHaveProperty('beats')
    expect(broadcast.properties).toHaveProperty('missions')
    expect(broadcast.properties).toHaveProperty('responseDue')
  })

  it('publishes the sanitized local runtime catalog contract', async () => {
    const path = join(process.cwd(), 'schemas', 'runtime-catalog.schema.json')
    expect(existsSync(path)).toBe(true)
    if (!existsSync(path)) return
    const value = await schema('runtime-catalog.schema.json')
    const model = (value.properties as { models: { items: { properties: Record<string, unknown> } } }).models.items
    expect(model.properties).toHaveProperty('id')
    expect(model.properties).toHaveProperty('efforts')
    expect(model.properties).not.toHaveProperty('base_instructions')
  })

  it('publishes the pixel-only artifact preview result contract', async () => {
    const path = join(process.cwd(), 'schemas', 'artifact-preview.schema.json')
    expect(existsSync(path)).toBe(true)
    if (!existsSync(path)) return
    const value = await schema('artifact-preview.schema.json')
    const variants = value.oneOf as Array<{ properties: Record<string, { const?: string; pattern?: string }>; required: string[] }>
    expect(variants.map((variant) => variant.properties.status?.const)).toEqual(['ready', 'unavailable', 'failed'])
    expect(variants[0]?.required).toEqual(expect.arrayContaining(['imageDataUrl', 'width', 'height', 'capturedAt']))
    expect(variants[0]?.properties.imageDataUrl?.pattern).toBe('^data:image/png;base64,')
    expect(JSON.stringify(value)).not.toMatch(/workspacePath|entryPath|html/i)
  })
})
