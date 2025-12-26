import { describe, expect, it, vi } from 'vitest'
import type { ConvertHtmlToMarkdown } from '../packages/core/src/content/link-preview/deps.js'
import { createLinkPreviewClient } from '../src/content/index.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('link preview extraction (readability markdown)', () => {
  it('uses markdown conversion when markdownMode=readability', async () => {
    const html = `<!doctype html><html><head><title>Hello</title></head><body>
      <nav><ul><li>Nav Item</li></ul></nav>
      <article><h1>Hello</h1><p>Readable content</p></article>
    </body></html>`

    const convertHtmlToMarkdownMock = vi.fn(async () => '# Hello\n\nReadable content')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      convertHtmlToMarkdown: convertHtmlToMarkdownMock as unknown as ConvertHtmlToMarkdown,
    })

    const result = await client.fetchLinkContent('https://example.com', {
      timeoutMs: 2000,
      firecrawl: 'off',
      format: 'markdown',
      markdownMode: 'readability',
    })

    expect(result.content).toContain('# Hello')
    expect(result.diagnostics.markdown.used).toBe(true)
    expect(result.diagnostics.markdown.notes).toContain('Readability')
    expect(convertHtmlToMarkdownMock).toHaveBeenCalledTimes(1)
  })
})
