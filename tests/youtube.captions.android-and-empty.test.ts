import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptFromCaptionTracks } from '../packages/core/src/content/link-preview/transcript/providers/youtube/captions.js'

const jsonResponse = (payload: unknown, status = 200) => Response.json(payload, { status })

describe('YouTube captionTracks Android fallback + empty-body branches', () => {
  it('returns null when Android player request is non-OK', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY"});</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('youtubei/v1/player')) {
        return Promise.resolve(jsonResponse({ error: 'nope' }, 403))
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

    expect(transcript).toBeNull()
  })

  it('returns null when Android player JSON is not an object', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY"});</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('youtubei/v1/player')) {
        return Promise.resolve(new Response(JSON.stringify('nope'), { status: 200 }))
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

    expect(transcript).toBeNull()
  })

  it('falls back to XML when json3 fetch returns an empty body (Android path)', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY"});</script>' +
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
        return Promise.resolve(new Response('', { status: 200 }))
      }

      if (url === 'https://example.com/captions?lang=en') {
        return Promise.resolve(
          new Response('<transcript><text>From xml</text><text>again</text></transcript>', {
            status: 200,
          })
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

    expect(transcript).toBe('From xml\nagain')
  })
})
