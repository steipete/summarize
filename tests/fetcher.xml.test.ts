import { describe, expect, it, vi } from 'vitest'

import { fetchHtmlDocument } from '../packages/core/src/content/link-preview/content/fetcher.js'

describe('fetchHtmlDocument', () => {
  it('accepts RSS/XML content-types', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"></rss>`
    const fetchImpl = vi.fn(async () => {
      return new Response(xml, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      })
    }) as unknown as typeof fetch

    const out = await fetchHtmlDocument(fetchImpl, 'https://example.com/feed.xml', {
      timeoutMs: 1000,
      onProgress: null,
    })
    expect(out).toContain('<rss')
  })
})
