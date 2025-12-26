import { describe, expect, it, vi } from 'vitest'
import { extractReadabilityFromHtml } from '../packages/core/src/content/link-preview/content/readability.js'

describe('readability (jsdom css parse noise)', () => {
  it('does not log "Could not parse CSS stylesheet"', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const html = `<!doctype html><html><head>
      <style>:root { --a: ; }</style>
    </head><body>
      <article><p>Hello world</p></article>
    </body></html>`

    const result = await extractReadabilityFromHtml(html, 'https://example.com')

    expect(result?.text).toContain('Hello world')
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
