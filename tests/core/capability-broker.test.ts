import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPABILITY_CATALOG,
  selectTurnCapabilities,
  type CapabilityDescriptor
} from '../../src/main/orchestrator/capability-broker'

describe('progressive capability broker', () => {
  it('selects only metadata for the best three relevant capabilities', () => {
    const result = selectTurnCapabilities({
      mission: 'serious',
      stage: 'work',
      turnKind: 'verify',
      profile: 'smart',
      task: 'Verify an Electron React TypeScript UI with browser interactions and accessibility.',
      stack: ['typescript', 'react', 'electron'],
      catalog: DEFAULT_CAPABILITY_CATALOG
    })

    expect(result.selected.map((entry) => entry.id)).toEqual([
      'duo-quality',
      'typescript-lsp',
      'browser-qa'
    ])
    expect(result.selected).toHaveLength(3)
    expect(result.promptContract).toContain('duo-quality')
    expect(result.promptContract).toContain('typescript-lsp')
    expect(result.promptContract).toContain('browser-qa')
    expect(result.promptContract).not.toContain('SKILL.md contents')
  })

  it('recommends TypeScript language intelligence during UI implementation but defers browser QA until review or verification', () => {
    const implementation = selectTurnCapabilities({
      mission: 'serious', stage: 'work', turnKind: 'code', profile: 'smart',
      task: 'Implement a TypeScript React settings screen.', stack: ['typescript', 'react']
    })
    const verification = selectTurnCapabilities({
      mission: 'serious', stage: 'work', turnKind: 'verify', profile: 'smart',
      task: 'Verify the TypeScript React settings screen in the browser.', stack: ['typescript', 'react']
    })

    expect(implementation.selected.map((entry) => entry.id)).toContain('typescript-lsp')
    expect(implementation.selected.map((entry) => entry.id)).not.toContain('browser-qa')
    expect(verification.selected.map((entry) => entry.id)).toContain('browser-qa')
    expect(implementation.recommendations).toContainEqual(expect.objectContaining({
      id: 'typescript-lsp', disposition: 'recommend-install'
    }))
  })

  it('does not enable Caveman, RTK, or other third-party tools by default', () => {
    const thirdParty: CapabilityDescriptor[] = [
      {
        id: 'caveman', label: 'Caveman', kind: 'plugin', trust: 'third-party',
        summary: 'Compress output tokens.', tags: ['typescript', 'quality'], available: true
      },
      {
        id: 'rtk', label: 'RTK', kind: 'plugin', trust: 'third-party',
        summary: 'Filter commands.', tags: ['typescript', 'quality'], available: true
      }
    ]
    const result = selectTurnCapabilities({
      mission: 'serious', stage: 'work', turnKind: 'code', profile: 'smart',
      task: 'Build a TypeScript UI with excellent quality.', stack: ['typescript'],
      catalog: [...thirdParty, ...DEFAULT_CAPABILITY_CATALOG]
    })

    expect(result.selected.map((entry) => entry.id)).not.toContain('caveman')
    expect(result.selected.map((entry) => entry.id)).not.toContain('rtk')
    expect(result.suppressed.map((entry) => entry.id)).toEqual(expect.arrayContaining(['caveman', 'rtk']))
  })

  it('never leaks the unselected capability inventory into the prompt', () => {
    const catalog: CapabilityDescriptor[] = Array.from({ length: 20 }, (_, index) => ({
      id: `private-mcp-${index}`,
      label: `Private MCP ${index}`,
      kind: 'mcp',
      trust: 'user',
      summary: `Private tool ${index}`,
      tags: [`unrelated-${index}`],
      available: true
    }))
    const result = selectTurnCapabilities({
      mission: 'surprise', stage: 'work', turnKind: 'code', profile: 'smart',
      task: 'Create a tiny local HTML animation.', stack: ['html'],
      catalog: [...DEFAULT_CAPABILITY_CATALOG, ...catalog]
    })

    expect(result.selected.length).toBeLessThanOrEqual(3)
    for (const omitted of catalog) expect(result.promptContract).not.toContain(omitted.label)
  })

  it('keeps dialogue tool-free and can return zero capabilities', () => {
    const result = selectTurnCapabilities({
      mission: 'surprise', stage: 'dialogue', turnKind: 'critique', profile: 'full-local',
      task: 'Critique the other pitch without tools.'
    })

    expect(result.selected).toEqual([])
    expect(result.promptContract).toMatch(/no external capability/i)
  })

  it('allows an explicitly approved third-party capability without making it global', () => {
    const catalog: CapabilityDescriptor[] = [{
      id: 'special-a11y', label: 'Special A11y', kind: 'skill', trust: 'third-party',
      summary: 'Audit accessibility.', tags: ['accessibility', 'browser'], available: true,
      stages: ['work'], turnKinds: ['verify']
    }]
    const result = selectTurnCapabilities({
      mission: 'serious', stage: 'work', turnKind: 'verify', profile: 'smart',
      task: 'Audit browser accessibility.', catalog, approvedThirdPartyIds: ['special-a11y']
    })

    expect(result.selected).toEqual([expect.objectContaining({ id: 'special-a11y', disposition: 'available' })])
  })
})
