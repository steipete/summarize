import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = isTTY
  ;(stream as unknown as { columns?: number }).columns = 120
  return { stream, getText: () => text }
}

const mocks = vi.hoisted(() => {
  const slidesResult = {
    sourceUrl: 'https://example.com/video.mp4',
    sourceKind: 'direct',
    sourceId: 'video-123',
    slidesDir: '/tmp/slides',
    sceneThreshold: 0.3,
    autoTuneThreshold: true,
    autoTune: { enabled: false, chosenThreshold: 0.3, confidence: 0, strategy: 'none' },
    maxSlides: 100,
    minSlideDuration: 2,
    ocrRequested: false,
    ocrAvailable: false,
    slides: [
      {
        index: 1,
        timestamp: 12.3,
        imagePath: '/tmp/slides/slide_0001.png',
      },
    ],
    warnings: [],
  }
  return {
    slidesResult,
    resolveSlideSourceFromUrl: vi.fn(() => ({
      url: slidesResult.sourceUrl,
      kind: 'direct',
      sourceId: slidesResult.sourceId,
    })),
    extractSlidesForSource: vi.fn(async () => slidesResult),
  }
})

vi.mock('../src/slides/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/slides/index.js')>('../src/slides/index.js')
  return {
    ...actual,
    resolveSlideSourceFromUrl: mocks.resolveSlideSourceFromUrl,
    extractSlidesForSource: mocks.extractSlidesForSource,
  }
})

describe('cli slides mode', () => {
  it('prints slide paths in text mode', async () => {
    const stdout = collectStream({ isTTY: false })
    const stderr = collectStream({ isTTY: false })
    await runCli(['slides', 'https://example.com/video.mp4'], {
      env: { HOME: '/tmp' },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    const text = stdout.getText()
    expect(text).toContain('Slides extracted: 1')
    expect(text).toContain('Slides dir: /tmp/slides')
    expect(text).toContain('\t0:12\t/tmp/slides/slide_0001.png')
  })

  it('prints JSON when requested', async () => {
    const stdout = collectStream({ isTTY: false })
    const stderr = collectStream({ isTTY: false })
    await runCli(['slides', 'https://example.com/video.mp4', '--json'], {
      env: { HOME: '/tmp' },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    const parsed = JSON.parse(stdout.getText())
    expect(parsed.ok).toBe(true)
    expect(parsed.slides?.slides?.length).toBe(1)
  })

  it('fails to render inline when stdout is not a TTY', async () => {
    const stdout = collectStream({ isTTY: false })
    const stderr = collectStream({ isTTY: false })
    await expect(
      runCli(['slides', 'https://example.com/video.mp4', '--render', 'kitty'], {
        env: { HOME: '/tmp' },
        fetch: globalThis.fetch.bind(globalThis),
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow('--render requires a TTY stdout.')
  })
})
