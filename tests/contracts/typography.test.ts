import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer typography contract', () => {
  it('uses a shared readable scale and never declares text below 10px', async () => {
    const css = await readFile(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toContain('--type-micro')

    const declarations = css.match(/\bfont(?:-size)?\s*:[^;]+;/g) ?? []
    const undersized = declarations.flatMap((declaration) =>
      [...declaration.matchAll(/(\d+(?:\.\d+)?)px/g)]
        .map((match) => ({ declaration, pixels: Number(match[1]) }))
        .filter(({ pixels }) => pixels < 10)
    )

    expect(undersized).toEqual([])
  })
})
