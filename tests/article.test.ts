import { describe, expect, it } from 'vitest'

import {
  collectSegmentsFromHtml,
  extractArticleContent,
  sanitizeHtmlForMarkdownConversion,
} from '../packages/core/src/content/link-preview/content/article.js'

describe('article content extraction', () => {
  it('extracts headings, paragraphs, and list items with thresholds', () => {
    const html = `
      <html><body>
        <h1>Hi</h1>
        <h2>This is a heading</h2>
        <p>Short.</p>
        <p>This paragraph is long enough to be included in segments.</p>
        <ul>
          <li>Too short</li>
          <li>This list item is long enough to be included.</li>
        </ul>
      </body></html>
    `

    const segments = collectSegmentsFromHtml(html)
    expect(segments.join('\n')).toContain('This is a heading')
    expect(segments.join('\n')).toContain('This paragraph is long enough')
    expect(segments.join('\n')).toContain('• This list item is long enough')
    expect(segments.join('\n')).not.toContain('Short.')
  })

  it('falls back to body text when no segments exist', () => {
    const html = `<html><body><div>Just some text without allowed tags.</div></body></html>`
    const segments = collectSegmentsFromHtml(html)
    expect(segments.length).toBe(1)
    expect(segments[0]).toContain('Just some text')

    expect(extractArticleContent(html)).toContain('Just some text')
  })

  it('keeps headings as standalone segments', () => {
    const html = `
      <html><body>
        <p>This paragraph is long enough to be included in segments.</p>
        <h3>Tiny heading</h3>
      </body></html>
    `

    const segments = collectSegmentsFromHtml(html)
    expect(segments.length).toBe(2)
    expect(segments[0]).toContain('This paragraph is long enough')
    expect(segments[1]).toContain('Tiny heading')
  })

  it('sanitizes HTML for Markdown conversion and keeps href', () => {
    const html = `
      <html><body>
        <script>alert("x")</script>
        <a href="https://example.com" onclick="nope">Link</a>
      </body></html>
    `

    const sanitized = sanitizeHtmlForMarkdownConversion(html)
    expect(sanitized).toContain('href="https://example.com"')
    expect(sanitized).not.toContain('onclick=')
    expect(sanitized).not.toContain('<script')
  })
})
