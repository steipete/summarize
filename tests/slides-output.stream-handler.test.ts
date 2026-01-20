import { describe, expect, it } from 'vitest'
import type { ExtractedLinkContent } from '../packages/core/src/content/link-preview/content/types.js'
import {
  createSlidesSummaryStreamHandler,
  createSlidesTerminalOutput,
} from '../src/run/flows/url/slides-output.js'

const makeStdout = (isTTY: boolean) => {
  const chunks: string[] = []
  const stream = {
    isTTY,
    write: (chunk: string) => {
      chunks.push(String(chunk))
      return true
    },
  } as unknown as NodeJS.WritableStream
  return { stream, chunks }
}

describe('slides summary stream handler', () => {
  it('renders markdown in rich TTY and inserts slides inline', async () => {
    const { stream, chunks } = makeStdout(true)
    const renderedSlides: number[] = []
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: { TERM: 'xterm' },
      envForRun: { TERM: 'xterm' },
      plain: false,
      outputMode: 'line',
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        renderedSlides.push(index)
        stream.write(`[SLIDE ${index}]\n`)
      },
      getSlideIndexOrder: () => [1],
    })

    const payload = 'Hello world\n\n[slide:1]\nAfter slide'
    await handler.onChunk({ streamed: payload, prevStreamed: '', appended: payload })
    await handler.onDone?.(payload)

    const output = chunks.join('')
    expect(output).toContain('Hello')
    expect(output).toContain('[SLIDE 1]')
    expect(output).toContain('After slide')
    expect(output).not.toContain('[slide:1]')
    expect(renderedSlides).toEqual([1])
  })

  it('streams visible text through the output gate', async () => {
    const { stream, chunks } = makeStdout(false)
    const renderedSlides: number[] = []
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: 'line',
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        renderedSlides.push(index)
        stream.write(`[SLIDE ${index}]\n`)
      },
      getSlideIndexOrder: () => [1],
    })

    const payload = 'Intro line\n\n[slide:1]\nAfter'
    await handler.onChunk({ streamed: payload, prevStreamed: '', appended: payload })
    await handler.onDone?.(payload)

    const output = chunks.join('')
    expect(output).toContain('Intro line')
    expect(output).toContain('[SLIDE 1]')
    expect(output).toContain('After')
    expect(output).not.toContain('[slide:1]')
    expect(renderedSlides).toEqual([1])
  })

  it('detects headline-style first lines as slide titles', async () => {
    const { stream, chunks } = makeStdout(false)
    const titles: Array<string | null> = []
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: 'line',
      clearProgressForStdout: () => {},
      renderSlide: async (_index, title) => {
        titles.push(title ?? null)
      },
      getSlideIndexOrder: () => [1],
      getSlideMeta: () => ({ total: 1, timestamp: 4 }),
    })

    const payload = 'Intro line\n\n[slide:1]\nGraphene breakthroughs\nGraphene is strong and conductive.'
    await handler.onChunk({ streamed: payload, prevStreamed: '', appended: payload })
    await handler.onDone?.(payload)

    const output = chunks.join('')
    expect(output).toContain('Graphene is strong and conductive.')
    expect(titles[0]).toContain('Graphene breakthroughs')
  })

  it('handles delta output mode and appends a newline on finalize', async () => {
    const { stream, chunks } = makeStdout(false)
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: 'delta',
      clearProgressForStdout: () => {},
      renderSlide: async () => {},
      getSlideIndexOrder: () => [],
    })

    await handler.onChunk({ streamed: 'First', prevStreamed: '', appended: 'First' })
    await handler.onChunk({ streamed: 'Reset', prevStreamed: 'First', appended: 'Reset' })
    await handler.onDone?.('Reset')

    const output = chunks.join('')
    expect(output).toContain('First')
    expect(output).toContain('Reset')
    expect(output.endsWith('\n')).toBe(true)
  })

  it('returns null when slides output is disabled', () => {
    const { stream } = makeStdout(false)
    const extracted: ExtractedLinkContent = {
      url: 'https://example.com',
      title: null,
      description: null,
      siteName: null,
      content: '',
      truncated: false,
      totalCharacters: 0,
      wordCount: 0,
      transcriptCharacters: null,
      transcriptLines: null,
      transcriptWordCount: null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptMetadata: null,
      transcriptSegments: null,
      transcriptTimedText: null,
      mediaDurationSeconds: null,
      video: null,
      isVideoOnly: false,
      diagnostics: {},
    }

    const output = createSlidesTerminalOutput({
      io: { env: {}, envForRun: {}, stdout: stream, stderr: stream },
      flags: { plain: true, lengthArg: { kind: 'preset', preset: 'short' } },
      extracted,
      slides: null,
      enabled: false,
      clearProgressForStdout: () => {},
    })

    expect(output).toBeNull()
  })

  it('renders slides inline from markers', async () => {
    const { stream, chunks } = makeStdout(false)
    const extracted: ExtractedLinkContent = {
      url: 'https://example.com',
      title: null,
      description: null,
      siteName: null,
      content: '',
      truncated: false,
      totalCharacters: 0,
      wordCount: 0,
      transcriptCharacters: null,
      transcriptLines: null,
      transcriptWordCount: null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptMetadata: null,
      transcriptSegments: null,
      transcriptTimedText: null,
      mediaDurationSeconds: null,
      video: null,
      isVideoOnly: false,
      diagnostics: {},
    }

    const slides = {
      sourceUrl: 'https://example.com',
      sourceKind: 'youtube',
      sourceId: 'abc',
      slidesDir: '/tmp/slides',
      slidesDirId: null,
      sceneThreshold: 0.3,
      autoTuneThreshold: false,
      autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: 'none' },
      maxSlides: 10,
      minSlideDuration: 5,
      ocrRequested: false,
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 10, imagePath: '/tmp/1.png' },
        { index: 2, timestamp: 20, imagePath: '/tmp/2.png' },
      ],
      warnings: [],
    }

    const output = createSlidesTerminalOutput({
      io: { env: {}, envForRun: {}, stdout: stream, stderr: stream },
      flags: { plain: true, lengthArg: { kind: 'preset', preset: 'short' } },
      extracted,
      slides,
      enabled: true,
      clearProgressForStdout: () => {},
    })

    expect(output).not.toBeNull()
    await output?.renderFromText(['Intro', '[slide:1]', 'After'].join('\n'))

    const outputText = chunks.join('')
    expect(outputText).toContain('Slide 1')
    expect(outputText).toContain('Intro')
    expect(outputText).toContain('After')
    expect(outputText).not.toContain('[slide:1]')
  })
})
