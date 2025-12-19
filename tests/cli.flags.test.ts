import { describe, expect, it } from 'vitest'

import {
  parseDurationMs,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parseRenderMode,
  parseStreamMode,
  parseYoutubeMode,
} from '../src/flags.js'

describe('cli flag parsing', () => {
  it('parses --youtube', () => {
    expect(parseYoutubeMode('auto')).toBe('auto')
    expect(parseYoutubeMode('web')).toBe('web')
    expect(parseYoutubeMode('apify')).toBe('apify')
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

  it('parses --markdown', () => {
    expect(parseMarkdownMode('off')).toBe('off')
    expect(parseMarkdownMode('auto')).toBe('auto')
    expect(parseMarkdownMode('llm')).toBe('llm')
    expect(() => parseMarkdownMode('nope')).toThrow(/Unsupported --markdown/)
  })

  it('parses --stream', () => {
    expect(parseStreamMode('auto')).toBe('auto')
    expect(parseStreamMode('on')).toBe('on')
    expect(parseStreamMode('off')).toBe('off')
    expect(() => parseStreamMode('nope')).toThrow(/Unsupported --stream/)
  })

  it('parses --render', () => {
    expect(parseRenderMode('auto')).toBe('auto')
    expect(parseRenderMode('plain')).toBe('plain')
    expect(parseRenderMode('md-live')).toBe('md-live')
    expect(parseRenderMode('mdlive')).toBe('md-live')
    expect(parseRenderMode('live')).toBe('md-live')
    expect(parseRenderMode('md')).toBe('md')
    expect(parseRenderMode('markdown')).toBe('md')
    expect(() => parseRenderMode('nope')).toThrow(/Unsupported --render/)
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
    expect(() => parseLengthArg('nope')).toThrow(/Unsupported --length/)
  })

  it('parses --max-output-tokens', () => {
    expect(parseMaxOutputTokensArg(undefined)).toBeNull()
    expect(parseMaxOutputTokensArg('2k')).toBe(2000)
    expect(parseMaxOutputTokensArg('1500')).toBe(1500)
    expect(() => parseMaxOutputTokensArg('nope')).toThrow(/Unsupported --max-output-tokens/)
  })
})
