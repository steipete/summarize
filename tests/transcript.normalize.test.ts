import { describe, expect, it } from 'vitest'

import {
  normalizeApifyTranscript,
  normalizeTranscriptLines,
  normalizeTranscriptText,
} from '../packages/core/src/content/transcript/normalize.js'

describe('transcript normalization', () => {
  it('normalizes whitespace and NBSP in transcript text', () => {
    const input = `\u00A0Hello\t \tworld \n\n  next   line \n\n\n end `
    expect(normalizeTranscriptText(input)).toBe('Hello world\nnext line\nend')
  })

  it('returns null for empty transcript lines', () => {
    expect(normalizeTranscriptLines([])).toBeNull()
    expect(normalizeTranscriptLines(['   ', '\n'])).toBeNull()
  })

  it('normalizes Apify transcript strings and arrays', () => {
    expect(normalizeApifyTranscript('  Hello  \n\n world ')).toBe('Hello\nworld')
    expect(normalizeApifyTranscript('   ')).toBeNull()

    expect(
      normalizeApifyTranscript([
        { text: ' Line 1 ' },
        { text: 123 },
        'nope',
        { foo: 'bar' },
        { text: 'Line 2' },
      ])
    ).toBe('Line 1\nLine 2')

    expect(normalizeApifyTranscript([])).toBeNull()
    expect(normalizeApifyTranscript([{ text: '' }, { text: null }])).toBeNull()
  })

  it('normalizes Apify transcript objects with text', () => {
    expect(normalizeApifyTranscript({ text: '  Hi\u00A0there  ' })).toBe('Hi there')
    expect(normalizeApifyTranscript({ text: 123 })).toBeNull()
    expect(normalizeApifyTranscript(123)).toBeNull()
  })
})
