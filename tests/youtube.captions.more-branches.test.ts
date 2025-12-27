import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptFromCaptionTracks } from '../packages/core/src/content/transcript/providers/youtube/captions.js'

const jsonResponse = (payload: unknown, status = 200) => Response.json(payload, { status })

describe('YouTube captionTracks extra branches', () => {
  it('extracts transcript from ytInitialPlayerResponse captionTracks (JSON)', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
      '{"languageCode":"en","kind":"asr"},' +
      '{"languageCode":"en","baseUrl":"https://example.com/captions"} ,' +
      '{"languageCode":"de","url":"https://example.com/captions-de"}' +
      ']}}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url

      if (url.startsWith('https://example.com/captions') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              events: [
                { segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
                { segs: [{ utf8: '   ' }] },
                { foo: 'bar' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }

      if (url.startsWith('https://example.com/captions-de') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'Hallo' }] }] }), { status: 200 })
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

    expect(transcript).toBe('Hello world')
  })

  it('prefers manual captions over ASR for the same language', async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
      '{"languageCode":"en","kind":"asr","baseUrl":"https://example.com/captions-asr"},' +
      '{"languageCode":"en","baseUrl":"https://example.com/captions-manual"}' +
      ']}}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : input.url

      if (url.startsWith('https://example.com/captions-asr') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'Auto' }] }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }

      if (url.startsWith('https://example.com/captions-manual') && url.includes('fmt=json3')) {
        return Promise.resolve(
          new Response(JSON.stringify({ events: [{ segs: [{ utf8: 'Manual' }] }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
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

    expect(transcript).toBe('Manual')
  })

  it('handles invalid baseUrl and falls back to XML via string URL builder', async () => {
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
                captionTracks: [{ baseUrl: 'not a url', languageCode: 'en', kind: 'asr' }],
              },
            },
          })
        )
      }

      if (url.startsWith('not a url') && url.includes('fmt=json3')) {
        return Promise.resolve(new Response('nope', { status: 404 }))
      }

      if (url === 'not a url') {
        return Promise.resolve(
          new Response(
            '<transcript><text>Hello &amp; world</text><text>again</text></transcript>',
            {
              status: 200,
            }
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

    expect(transcript).toBe('Hello & world\nagain')
  })
})
