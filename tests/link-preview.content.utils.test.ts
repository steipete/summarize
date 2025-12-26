import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CACHE_MODE,
  DEFAULT_MAX_CONTENT_CHARACTERS,
  DEFAULT_TIMEOUT_MS,
} from '../packages/core/src/content/link-preview/content/types.js'
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  pickFirstText,
  resolveCacheMode,
  resolveFirecrawlMode,
  resolveMaxCharacters,
  resolveTimeoutMs,
  safeHostname,
  selectBaseContent,
  summarizeTranscript,
} from '../packages/core/src/content/link-preview/content/utils.js'
import type {
  ContentFetchDiagnostics,
  TranscriptDiagnostics,
} from '../packages/core/src/content/link-preview/types.js'

function makeDiagnostics(overrides?: Partial<ContentFetchDiagnostics>): ContentFetchDiagnostics {
  return {
    strategy: 'html',
    firecrawl: {
      attempted: false,
      used: false,
      cacheMode: 'default',
      cacheStatus: 'unknown',
      notes: null,
    },
    markdown: {
      requested: false,
      used: false,
      provider: null,
      notes: null,
    },
    transcript: {
      cacheMode: 'default',
      cacheStatus: 'unknown',
      textProvided: false,
      provider: null,
      attemptedProviders: [],
      notes: null,
    },
    ...overrides,
  }
}

