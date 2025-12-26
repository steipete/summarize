import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'

import { extractReadabilityFromHtml } from '../packages/core/src/content/link-preview/content/readability.js'

describe('readability (large inline CSS)', () => {
  it('does not get stuck parsing inline <style>', async () => {
    const cssRule =
      '@font-face{font-family:Space Grotesk;font-style:normal;font-weight:300 700;font-display:swap;src:url(/a.woff2)format("woff2");unicode-range:U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329;}'
    const css = cssRule.repeat(2500) // ~500KB of CSS source
    const html = `<!doctype html><html><head><style>${css}</style></head><body>
      <article><h1>Title</h1><p>Hello world</p></article>
    </body></html>`

    const start = performance.now()
    const result = await extractReadabilityFromHtml(html, 'https://example.com')
    const durationMs = performance.now() - start

    expect(result?.text).toContain('Hello world')
    expect(durationMs).toBeLessThan(5000)
  }, 15_000)
})
