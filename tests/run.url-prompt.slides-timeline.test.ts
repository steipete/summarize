import { describe, expect, it } from 'vitest'

import type { ExtractedLinkContent } from '../src/content/index.js'
import { buildUrlPrompt } from '../src/run/flows/url/summary.js'
import type { SlideExtractionResult } from '../src/slides/types.js'

const baseExtracted: ExtractedLinkContent = {
  url: 'https://example.com/video',
  title: 'Video',
  description: null,
  siteName: 'YouTube',
  content: 'Transcript:\nhello',
  truncated: false,
  totalCharacters: 20,
  wordCount: 2,
  transcriptCharacters: 10,
  transcriptLines: 1,
  transcriptWordCount: 2,
  transcriptSource: 'captionTracks',
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: 120,
  video: null,
  isVideoOnly: false,
  diagnostics: {
    strategy: 'html',
    firecrawl: { attempted: false, used: false, cacheMode: 'bypass', cacheStatus: 'unknown' },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: 'bypass',
      cacheStatus: 'unknown',
      textProvided: true,
      provider: 'captionTracks',
      attemptedProviders: ['captionTracks'],
    },
  },
}

const slides: SlideExtractionResult = {
  sourceUrl: 'https://example.com/video',
  sourceKind: 'youtube',
  sourceId: 'abc123',
  slidesDir: '/tmp/slides',
  sceneThreshold: 0.7,
  autoTuneThreshold: false,
  autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: 'none' },
  maxSlides: 100,
  minSlideDuration: 2,
  ocrRequested: true,
  ocrAvailable: true,
  warnings: [],
  slides: [
    { index: 1, timestamp: 10, imagePath: '/tmp/slide1.png', ocrText: 'OCR SHOULD NOT BE USED' },
    { index: 2, timestamp: 50, imagePath: '/tmp/slide2.png', ocrText: 'OCR SHOULD NOT BE USED' },
  ],
}

describe('buildUrlPrompt with slides transcript timeline', () => {
  it('injects transcript excerpts aligned to slide spans', () => {
    const prompt = buildUrlPrompt({
      extracted: {
        ...baseExtracted,
        transcriptTimedText: [
          '[0:00] intro hello',
          '[0:20] second segment',
          '[0:40] third segment',
          '[1:00] fourth segment',
        ].join('\n'),
      },
      outputLanguage: { kind: 'auto' },
      lengthArg: { kind: 'preset', preset: 'short' },
      promptOverride: null,
      lengthInstruction: null,
      languageInstruction: null,
      slides,
    })

    expect(prompt).toContain('Slide timeline (transcript excerpts):')
    expect(prompt).toContain('[slide:1] [0:00–0:40]')
    expect(prompt).toContain('intro hello second segment third segment')
    expect(prompt).toContain('[slide:2] [0:20–1:30]')
    expect(prompt).toContain('second segment third segment fourth segment')
    expect(prompt).toContain(
      'Slide format example (follow this pattern; markers on their own lines):'
    )
    expect(prompt).toContain('Repeat the 3-line slide block for every marker below, in order.')
    expect(prompt).toContain('Required markers (use each exactly once, in order)')
    expect(prompt).toContain('Do not create a dedicated Slides section or list')
    expect(prompt).not.toContain('Slides (OCR):')
    expect(prompt).not.toContain('OCR SHOULD NOT BE USED')
    expect(prompt).not.toContain('Key moments')
  })
})
