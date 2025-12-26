import { describe, expect, it } from 'vitest'
import { extractEmbeddedYouTubeUrlFromHtml } from '../packages/core/src/content/link-preview/transcript/utils.js'

describe('extractEmbeddedYouTubeUrlFromHtml (readability gating)', () => {
  it('allows embed when readability length is below threshold', async () => {
    const html = `<!doctype html><html><body>
      <article><p>Short article text.</p></article>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    await expect(extractEmbeddedYouTubeUrlFromHtml(html, 2000, 2000)).resolves.toBe(
      'https://www.youtube.com/watch?v=abcdefghijk'
    )
  })
})
