import { describe, expect, it } from 'vitest'

import { resolveInputTarget } from '../src/content/asset.js'

describe('resolveInputTarget', () => {
  it('accepts valid URLs unchanged', () => {
    expect(resolveInputTarget('https://example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com',
    })
  })

  it('preserves balanced parentheses in URL paths', () => {
    const url = 'https://en.wikipedia.org/wiki/Set_(mathematics)'
    expect(resolveInputTarget(url)).toEqual({ kind: 'url', url })
  })

  it('unescapes common pasted backslash escapes for query separators', () => {
    expect(resolveInputTarget('https://www.youtube.com/watch\\?v\\=497Ov6kV4KM')).toEqual({
      kind: 'url',
      url: 'https://www.youtube.com/watch?v=497Ov6kV4KM',
    })
  })

  it('removes percent-encoded backslashes directly before query separators', () => {
    expect(resolveInputTarget('https://www.youtube.com/watch%5C?v%5C=497Ov6kV4KM')).toEqual({
      kind: 'url',
      url: 'https://www.youtube.com/watch?v=497Ov6kV4KM',
    })
  })

  it('extracts the last URL from pasted text and normalizes it', () => {
    expect(
      resolveInputTarget(
        'https://www.youtube.com/watch\\?v\\=497Ov6kV4KM (https://www.youtube.com/watch%5C?v%5C=497Ov6kV4KM)'
      )
    ).toEqual({
      kind: 'url',
      url: 'https://www.youtube.com/watch?v=497Ov6kV4KM',
    })
  })

  it('extracts embedded URLs from arbitrary text', () => {
    expect(resolveInputTarget('foo https://example.com/bar baz')).toEqual({
      kind: 'url',
      url: 'https://example.com/bar',
    })
  })

  it('falls back to earlier extracted URLs when the last one is invalid', () => {
    expect(resolveInputTarget('ok: https://example.com bad: https://example.com:99999')).toEqual({
      kind: 'url',
      url: 'https://example.com',
    })
  })

  it('extracts URLs from Markdown-style links', () => {
    expect(resolveInputTarget('[example](https://example.com/foo)')).toEqual({
      kind: 'url',
      url: 'https://example.com/foo',
    })
  })

  it('trims common surrounding punctuation when extracting URLs', () => {
    expect(resolveInputTarget('See “https://example.com/bar”, please.')).toEqual({
      kind: 'url',
      url: 'https://example.com/bar',
    })
  })

  it('handles parenthesized URLs with trailing punctuation', () => {
    expect(resolveInputTarget('(https://example.com/foo).')).toEqual({
      kind: 'url',
      url: 'https://example.com/foo',
    })
  })

  it('keeps trailing parentheses inside pasted URLs with surrounding punctuation', () => {
    expect(resolveInputTarget('(https://en.wikipedia.org/wiki/Set_(mathematics)).')).toEqual({
      kind: 'url',
      url: 'https://en.wikipedia.org/wiki/Set_(mathematics)',
    })
  })
  it('throws when neither file nor URL can be resolved', () => {
    expect(() => resolveInputTarget('not a url')).toThrow(/Invalid URL or file path/i)
  })
})
