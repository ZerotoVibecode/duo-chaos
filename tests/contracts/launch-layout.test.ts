import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('launch layout contract', () => {
  it('keeps the full loadout and recent-build rail reachable in a windowed desktop', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const sideRail = rule(css, '.launch-side-rail')

    expect(sideRail).toMatch(/overflow-y\s*:\s*auto/)
    expect(sideRail).toMatch(/overflow-x\s*:\s*hidden/)
    expect(sideRail).not.toMatch(/overflow\s*:\s*hidden/)
    expect(css).toMatch(/\.launch-side-rail\s+\.agent-loadout-panel\s*\{[^}]*scroll-margin-top/)
    expect(css).toMatch(/\.loadout-apply\s*\{[^}]*position\s*:\s*sticky[^}]*bottom\s*:/)
  })
})
