import { describe, expect, it } from 'vitest'
import {
  buildLinkSummaryPrompt,
  estimateMaxCompletionTokensForCharacters,
  pickSummaryLengthForCharacters,
} from '../packages/core/src/prompts/link-summary.js'
import { parseOutputLanguage } from '../src/language.js'

describe('prompts/link-summary - more branches', () => {
  it('picks summary length presets by character targets', () => {
    expect(pickSummaryLengthForCharacters(100)).toBe('short')
    expect(pickSummaryLengthForCharacters(2000)).toBe('medium')
    expect(pickSummaryLengthForCharacters(5000)).toBe('long')
    expect(pickSummaryLengthForCharacters(10_000)).toBe('xl')
    expect(pickSummaryLengthForCharacters(50_000)).toBe('xxl')
    expect(estimateMaxCompletionTokensForCharacters(1000)).toBeGreaterThan(0)
  })

  it('builds prompts with metadata, truncation notes, transcript hints, and share context', () => {
    const prompt = buildLinkSummaryPrompt({
      url: 'https://example.com',
      title: 'Title',
      siteName: 'Site',
      description: 'Desc',
      content: 'Hello world',
      truncated: true,
      hasTranscript: true,
      summaryLength: { maxCharacters: 1200 },
      outputLanguage: parseOutputLanguage('de'),
      shares: [
        {
          author: 'A',
          handle: '@a',
          text: 'Hot take',
          likeCount: 12_345,
          reshareCount: 0,
          replyCount: null,
          timestamp: '2025-12-24',
        },
        {
          author: 'B',
          text: 'Second',
          likeCount: null,
          reshareCount: null,
          replyCount: null,
          timestamp: null,
        },
      ],
    })

    expect(prompt).toContain('Source URL: https://example.com')
    expect(prompt).toContain('Title: Title')
    expect(prompt).toContain('Site: Site')
    expect(prompt).toContain('Page description: Desc')
    expect(prompt).toContain('Note: Content truncated')
    expect(prompt).toContain('12,345')
    expect(prompt).toContain('Write the answer in German.')
    expect(prompt).toContain('online videos')
  })

  it('builds prompts without shares and without truncation', () => {
    const prompt = buildLinkSummaryPrompt({
      url: 'https://example.com',
      title: null,
      siteName: null,
      description: null,
      content: '',
      truncated: false,
      hasTranscript: false,
      summaryLength: 'short',
      outputLanguage: { kind: 'auto' },
      shares: [],
    })
    expect(prompt).toContain('You are not given any quotes')
    expect(prompt).toContain('online articles')
  })

  it('respects explicit maxCharacters when below content length', () => {
    const content = 'x'.repeat(2000)
    const prompt = buildLinkSummaryPrompt({
      url: 'https://example.com',
      title: null,
      siteName: null,
      description: null,
      content,
      truncated: false,
      hasTranscript: false,
      summaryLength: { maxCharacters: 1000 },
      outputLanguage: { kind: 'auto' },
      shares: [],
    })
    expect(prompt).toContain('Target length: up to 1,000 characters')
    expect(prompt).toContain('Extracted content length: 2,000 characters')
  })
})
