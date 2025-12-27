import { describe, expect, it } from 'vitest'

import {
  extractTranscriptFromTranscriptEndpoint,
  extractYoutubeiBootstrap,
  extractYoutubeiTranscriptConfig,
  fetchTranscriptFromTranscriptEndpoint,
} from '../packages/core/src/content/transcript/providers/youtube/api.js'

describe('YouTube transcript parsing', () => {
  it('extracts youtubei transcript config from bootstrap HTML', () => {
    const html =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body></body></html>'

    const config = extractYoutubeiTranscriptConfig(html)
    expect(config).toEqual(
      expect.objectContaining({
        apiKey: 'TEST_KEY',
        params: 'TEST_PARAMS',
      })
    )
  })

  it('returns null for transcript config when bootstrap or params are missing', () => {
    expect(extractYoutubeiTranscriptConfig('<html></html>')).toBeNull()

    const missingParams =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '</head><body></body></html>'
    expect(extractYoutubeiTranscriptConfig(missingParams)).toBeNull()

    const missingContext =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":"nope"});</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body></body></html>'
    expect(extractYoutubeiTranscriptConfig(missingContext)).toBeNull()
  })

  it('prefers VISITOR_DATA and normalizes client name from bootstrap', () => {
    const html =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({' +
      '"INNERTUBE_API_KEY":"TEST_KEY",' +
      '"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0","visitorData":"CTX_VISITOR"}},' +
      '"VISITOR_DATA":"BOOTSTRAP_VISITOR",' +
      '"INNERTUBE_CONTEXT_CLIENT_NAME":1,' +
      '"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.0",' +
      '"PAGE_CL":123,' +
      '"PAGE_BUILD_LABEL":"test-label"' +
      '});</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body></body></html>'

    const config = extractYoutubeiTranscriptConfig(html)
    expect(config).toEqual(
      expect.objectContaining({
        apiKey: 'TEST_KEY',
        params: 'TEST_PARAMS',
        visitorData: 'BOOTSTRAP_VISITOR',
        clientName: '1',
        clientVersion: '2.0',
        pageCl: 123,
        pageLabel: 'test-label',
      })
    )
  })

  it('returns null when transcript payload is missing segments', () => {
    expect(extractTranscriptFromTranscriptEndpoint({ actions: [] })).toBeNull()
    expect(extractTranscriptFromTranscriptEndpoint(null)).toBeNull()
  })

  it('extracts transcript lines from youtubei payload', () => {
    const payload = {
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  transcriptSearchPanelRenderer: {
                    body: {
                      transcriptSegmentListRenderer: {
                        initialSegments: [
                          {
                            transcriptSegmentRenderer: {
                              snippet: { runs: [{ text: 'Line 1' }] },
                            },
                          },
                          {
                            transcriptSegmentRenderer: {
                              snippet: { runs: [{ text: 'Line 2' }] },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    }

    expect(extractTranscriptFromTranscriptEndpoint(payload)).toBe('Line 1\nLine 2')
  })

  it('fetches transcript endpoint and returns null for non-2xx/invalid JSON', async () => {
    const fetchOk = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      if (!url.includes('youtubei/v1/get_transcript')) {
        throw new Error(`Unexpected fetch call: ${url}`)
      }

      const headers = init?.headers as Record<string, string>
      expect(headers['X-Youtube-Client-Name']).toBe('1')
      expect(headers['X-Youtube-Client-Version']).toBe('2.0')
      expect(headers['X-Goog-Visitor-Id']).toBe('VISITOR')
      expect(headers['X-Youtube-Page-CL']).toBe('99')
      expect(headers['X-Youtube-Page-Label']).toBe('label')

      return Response.json(
        {
          actions: [
            {
              updateEngagementPanelAction: {
                content: {
                  transcriptRenderer: {
                    content: {
                      transcriptSearchPanelRenderer: {
                        body: {
                          transcriptSegmentListRenderer: {
                            initialSegments: [
                              {
                                transcriptSegmentRenderer: {
                                  snippet: { runs: [{ text: 'Hello' }] },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        { status: 200 }
      )
    }

    const config = {
      apiKey: 'TEST_KEY',
      context: { client: {} },
      params: 'P',
      clientName: '1',
      clientVersion: '2.0',
      visitorData: 'VISITOR',
      pageCl: 99,
      pageLabel: 'label',
    }

    const transcript = await fetchTranscriptFromTranscriptEndpoint(
      fetchOk as unknown as typeof fetch,
      {
        config,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      }
    )
    expect(transcript).toBe('Hello')

    const fetchNotOk = async () => new Response('nope', { status: 403 })
    expect(
      await fetchTranscriptFromTranscriptEndpoint(fetchNotOk as unknown as typeof fetch, {
        config,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      })
    ).toBeNull()

    const fetchBadJson = async () => new Response('nope', { status: 200 })
    expect(
      await fetchTranscriptFromTranscriptEndpoint(fetchBadJson as unknown as typeof fetch, {
        config,
        originalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      })
    ).toBeNull()
  })

  it('extracts youtubei bootstrap fields when present and returns null for invalid context', () => {
    const invalid =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({"INNERTUBE_CONTEXT":"nope"});</script>' +
      '</head><body></body></html>'
    expect(extractYoutubeiBootstrap(invalid)).toBeNull()

    const html =
      '<!doctype html><html><head>' +
      '<script>ytcfg.set({' +
      '"INNERTUBE_API_KEY":"TEST_KEY",' +
      '"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0","visitorData":"CTX_VISITOR"}},' +
      '"INNERTUBE_CLIENT_VERSION":"9.9",' +
      '"INNERTUBE_CONTEXT_CLIENT_NAME":"WEB",' +
      '"PAGE_CL":123,' +
      '"PAGE_BUILD_LABEL":"label",' +
      '"XSRF_TOKEN":"xsrf"' +
      '});</script>' +
      '</head><body></body></html>'

    const bootstrap = extractYoutubeiBootstrap(html)
    expect(bootstrap).toEqual(
      expect.objectContaining({
        apiKey: 'TEST_KEY',
        clientVersion: '9.9',
        clientName: 'WEB',
        visitorData: 'CTX_VISITOR',
        pageCl: 123,
        pageLabel: 'label',
        xsrfToken: 'xsrf',
      })
    )
  })
})
