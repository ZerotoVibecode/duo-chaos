import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

function assertInsideWorkspace(workspacePath: string, target: string): void {
  const relation = relative(workspacePath, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('The generated app target is outside its workspace.')
  }
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isFile() ? await realpath(path) : undefined
  } catch {
    return undefined
  }
}

async function packageRequiresRunner(directory: string): Promise<boolean> {
  const path = join(directory, 'package.json')
  try {
    const details = await stat(path)
    if (!details.isFile() || details.size > 256_000) return false
    const value = JSON.parse(await readFile(path, 'utf8')) as { scripts?: Record<string, unknown> }
    return typeof value.scripts?.dev === 'string' || typeof value.scripts?.start === 'string'
  } catch {
    return false
  }
}

const BUILT_BROWSER_OUTPUTS = ['dist', 'build', 'out', '.output/public'] as const

async function nestedBuiltIndex(directory: string, depth: number): Promise<string | undefined> {
  if (depth > 3) return undefined
  for (const filename of ['index.html', 'index.htm']) {
    const candidate = await existingFile(join(directory, filename))
    if (candidate) return candidate
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = await nestedBuiltIndex(join(directory, entry.name), depth + 1)
    if (candidate) return candidate
  }
  return undefined
}

async function builtIndex(directory: string): Promise<string | undefined> {
  for (const output of BUILT_BROWSER_OUTPUTS) {
    const candidate = await nestedBuiltIndex(join(directory, output), 0)
    if (candidate) return candidate
  }
  return undefined
}

function assertLaunchableFile(path: string): void {
  if (!['.html', '.htm'].includes(extname(path).toLowerCase())) {
    throw new Error('Generated app launch targets must be an HTML file or a workspace directory.')
  }
}

function resolvePortableTarget(workspace: string, configuredTarget: string): string {
  const usesForeignAbsoluteSyntax = (win32.isAbsolute(configuredTarget) || posix.isAbsolute(configuredTarget))
    && !isAbsolute(configuredTarget)
  if (usesForeignAbsoluteSyntax) {
    throw new Error('The generated app target is outside its workspace.')
  }
  return resolve(workspace, configuredTarget.replace(/[\\/]+/g, sep))
}

export async function resolveGeneratedAppLaunchTarget(
  workspacePath: string,
  configuredTarget: string
): Promise<string> {
  const workspace = await realpath(workspacePath)
  const unresolvedTarget = resolvePortableTarget(workspace, configuredTarget)
  assertInsideWorkspace(workspace, unresolvedTarget)

  let target = unresolvedTarget
  try {
    target = await realpath(unresolvedTarget)
  } catch {
    // Electron will report a missing target after containment and type checks.
  }
  assertInsideWorkspace(workspace, target)

  let details
  try {
    details = await stat(target)
  } catch {
    assertLaunchableFile(target)
    return target
  }

  if (details.isDirectory()) {
      const built = await builtIndex(target)
      if (built) {
        assertInsideWorkspace(workspace, built)
        return built
      }
      if (await packageRequiresRunner(target)) {
        throw new Error('No built HTML was found. Use the displayed run command to start this package app.')
      }
      const indexPath = join(target, 'index.html')
      const index = await existingFile(indexPath)
      if (index) {
        assertInsideWorkspace(workspace, index)
        return index
      }
      return target
  }

  assertLaunchableFile(target)
  if (/^index\.html?$/i.test(basename(target)) && await packageRequiresRunner(dirname(target))) {
    const built = await builtIndex(dirname(target))
    if (built) {
      assertInsideWorkspace(workspace, built)
      return built
    }
    throw new Error('No built HTML was found. Use the displayed run command to start this package app.')
  }
  return target
}
