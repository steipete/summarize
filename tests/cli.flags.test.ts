import { describe, expect, it } from 'vitest'

import {
  parseDurationMs,
  parseExtractFormat,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parsePreprocessMode,
  parseStreamMode,
  parseYoutubeMode,
} from '../src/flags.js'

describe('cli flag parsing', () => {
  it('parses --youtube', () => {
    expect(parseYoutubeMode('auto')).toBe('auto')
    expect(parseYoutubeMode('web')).toBe('web')
    expect(parseYoutubeMode('apify')).toBe('apify')
    expect(parseYoutubeMode('yt-dlp')).toBe('yt-dlp')
    expect(parseYoutubeMode('autp')).toBe('auto')
    expect(() => parseYoutubeMode('nope')).toThrow(/Unsupported --youtube/)
  })

  it('parses --timeout durations', () => {
    expect(parseDurationMs('30')).toBe(30_000)
    expect(parseDurationMs('30s')).toBe(30_000)
    expect(parseDurationMs('2m')).toBe(120_000)
    expect(parseDurationMs('500ms')).toBe(500)
    expect(() => parseDurationMs('0')).toThrow(/Unsupported --timeout/)
  })

  it('parses --firecrawl', () => {
    expect(parseFirecrawlMode('off')).toBe('off')
    expect(parseFirecrawlMode('auto')).toBe('auto')
    expect(parseFirecrawlMode('always')).toBe('always')
    expect(() => parseFirecrawlMode('nope')).toThrow(/Unsupported --firecrawl/)
  })

  it('parses --markdown-mode', () => {
    expect(parseMarkdownMode('off')).toBe('off')
    expect(parseMarkdownMode('auto')).toBe('auto')
    expect(parseMarkdownMode('llm')).toBe('llm')
    expect(() => parseMarkdownMode('nope')).toThrow(/Unsupported --markdown-mode/)
  })

  it('parses --format', () => {
    expect(parseExtractFormat('md')).toBe('markdown')
    expect(parseExtractFormat('markdown')).toBe('markdown')
    expect(parseExtractFormat('text')).toBe('text')
    expect(parseExtractFormat('plain')).toBe('text')
    expect(() => parseExtractFormat('nope')).toThrow(/Unsupported --format/)
  })

  it('parses --preprocess', () => {
    expect(parsePreprocessMode('off')).toBe('off')
    expect(parsePreprocessMode('auto')).toBe('auto')
    expect(parsePreprocessMode('always')).toBe('always')
    expect(parsePreprocessMode('on')).toBe('always')
    expect(() => parsePreprocessMode('nope')).toThrow(/Unsupported --preprocess/)
  })

  it('parses --stream', () => {
    expect(parseStreamMode('auto')).toBe('auto')
    expect(parseStreamMode('on')).toBe('on')
    expect(parseStreamMode('off')).toBe('off')
    expect(() => parseStreamMode('nope')).toThrow(/Unsupported --stream/)
  })

  it('parses --metrics', () => {
    expect(parseMetricsMode('on')).toBe('on')
    expect(parseMetricsMode('off')).toBe('off')
    expect(parseMetricsMode('detailed')).toBe('detailed')
    expect(() => parseMetricsMode('nope')).toThrow(/Unsupported --metrics/)
  })

  it('parses --length as preset or character count', () => {
    expect(parseLengthArg('medium')).toEqual({ kind: 'preset', preset: 'medium' })
    expect(parseLengthArg('20k')).toEqual({ kind: 'chars', maxCharacters: 20_000 })
    expect(parseLengthArg('1500')).toEqual({ kind: 'chars', maxCharacters: 1500 })
    expect(parseLengthArg('50')).toEqual({ kind: 'chars', maxCharacters: 50 })
    expect(parseLengthArg('10')).toEqual({ kind: 'chars', maxCharacters: 10 })
    expect(() => parseLengthArg('1')).toThrow(/Unsupported --length/)
    expect(() => parseLengthArg('9')).toThrow(/Unsupported --length/)
    expect(() => parseLengthArg('nope')).toThrow(/Unsupported --length/)
  })

  it('parses --max-output-tokens', () => {
    expect(parseMaxOutputTokensArg(undefined)).toBeNull()
    expect(parseMaxOutputTokensArg('2k')).toBe(2000)
    expect(parseMaxOutputTokensArg('1500')).toBe(1500)
    expect(parseMaxOutputTokensArg('16')).toBe(16)
    expect(() => parseMaxOutputTokensArg('1')).toThrow(/Unsupported --max-output-tokens/)
    expect(() => parseMaxOutputTokensArg('15')).toThrow(/Unsupported --max-output-tokens/)
    expect(() => parseMaxOutputTokensArg('nope')).toThrow(/Unsupported --max-output-tokens/)
  })
})
