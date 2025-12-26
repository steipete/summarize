import { describe, expect, it, vi } from 'vitest'

import {
  fetchHtmlDocument,
  fetchWithFirecrawl,
} from '../packages/core/src/content/link-preview/content/fetcher.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('link preview fetcher', () => {
  it('throws when HTML response is non-2xx', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('<html></html>', 403))
    await expect(
      fetchHtmlDocument(fetchMock as unknown as typeof fetch, 'https://example.com')
    ).rejects.toThrow('Failed to fetch HTML document (status 403)')
  })

  it('throws a timeout error when HTML fetch is aborted', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          if (!signal) {
            reject(new Error('Missing abort signal'))
            return
          }
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }) as Promise<Response>
      })

      const promise = fetchHtmlDocument(
        fetchMock as unknown as typeof fetch,
        'https://example.com',
        {
          timeoutMs: 10,
        }
      )
      const assertion = expect(promise).rejects.toThrow('Fetching HTML document timed out')
      await vi.advanceTimersByTimeAsync(20)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips Firecrawl for YouTube URLs', async () => {
    const scrape = vi.fn(async () => ({
      markdown: '# nope',
      html: null,
      metadata: null,
    }))

    const result = await fetchWithFirecrawl(
      'https://www.youtube.com/watch?v=abcdefghijk',
      scrape as unknown as typeof scrape
    )

    expect(result.payload).toBeNull()
    expect(result.diagnostics.attempted).toBe(false)
    expect(result.diagnostics.notes).toContain('Skipped Firecrawl for YouTube URL')
  })

  it('returns diagnostics when Firecrawl is not configured', async () => {
    const result = await fetchWithFirecrawl('https://example.com', null)
    expect(result.payload).toBeNull()
    expect(result.diagnostics.attempted).toBe(false)
    expect(result.diagnostics.notes).toContain('Firecrawl is not configured')
  })

  it('records diagnostics when Firecrawl returns null', async () => {
    const scrape = vi.fn(async () => null)
    const result = await fetchWithFirecrawl('https://example.com', scrape, { timeoutMs: 1 })
    expect(result.payload).toBeNull()
    expect(result.diagnostics.attempted).toBe(true)
    expect(result.diagnostics.notes).toContain('Firecrawl returned no content payload')
  })

  it('records diagnostics when Firecrawl throws', async () => {
    const scrape = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await fetchWithFirecrawl('https://example.com', scrape, { timeoutMs: 1 })
    expect(result.payload).toBeNull()
    expect(result.diagnostics.attempted).toBe(true)
    expect(result.diagnostics.notes).toContain('Firecrawl error: boom')
  })
})
