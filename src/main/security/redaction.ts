export interface RedactionInput {
  value: string
  label?: string
}

export interface RedactionTerm {
  value: string
  label: string
  pattern: RegExp
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\b(?:OPENAI|ANTHROPIC|GITHUB|GITLAB|NPM)_[A-Z0-9_]*(?:KEY|TOKEN)\s*=\s*)[^\s"']+/gi, '$1[SECRET]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[SECRET]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[SECRET]'],
  [/\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi, 'Bearer [SECRET]']
]

const PERSONAL_DATA_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[EMAIL]'],
  [/\b[A-Z]:\\Users\\[^\\\r\n]+(?:\\[^\s"'<>|]+)*/giu, '[LOCAL_PATH]'],
  [/\\\\[^\\\s"'<>|]+\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/gu, '[LOCAL_PATH]'],
  [/\b[A-Z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/giu, '[LOCAL_PATH]'],
  [/(?<![A-Z0-9:/])\/(?:Users|home|root|tmp|var|etc|opt|usr|srv|mnt|media|workspace|workspaces|private)(?:\/[^\s"'<>|?#]+)+/giu, '[LOCAL_PATH]']
]

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termPattern(value: string): RegExp {
  const parts = value.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escapeRegex)
  const flexible = parts.join('[\\s\\p{P}\\p{S}_]+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${flexible}(?![\\p{L}\\p{N}])`, 'giu')
}

export function buildRedactionTerms(inputs: RedactionInput[]): RedactionTerm[] {
  const seen = new Set<string>()
  const values: Array<{ value: string; label: string }> = []

  for (const input of inputs) {
    const value = input.value.trim()
    if (value.length < 2) continue
    const label = input.label?.trim() || 'REDACTED'
    const candidates = [value, ...value.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 5)]
    for (const candidate of candidates) {
      if (!/[\p{L}\p{N}]/u.test(candidate)) continue
      const key = candidate.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      values.push({ value: candidate, label })
    }
  }

  return values
    .sort((left, right) => right.value.length - left.value.length)
    .map((term) => ({ ...term, pattern: termPattern(term.value) }))
}

export function redactText(text: string, terms: RedactionTerm[]): string {
  let result = text
  for (const term of terms) {
    result = result.replace(term.pattern, `[${term.label}]`)
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  for (const [pattern, replacement] of PERSONAL_DATA_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}
