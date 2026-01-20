import { describe, expect, it } from 'vitest'

import { buildLinkSummaryPrompt } from '../packages/core/src/prompts/index.js'

describe('buildLinkSummaryPrompt (slides)', () => {
  it('adds slide timeline guidance with overview paragraph first', () => {
    const prompt = buildLinkSummaryPrompt({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Test',
      siteName: 'YouTube',
      description: null,
      content: 'Transcript:\n[0:01] Hello',
      truncated: false,
      hasTranscript: true,
      hasTranscriptTimestamps: true,
      slides: { count: 8, text: 'Slide 1 [0:00–0:30]:\nHello' },
      outputLanguage: { kind: 'fixed', tag: 'en', label: 'English' },
      summaryLength: 'short',
      shares: [],
    })

    expect(prompt).toContain('Start with a short intro paragraph')
    expect(prompt).toContain('Formatting is strict: insert each slide marker')
    expect(prompt).toContain('Required markers (use each exactly once, in order)')
    expect(prompt).toContain('Output template (copy and fill; keep markers on their own lines)')
    expect(prompt).not.toContain('Title: Headline')
    expect(prompt).toContain('Do not add a separate Slides section or list')
    expect(prompt).not.toContain('Include at least 3 headings')
  })
})
