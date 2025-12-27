import { describe, expect, it } from 'vitest'
import { extractEmbeddedYouTubeUrlFromHtml } from '../packages/core/src/content/transcript/utils.js'

describe('extractEmbeddedYouTubeUrlFromHtml', () => {
  it('returns a watch URL for a lightweight embed page', async () => {
    const html = `<!doctype html><html><body>
      <p>Episode page</p>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    await expect(extractEmbeddedYouTubeUrlFromHtml(html)).resolves.toBe(
      'https://www.youtube.com/watch?v=abcdefghijk'
    )
  })

  it('skips embed detection when the page has lots of text', async () => {
    const filler = 'lorem ipsum '.repeat(300)
    const html = `<!doctype html><html><body>
      <p>${filler}</p>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    await expect(extractEmbeddedYouTubeUrlFromHtml(html)).resolves.toBeNull()
  })

  it('handles og:video embed URLs', async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:video" content="//www.youtube.com/embed/abcdefghijk" />
    </head><body><p>Short page</p></body></html>`

    await expect(extractEmbeddedYouTubeUrlFromHtml(html)).resolves.toBe(
      'https://www.youtube.com/watch?v=abcdefghijk'
    )
  })
})
