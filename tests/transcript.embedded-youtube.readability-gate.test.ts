import { describe, expect, it } from 'vitest'
import { extractEmbeddedYouTubeUrlFromHtml } from '../packages/core/src/content/transcript/utils.js'

describe('extractEmbeddedYouTubeUrlFromHtml (readability gate)', () => {
  it('blocks embed when readability length exceeds threshold', async () => {
    const longText = 'word '.repeat(800)
    const html = `<!doctype html><html><body>
      <article><p>${longText}</p></article>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    await expect(extractEmbeddedYouTubeUrlFromHtml(html, 2000, 2000)).resolves.toBeNull()
  })
})
