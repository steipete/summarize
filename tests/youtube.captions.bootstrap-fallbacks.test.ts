import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptFromCaptionTracks } from '../packages/core/src/content/link-preview/transcript/providers/youtube/captions.js'

const jsonResponse = (payload: unknown, status = 200) => Response.json(payload, { status })

describe('YouTube captionTracks bootstrap fallbacks', () => {
  it('falls back to Android when bootstrap player POST is non-OK', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('youtubei/v1/player')) {
        const body = typeof init?.body === 'string' ? init.body : ''
        if (body.includes('"clientName":"WEB"')) {
          return Promise.resolve(jsonResponse({ error: 'nope' }, 403))
        }
        if (body.includes('"clientName":"ANDROID"')) {
          return Promise.resolve(
            jsonResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://example.com/captions?lang=en&fmt=srv3' }],
                },
              },
            })
          )
        }
      }
      if (url.startsWith('https://example.com/captions') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'OK' }] }] }), { status: 200 })
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

    expect(transcript).toBe('OK')
  })

  it('falls back to Android when bootstrap response JSON is unparseable', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('youtubei/v1/player')) {
        const body = typeof init?.body === 'string' ? init.body : ''
        if (body.includes('"clientName":"WEB"')) {
          return Promise.resolve(new Response('{not json', { status: 200 }))
        }
        if (body.includes('"clientName":"ANDROID"')) {
          return Promise.resolve(
            jsonResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://example.com/captions?lang=en&fmt=srv3' }],
                },
              },
            })
          )
        }
      }
      if (url.startsWith('https://example.com/captions') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'OK' }] }] }), { status: 200 })
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

    expect(transcript).toBe('OK')
  })

  it('parses JSON transcript payloads from the XML fallback URL', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
      '{"baseUrl":"https://example.com/captions?lang=en&fmt=srv3","languageCode":"en"}' +
      ']}}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.startsWith('https://example.com/captions') && url.includes('fmt=json3')) {
        return Promise.resolve(new Response('{"events":false}', { status: 200 }))
      }
      if (url === 'https://example.com/captions?lang=en') {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'From xml json' }] }] }), {
            status: 200,
          })
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

    expect(transcript).toBe('From xml json')
  })
})
