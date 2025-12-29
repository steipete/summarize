import { describe, expect, it } from 'vitest'

import { buildChatPageContent } from '../apps/chrome-extension/src/lib/chat-context.js'

describe('chrome/chat-context', () => {
  it('includes summary when transcript is within cap', () => {
    const content = buildChatPageContent({
      transcript: 'Hello transcript',
      summary: 'Short summary',
      summaryCap: 50,
      metadata: {
        url: 'https://example.com',
        title: 'Example',
        source: 'url',
        extractionStrategy: 'html',
        mediaDurationSeconds: 120,
        transcriptSource: 'yt-dlp',
      },
    })

    expect(content).toContain('Metadata:')
    expect(content).toContain('URL: https://example.com')
    expect(content).toContain('Title: Example')
    expect(content).toContain('Source: URL extraction (daemon)')
    expect(content).toContain('Extraction strategy: html')
    expect(content).toContain('Media duration: 2m 00s')
    expect(content).toContain('Transcript source: yt-dlp')
    expect(content).toContain('Summary (auto-generated):')
  })

  it('skips summary when transcript exceeds cap', () => {
    const content = buildChatPageContent({
      transcript: 'x'.repeat(60),
      summary: 'Short summary',
      summaryCap: 50,
      metadata: { source: 'url' },
    })

    expect(content).toContain('Full transcript:')
    expect(content).not.toContain('Summary (auto-generated)')
  })

  it('skips summary when summary is empty', () => {
    const content = buildChatPageContent({
      transcript: 'Hello transcript',
      summary: '   ',
      summaryCap: 50,
      metadata: { source: 'page' },
    })

    expect(content).toContain('Full transcript:')
    expect(content).not.toContain('Summary (auto-generated)')
  })
})
