const WORKSPACE_FILE_PLACEHOLDER = '[WORKSPACE_FILE]'

function normalizedRelativePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/{2,}/gu, '/')
}

/**
 * Converts model-authored task scopes into the one supervisor-owned product
 * tree. Legacy scopes such as `src/**` remain resumable, but are interpreted
 * as `app/src/**`; no generated product path may escape the app directory.
 */
export function canonicalAppSourceBoundary(value: string): string | undefined {
  const normalized = normalizedRelativePath(value)
  if (!normalized) return undefined
  if (normalized === WORKSPACE_FILE_PLACEHOLDER) return normalized
  if (/^(?:[a-z]:\/|\/|[a-z][a-z0-9+.-]*:\/\/)/iu.test(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) return undefined

  const appRelative = /^app(?:\/|$)/iu.test(normalized)
    ? normalized.replace(/^app/iu, 'app')
    : `app/${normalized}`
  const productSegments = appRelative.split('/').slice(1)
  if (productSegments.length === 0 || productSegments.some((segment) => segment === '.duo')) return undefined
  return appRelative
}

export function canonicalAppSourceBoundaries(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const canonical = canonicalAppSourceBoundary(value)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return result
}

export function appSourceBoundaryMatchesFile(boundary: string, file: string): boolean {
  const expected = canonicalAppSourceBoundary(boundary)
  const actual = normalizedRelativePath(file)
  if (!expected || expected === WORKSPACE_FILE_PLACEHOLDER || !/^app(?:\/|$)/iu.test(actual)) return false
  const pattern = expected
    .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*')
  return new RegExp(`^${pattern}${expected.endsWith('/') ? '.*' : ''}$`, 'iu').test(actual)
}
