import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_PROTOCOL_LIMIT = 4 * 1024 * 1024

export class UnsafeProtocolPathError extends Error {
  constructor(message = 'Unsafe protocol path: a generated workspace link or path escape was rejected.') {
    super(message)
    this.name = 'UnsafeProtocolPathError'
  }
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

function isInside(candidate: string, root: string): boolean {
  const path = comparablePath(candidate)
  const parent = comparablePath(root)
  return path === parent || path.startsWith(`${parent}${sep}`)
}

async function assertDirectoryChain(rootPath: string, targetParent: string): Promise<void> {
  const root = resolve(rootPath)
  const parent = resolve(targetParent)
  if (!isInside(parent, root)) throw new UnsafeProtocolPathError()
  const traversal = relative(root, parent).split(/[\\/]+/u).filter(Boolean)
  let current = root
  for (const segment of traversal) {
    current = resolve(current, segment)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafeProtocolPathError()
  }
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new UnsafeProtocolPathError()
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(parent)])
  if (!isInside(canonicalParent, canonicalRoot) || comparablePath(canonicalParent) !== comparablePath(parent)) {
    throw new UnsafeProtocolPathError()
  }
}

async function safeExistingFile(rootPath: string, path: string, maximumBytes: number): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  const root = resolve(rootPath)
  const target = resolve(path)
  if (!isInside(target, root)) throw new UnsafeProtocolPathError()
  await assertDirectoryChain(root, dirname(target))
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) throw new UnsafeProtocolPathError()
    if (comparablePath(await realpath(target)) !== comparablePath(target)) throw new UnsafeProtocolPathError()
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(target, constants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maximumBytes) {
      await handle.close()
      throw new UnsafeProtocolPathError()
    }
    return handle
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof UnsafeProtocolPathError) throw error
    throw new UnsafeProtocolPathError()
  }
}

export async function safeReadProtocolText(
  rootPath: string,
  path: string,
  maximumBytes = DEFAULT_PROTOCOL_LIMIT
): Promise<string | undefined> {
  const handle = await safeExistingFile(rootPath, path, maximumBytes)
  if (!handle) return undefined
  try {
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export async function safeWriteProtocolText(rootPath: string, path: string, content: string): Promise<void> {
  const root = resolve(rootPath)
  const target = resolve(path)
  if (!isInside(target, root)) throw new UnsafeProtocolPathError()
  await assertDirectoryChain(root, dirname(target))
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    throw error instanceof UnsafeProtocolPathError ? error : new UnsafeProtocolPathError()
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function safeAppendProtocolText(
  rootPath: string,
  path: string,
  content: string,
  maximumBytes = DEFAULT_PROTOCOL_LIMIT
): Promise<void> {
  const existing = await safeReadProtocolText(rootPath, path, maximumBytes) ?? ''
  if (Buffer.byteLength(existing) + Buffer.byteLength(content) > maximumBytes) {
    throw new UnsafeProtocolPathError('Unsafe protocol path: the protocol file exceeded its supervisor size limit.')
  }
  await safeWriteProtocolText(rootPath, path, `${existing}${content}`)
}

export async function safeListProtocolFiles(
  rootPath: string,
  directoryPath: string,
  maximumEntries = 128
): Promise<string[]> {
  const root = resolve(rootPath)
  const directory = resolve(directoryPath)
  await assertDirectoryChain(root, directory)
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .slice(0, maximumEntries)
    .map((entry) => entry.name)
}
