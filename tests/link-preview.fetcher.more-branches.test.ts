import { describe, expect, it, vi } from 'vitest'

import {
  fetchHtmlDocument,
  fetchWithFirecrawl,
} from '../packages/core/src/content/link-preview/content/fetcher.js'

describe('link preview fetcher - more branches', () => {
  it('throws on non-OK response and unsupported content-type', async () => {
    await expect(
      fetchHtmlDocument(
        vi.fn(
          async () =>
            new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } })
        ) as unknown as typeof fetch,
        'https://example.com'
      )
    ).rejects.toThrow(/status 403/)

    await expect(
      fetchHtmlDocument(
        vi.fn(
          async () =>
            new Response('nope', { status: 200, headers: { 'content-type': 'application/pdf' } })
        ) as unknown as typeof fetch,
        'https://example.com'
      )
    ).rejects.toThrow(/Unsupported content-type/)
  })

  it('handles missing body, streaming bodies, and abort errors', async () => {
    const events: Array<{ kind: string }> = []
    const fetchNoBody = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html', 'content-length': '3' }),
        body: null,
        async text() {
          return 'abc'
        },
      } as unknown as Response
    })
    const html = await fetchHtmlDocument(
      fetchNoBody as unknown as typeof fetch,
      'https://example.com',
      {
        onProgress: (e) => events.push(e as { kind: string }),
      }
    )
    expect(html).toBe('abc')
    expect(events.some((e) => e.kind === 'fetch-html-done')).toBe(true)

    const reader = (() => {
      let i = 0
      return {
        async read() {
          i += 1
          if (i === 1) return { done: false, value: undefined as unknown as Uint8Array }
          if (i === 2) return { done: false, value: new TextEncoder().encode('hi') }
          return { done: true, value: undefined as unknown as Uint8Array }
        },
      }
    })()
    const fetchStream = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: { getReader: () => reader },
      } as unknown as Response
    })
    const streamed = await fetchHtmlDocument(
      fetchStream as unknown as typeof fetch,
      'https://example.com'
    )
    expect(streamed).toContain('hi')

    const abortingFetch = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(
      fetchHtmlDocument(abortingFetch as unknown as typeof fetch, 'https://example.com', {
        timeoutMs: 1,
      })
    ).rejects.toThrow(/timed out/)
  })

  it('covers Firecrawl skip/no-config/no-payload/success/error branches', async () => {
    const progress: Array<{ kind: string; ok?: boolean }> = []
    const onProgress = (e: unknown) => progress.push(e as { kind: string; ok?: boolean })

    const youtube = await fetchWithFirecrawl('https://www.youtube.com/watch?v=abc', null, {
      onProgress,
    })
    expect(youtube.payload).toBeNull()
    expect(youtube.diagnostics.notes).toContain('Skipped Firecrawl')

    const noConfig = await fetchWithFirecrawl('https://example.com', null, { onProgress })
    expect(noConfig.payload).toBeNull()
    expect(noConfig.diagnostics.notes).toContain('not configured')

    const noPayload = await fetchWithFirecrawl(
      'https://example.com',
      vi.fn(async () => null) as unknown as NonNullable<Parameters<typeof fetchWithFirecrawl>[1]>,
      { onProgress, reason: 'test' }
    )
    expect(noPayload.payload).toBeNull()
    expect(progress.some((e) => e.kind === 'firecrawl-done' && e.ok === false)).toBe(true)

    const okPayload = await fetchWithFirecrawl(
      'https://example.com',
      vi.fn(async () => ({ markdown: '# hi', html: null })) as unknown as NonNullable<
        Parameters<typeof fetchWithFirecrawl>[1]
      >,
      { onProgress }
    )
    expect(okPayload.payload).not.toBeNull()
    expect(progress.some((e) => e.kind === 'firecrawl-done' && e.ok === true)).toBe(true)

    const okHtmlOnly = await fetchWithFirecrawl(
      'https://example.com',
      vi.fn(async () => ({ markdown: null, html: '<p>hi</p>' })) as unknown as NonNullable<
        Parameters<typeof fetchWithFirecrawl>[1]
      >,
      { onProgress, cacheMode: 'bypass' }
    )
    expect(okHtmlOnly.payload).not.toBeNull()
    expect(okHtmlOnly.diagnostics.cacheStatus).toBe('bypassed')

    const errorPayload = await fetchWithFirecrawl(
      'https://example.com',
      vi.fn(async () => {
        throw new Error('boom')
      }) as unknown as NonNullable<Parameters<typeof fetchWithFirecrawl>[1]>,
      { onProgress }
    )
    expect(errorPayload.payload).toBeNull()
    expect(errorPayload.diagnostics.notes).toContain('Firecrawl error')
  })
})
