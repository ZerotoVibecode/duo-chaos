import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const ARTIFACT_PREVIEW_SCHEME = 'duo-artifact'
export const ARTIFACT_PREVIEW_HOST = 'app'

function insideRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

export async function resolveArtifactResource(
  rootPath: string,
  requestUrl: string,
  method: string
): Promise<string> {
  if (method !== 'GET' && method !== 'HEAD') throw new Error('Artifact preview request method is not allowed.')

  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    throw new Error('Artifact preview request URL is invalid.')
  }
  if (url.protocol !== `${ARTIFACT_PREVIEW_SCHEME}:` || url.hostname !== ARTIFACT_PREVIEW_HOST) {
    throw new Error('Artifact preview request origin is not allowed.')
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    throw new Error('Artifact preview path encoding is invalid.')
  }
  if (decodedPath.includes('\0')) throw new Error('Artifact preview path is invalid.')

  const root = await realpath(rootPath)
  const unresolved = resolve(root, `.${decodedPath.replaceAll('/', sep)}`)
  if (!insideRoot(root, unresolved)) throw new Error('Artifact preview resource is outside its root.')

  let resource: string
  try {
    resource = await realpath(unresolved)
  } catch {
    throw new Error('Artifact preview resource was not found.')
  }
  if (!insideRoot(root, resource)) throw new Error('Artifact preview resource is outside its root.')
  if (!(await stat(resource)).isFile()) throw new Error('Artifact preview resource is not a file.')
  return resource
}
