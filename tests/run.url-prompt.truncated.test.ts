import { describe, expect, it } from 'vitest'

import type { ExtractedLinkContent } from '../src/content/index.js'
import { buildUrlPrompt } from '../src/run/flows/url/summary.js'

describe('buildUrlPrompt', () => {
  it('propagates extracted.truncated into the prompt context', () => {
    const base: ExtractedLinkContent = {
      url: 'https://example.com',
      title: 'Hello',
      description: null,
      siteName: 'Example',
      content: 'Content',
      truncated: true,
      totalCharacters: 7,
      wordCount: 1,
      transcriptCharacters: null,
      transcriptLines: null,
      transcriptWordCount: null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptMetadata: null,
      mediaDurationSeconds: null,
      video: null,
      isVideoOnly: false,
      diagnostics: {
        strategy: 'html',
        firecrawl: { attempted: false, used: false, cacheMode: 'bypass', cacheStatus: 'unknown' },
        markdown: { requested: false, used: false, provider: null },
        transcript: {
          cacheMode: 'bypass',
          cacheStatus: 'unknown',
          textProvided: false,
          provider: null,
          attemptedProviders: [],
        },
      },
    }

    const prompt = buildUrlPrompt({
      extracted: base,
      outputLanguage: { kind: 'auto' },
      lengthArg: { kind: 'preset', preset: 'xl' },
      promptOverride: null,
      lengthInstruction: null,
      languageInstruction: null,
    })

    expect(prompt).toContain('Note: Content truncated')
  })
})

