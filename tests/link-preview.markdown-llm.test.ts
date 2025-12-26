import { describe, expect, it, vi } from 'vitest'
import type { ConvertHtmlToMarkdown } from '../packages/core/src/content/link-preview/deps.js'
import { createLinkPreviewClient } from '../src/content/index.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('link preview extraction (LLM HTML→Markdown)', () => {
  it('uses the injected HTML→Markdown converter when format=markdown', async () => {
    const html =
      '<!doctype html><html><head><title>Hello</title></head><body><article><h1>Hello</h1><p>World</p><p><a href="https://example.com">Link</a></p></article></body></html>'

    const convertHtmlToMarkdownMock = vi.fn(
      async ({ html: sanitizedHtml }: Parameters<ConvertHtmlToMarkdown>[0]) => {
        expect(sanitizedHtml).toContain('<h1>')
        expect(sanitizedHtml).toContain('href=')
        return '# Hello\n\nWorld\n\n[Link](https://example.com)'
      }
    )

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
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
    })

    expect(result.diagnostics.strategy).toBe('html')
    expect(result.diagnostics.markdown.requested).toBe(true)
    expect(result.diagnostics.markdown.used).toBe(true)
    expect(result.diagnostics.markdown.provider).toBe('llm')
    expect(result.content).toContain('# Hello')
    expect(convertHtmlToMarkdownMock).toHaveBeenCalledTimes(1)
  })

  it('does not call the converter when format=text', async () => {
    const html = `<!doctype html><html><head><title>Hello</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    const convertHtmlToMarkdownMock = vi.fn(async () => '# Should not run')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      convertHtmlToMarkdown: convertHtmlToMarkdownMock as unknown as ConvertHtmlToMarkdown,
    })

    const result = await client.fetchLinkContent('https://example.com', {
      timeoutMs: 2000,
      firecrawl: 'off',
      format: 'text',
    })

    expect(result.diagnostics.strategy).toBe('html')
    expect(result.diagnostics.markdown.requested).toBe(false)
    expect(convertHtmlToMarkdownMock).not.toHaveBeenCalled()
  })
})
