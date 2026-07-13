import { describe, expect, it } from 'vitest'
import { buildRedactionTerms, redactText } from '../../src/main/security/redaction'

describe('Spoiler Shield redaction', () => {
  const terms = buildRedactionTerms([
    { value: 'Nebula Pantry', label: 'APP_NAME' },
    { value: 'pantry duel', label: 'FEATURE' }
  ])

  it('redacts names case-insensitively across punctuation', () => {
    expect(redactText('NEBULA-PANTRY makes Nebula Pantry competitive.', terms)).toBe(
      '[APP_NAME] makes [APP_NAME] competitive.'
    )
  })

  it('redacts product names across dot, slash, and em-dash separators', () => {
    const signalTerms = buildRedactionTerms([{ value: 'Signal Garden', label: 'APP_NAME' }])
    expect(redactText('Signal.Garden, Signal/Garden, and Signal—Garden are sealed.', signalTerms)).toBe(
      '[APP_NAME], [APP_NAME], and [APP_NAME] are sealed.'
    )
  })

  it('redacts a two-character product title without matching it inside a larger word', () => {
    const shortTerms = buildRedactionTerms([{ value: 'XY', label: 'APP_NAME' }])
    expect(redactText('XY is sealed; XYZ remains ordinary.', shortTerms)).toBe(
      '[APP_NAME] is sealed; XYZ remains ordinary.'
    )
  })

  it('ignores punctuation-only dictionary entries instead of creating an empty matcher', () => {
    const punctuationOnly = buildRedactionTerms([{ value: '--', label: 'APP_NAME' }])
    expect(punctuationOnly).toEqual([])
    expect(redactText('The interface remains readable.', punctuationOnly)).toBe('The interface remains readable.')
  })

  it('redacts overlapping phrases before shorter generated variants', () => {
    expect(redactText('The pantry duel is stronger than the pantry view.', terms)).toBe(
      'The [FEATURE] is stronger than the [APP_NAME] view.'
    )
  })

  it('redacts common secrets from public output', () => {
    const openAiLikeToken = ['sk', 'test_12345678901234567890'].join('-')
    const githubLikeToken = ['ghp', '123456789012345678901234567890123456'].join('_')
    const value = `OPENAI_API_KEY=${openAiLikeToken} and ${githubLikeToken}`
    expect(redactText(value, [])).toBe('OPENAI_API_KEY=[SECRET] and [SECRET]')
  })

  it('redacts emails and local absolute paths from public text', () => {
    const value = [
      'Owner private@example.com opened C:\\Users\\private-owner\\Documents\\secret.txt.',
      'UNC \\\\server\\private-share\\hidden.json and POSIX /home/private-owner/project/secret.ts.',
      'macOS /Users/private-owner/Project/app.ts and generic /opt/private/app/config.json.'
    ].join(' ')

    const redacted = redactText(value, [])
    expect(redacted).not.toMatch(/private@example\.com|private-owner|private-share|secret\.txt|hidden\.json/iu)
    expect(redacted).toContain('[EMAIL]')
    expect(redacted.match(/\[LOCAL_PATH\]/gu)?.length).toBeGreaterThanOrEqual(4)
  })

  it('preserves relative app paths and ordinary URLs', () => {
    const value = 'Verified app/index.html. Read https://example.com/docs/setup and /api/health.'
    expect(redactText(value, [])).toBe(value)
  })

  it('does not corrupt ordinary words', () => {
    expect(redactText('The panel is stable and readable.', terms)).toBe(
      'The panel is stable and readable.'
    )
  })
})
