const MOJIBAKE_REPAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e2\u20ac\u2122', '\u2019'],
  ['\u00e2\u20ac\u02dc', '\u2018'],
  ['\u00e2\u20ac\u0153', '\u201c'],
  ['\u00e2\u20ac\u009d', '\u201d'],
  ['\u00e2\u20ac\u201c', '\u2013'],
  ['\u00e2\u20ac\u201d', '\u2014'],
  ['\u00e2\u20ac\u00a6', '\u2026'],
  ['\u00e2\u2020\u2019', '\u2192'],
  ['\u00e2\u0080\u0099', '\u2019'],
  ['\u00e2\u0080\u0098', '\u2018'],
  ['\u00e2\u0080\u009c', '\u201c'],
  ['\u00e2\u0080\u009d', '\u201d'],
  ['\u00e2\u0080\u0093', '\u2013'],
  ['\u00e2\u0080\u0094', '\u2014'],
  ['\u00e2\u0080\u00a6', '\u2026'],
  ['\u00e2\u0086\u0092', '\u2192'],
  ['\u00c2\u00b7', '\u00b7']
]

const SUSPICIOUS_TEXT = /[\u00c2\u00c3\u00e2\ufffd]/gu

function suspiciousCount(value: string): number {
  return value.match(SUSPICIOUS_TEXT)?.length ?? 0
}

/** Repair common UTF-8-as-Windows-1252/Latin-1 text without touching valid Unicode. */
export function repairMojibake(value: string): string {
  let repaired = value
  for (const [broken, replacement] of MOJIBAKE_REPAIRS) repaired = repaired.replaceAll(broken, replacement)

  const decodeRun = (run: string): string => {
    if (!/[\u00c2\u00c3\u00e2]/u.test(run)) return run
    const decoded = Buffer.from(run, 'latin1').toString('utf8')
    if (decoded.includes('\ufffd') || suspiciousCount(decoded) >= suspiciousCount(run)) return run
    return decoded
  }
  let result = ''
  let latin1Run = ''
  for (const character of repaired) {
    if (character.codePointAt(0)! <= 0xff) {
      latin1Run += character
      continue
    }
    result += decodeRun(latin1Run) + character
    latin1Run = ''
  }
  return result + decodeRun(latin1Run)
}

/** Zod has already limited these values to plain provider-authored JSON. */
export function repairProviderText<T>(value: T): T {
  if (typeof value === 'string') return repairMojibake(value) as T
  if (Array.isArray(value)) {
    const providerItems = value as unknown[]
    return providerItems.map((item) => repairProviderText(item)) as T
  }
  if (typeof value !== 'object' || value === null) return value
  const providerRecord = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(providerRecord).map(([key, item]) => [key, repairProviderText(item)])
  ) as T
}
