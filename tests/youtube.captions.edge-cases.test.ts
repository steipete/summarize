import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptFromCaptionTracks } from '../packages/core/src/content/link-preview/transcript/providers/youtube/captions.js'

const jsonResponse = (payload: unknown, status = 200) => Response.json(payload, { status })

describe('YouTube captionTracks edge cases', () => {
  it('returns null when captions payload has no tracks and no Android API key exists', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{}}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }))

    const transcript = await fetchTranscriptFromCaptionTracks(
      fetchMock as unknown as typeof fetch,
      {
        html,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
      }
    )

    expect(transcript).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to XML URL when json3 is unparseable', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '</head><body></body></html>'

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
        return Promise.resolve(new Response('[]', { status: 200 }))
      }

      if (url === 'https://example.com/captions?lang=en') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              events: [{ segs: [{ utf8: 'From xml url' }] }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const transcript = await fetchTranscriptFromCaptionTracks(
      fetchMock as unknown as typeof fetch,
      {
        html,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
      }
    )

    expect(transcript).toBe('From xml url')
  })
})
