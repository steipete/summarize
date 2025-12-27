import { describe, expect, it, vi } from 'vitest'

import { fetchTranscriptWithApify } from '../packages/core/src/content/transcript/providers/youtube/apify.js'

describe('YouTube Apify transcript provider', () => {
  it('returns null when token is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }))
    expect(
      await fetchTranscriptWithApify(fetchMock as unknown as typeof fetch, null, 'url')
    ).toBeNull()
  })

  it('supports Pinto Studio dataset format', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        [
          {
            data: [
              { start: '0', dur: '1', text: ' Line 1 ' },
              { start: '1', dur: '1', text: 'Line 2' },
            ],
          },
        ],
        { status: 200 }
      )
    )

    expect(
      await fetchTranscriptWithApify(
        fetchMock as unknown as typeof fetch,
        'TOKEN',
        'https://youtu.be/x'
      )
    ).toBe('Line 1\nLine 2')
  })

  it('returns null for non-2xx and non-array payloads', async () => {
    const fetchNotOk = vi.fn(async () => new Response('nope', { status: 401 }))
    expect(
      await fetchTranscriptWithApify(fetchNotOk as unknown as typeof fetch, 'TOKEN', 'url')
    ).toBeNull()

    const fetchNotArray = vi.fn(async () => Response.json({ ok: true }, { status: 200 }))
    expect(
      await fetchTranscriptWithApify(fetchNotArray as unknown as typeof fetch, 'TOKEN', 'url')
    ).toBeNull()
  })
})