describe('link-preview content utils', () => {
  it('resolves cache/max/timeouts with sane defaults', () => {
    expect(resolveCacheMode()).toBe(DEFAULT_CACHE_MODE)
    expect(resolveCacheMode({ cacheMode: 'bypass' })).toBe('bypass')

    expect(resolveMaxCharacters()).toBeNull()
    expect(resolveMaxCharacters({ maxCharacters: -1 })).toBeNull()
    expect(resolveMaxCharacters({ maxCharacters: 1 })).toBe(DEFAULT_MAX_CONTENT_CHARACTERS)
    expect(resolveMaxCharacters({ maxCharacters: DEFAULT_MAX_CONTENT_CHARACTERS })).toBe(
      DEFAULT_MAX_CONTENT_CHARACTERS
    )
    expect(resolveMaxCharacters({ maxCharacters: DEFAULT_MAX_CONTENT_CHARACTERS + 0.8 })).toBe(
      DEFAULT_MAX_CONTENT_CHARACTERS
    )
    expect(resolveMaxCharacters({ maxCharacters: DEFAULT_MAX_CONTENT_CHARACTERS + 123.9 })).toBe(
      DEFAULT_MAX_CONTENT_CHARACTERS + 123
    )

    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveTimeoutMs({ timeoutMs: 0 })).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveTimeoutMs({ timeoutMs: 123.9 })).toBe(123)
  })

  it('resolves firecrawl mode with fallback', () => {
    expect(resolveFirecrawlMode()).toBe('auto')
    expect(resolveFirecrawlMode({ firecrawl: 'off' })).toBe('off')
    expect(resolveFirecrawlMode({ firecrawl: 'auto' })).toBe('auto')
    expect(resolveFirecrawlMode({ firecrawl: 'always' })).toBe('always')
    expect(resolveFirecrawlMode({ firecrawl: 'nope' as never })).toBe('auto')
  })

  it('handles basic string helpers', () => {
    expect(appendNote(null, '')).toBe('')
    expect(appendNote(null, 'a')).toBe('a')
    expect(appendNote('', 'a')).toBe('a')
    expect(appendNote('a', 'b')).toBe('a; b')

    expect(safeHostname('https://www.example.com/path')).toBe('example.com')
    expect(safeHostname('not-a-url')).toBeNull()

    expect(pickFirstText([null, '   ', '\n', ' ok ', 'later'])).toBe('ok')
    expect(pickFirstText([null, undefined, ''])).toBeNull()
  })

  it('selects transcript content only when present', () => {
    expect(selectBaseContent('SOURCE', null)).toBe('SOURCE')
    expect(selectBaseContent('SOURCE', '   \n')).toBe('SOURCE')
    expect(selectBaseContent('SOURCE', '  hello \n world ')).toContain('Transcript:\n')
  })

  it('summarizes transcript basics', () => {
    expect(summarizeTranscript(null)).toEqual({
      transcriptCharacters: null,
      transcriptLines: null,
      transcriptWordCount: null,
    })
    expect(summarizeTranscript('')).toEqual({
      transcriptCharacters: null,
      transcriptLines: null,
      transcriptWordCount: null,
    })
    expect(summarizeTranscript('a\n\nb')).toEqual({
      transcriptCharacters: 4,
      transcriptLines: 2,
      transcriptWordCount: 2,
    })
  })

  it('ensures transcript diagnostics when missing', () => {
    const existing: TranscriptDiagnostics = {
      cacheMode: 'default',
      cacheStatus: 'hit',
      textProvided: true,
      provider: 'html',
      attemptedProviders: ['html'],
      notes: null,
    }
    expect(
      ensureTranscriptDiagnostics({ text: 'ok', source: 'html', diagnostics: existing }, 'default')
    ).toBe(existing)

    expect(ensureTranscriptDiagnostics({ text: 'ok', source: 'html' }, 'default')).toMatchObject({
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: true,
      provider: 'html',
      attemptedProviders: ['html'],
      notes: null,
    })

    expect(ensureTranscriptDiagnostics({ text: null, source: null }, 'default')).toMatchObject({
      cacheStatus: 'unknown',
      attemptedProviders: [],
    })

    expect(
      ensureTranscriptDiagnostics({ text: 'ok', source: 'captionTracks' }, 'bypass')
    ).toMatchObject({
      cacheMode: 'bypass',
      cacheStatus: 'bypassed',
      notes: 'Cache bypass requested',
      attemptedProviders: ['captionTracks'],
    })
  })

  it('finalizes extracted content with/without budget', () => {
    const diagnostics = makeDiagnostics()

    const withBudget = finalizeExtractedLinkContent({
      url: 'https://example.com',
      baseContent: 'A'.repeat(100),
      maxCharacters: 20,
      title: 't',
      description: null,
      siteName: null,
      transcriptResolution: { text: 'x', source: 'html' },
      diagnostics,
    })
    expect(withBudget.content.length).toBeLessThanOrEqual(20)
    expect(withBudget.totalCharacters).toBeGreaterThan(20)
    expect(withBudget.truncated).toBe(true)
    expect(withBudget.transcriptCharacters).toBe(1)
    expect(withBudget.transcriptLines).toBe(1)
    expect(withBudget.transcriptWordCount).toBe(1)
    expect(withBudget.mediaDurationSeconds).toBeNull()

    const noBudget = finalizeExtractedLinkContent({
      url: 'https://example.com',
      baseContent: 'one two  three',
      maxCharacters: null,
      title: null,
      description: null,
      siteName: null,
      transcriptResolution: { text: '', source: 'unknown' },
      diagnostics,
    })
    expect(noBudget.truncated).toBe(false)
    expect(noBudget.wordCount).toBe(3)
    expect(noBudget.transcriptCharacters).toBeNull()
    expect(noBudget.transcriptLines).toBeNull()
    expect(noBudget.transcriptWordCount).toBeNull()
    expect(noBudget.mediaDurationSeconds).toBeNull()
  })

  it('pulls media duration from transcript metadata', () => {
    const diagnostics = makeDiagnostics()
    const result = finalizeExtractedLinkContent({
      url: 'https://example.com',
      baseContent: 'Transcript:\nhello',
      maxCharacters: null,
      title: null,
      description: null,
      siteName: null,
      transcriptResolution: {
        text: 'hello',
        source: 'whisper',
        metadata: { durationSeconds: 123 },
      },
      diagnostics,
    })
    expect(result.mediaDurationSeconds).toBe(123)
  })
})
