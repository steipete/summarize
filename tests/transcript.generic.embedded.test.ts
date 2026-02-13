import { describe, expect, it, vi } from 'vitest'

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/generic.js'

const buildOptions = (overrides?: Partial<Parameters<typeof fetchTranscript>[1]>) => ({
  fetch: fetch,
  scrapeWithFirecrawl: null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto',
  mediaTranscriptMode: 'auto',
  ytDlpPath: null,
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: null,
  resolveTwitterCookies: null,
  onProgress: null,
  ...overrides,
})

describe('generic transcript provider (embedded captions)', () => {
  it('uses embedded caption tracks when present', async () => {
    const html = `
      <html>
        <body>
          <video src="/video.mp4">
            <track kind="captions" srclang="en" src="/captions.vtt" />
          </video>
        </body>
      </html>
    `

    const fetchMock = vi.fn(
      async () =>
        new Response(['WEBVTT', '', '00:00:00.000 --> 00:00:01.000', 'Hello world.'].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/vtt' },
        })
    )

    const result = await fetchTranscript(
      { url: 'https://example.com/page', html, resourceKey: null },
      buildOptions({ fetch: fetchMock })
    )

    expect(fetchMock).toHaveBeenCalled()
    expect(result.source).toBe('embedded')
    expect(result.text).toContain('Hello world')
    expect(result.attemptedProviders).toContain('embedded')
  })
})
