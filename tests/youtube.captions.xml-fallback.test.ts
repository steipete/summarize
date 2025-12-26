import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptFromCaptionTracks } from '../packages/core/src/content/link-preview/transcript/providers/youtube/captions.js'

const jsonResponse = (payload: unknown, status = 200) => Response.json(payload, { status })

describe('YouTube captionTracks XML fallback', () => {
  it('falls back to XML when json3 fetch fails', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '</head><body><main><p>Fallback paragraph</p></main></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url

      if (url.includes('youtubei/v1/player')) {
        return Promise.resolve(
          jsonResponse({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    baseUrl: 'https://example.com/captions?lang=en&fmt=srv3',
                    languageCode: 'en',
                  },
                ],
              },
            },
          })
        )
      }

      if (url.startsWith('https://example.com/captions') && url.includes('fmt=json3')) {
        return Promise.resolve(new Response('nope', { status: 404 }))
      }

      if (url.startsWith('https://example.com/captions') && !url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response('<transcript><text>Hello &amp; world</text></transcript>', { status: 200 })
        )
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const transcript = await fetchTranscriptFromCaptionTracks(
      fetchMock as unknown as typeof fetch,
      {
        html,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
      }
    )

    expect(transcript).toBe('Hello & world')
  })
})
