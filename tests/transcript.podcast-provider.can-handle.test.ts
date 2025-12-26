import { describe, expect, it } from 'vitest'

import { canHandle } from '../packages/core/src/content/link-preview/transcript/providers/podcast.js'

describe('podcast transcript provider - canHandle + RSS detection branches', () => {
  it('detects RSS/Atom/XML and common podcast hosts', () => {
    expect(
      canHandle({ url: 'https://example.com/feed.xml', html: '<rss></rss>', resourceKey: null })
    ).toBe(true)
    expect(
      canHandle({
        url: 'https://example.com/feed.xml',
        html: '<!doctype html><rss><channel/></rss>',
        resourceKey: null,
      })
    ).toBe(true)
    expect(
      canHandle({
        url: 'https://example.com/feed.xml',
        html: '<?xml version="1.0"?><rss><channel></channel></rss>',
        resourceKey: null,
      })
    ).toBe(true)
    expect(
      canHandle({
        url: 'https://example.com/atom.xml',
        html: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        resourceKey: null,
      })
    ).toBe(true)
    expect(
      canHandle({
        url: 'https://example.com/atom.xml',
        html: '<!doctype html><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        resourceKey: null,
      })
    ).toBe(true)

    expect(
      canHandle({ url: 'https://open.spotify.com/episode/abc', html: null, resourceKey: null })
    ).toBe(true)
    expect(
      canHandle({
        url: 'https://podcasts.apple.com/us/podcast/id123?i=456',
        html: null,
        resourceKey: null,
      })
    ).toBe(true)

    expect(canHandle({ url: 'https://example.com/podcast', html: null, resourceKey: null })).toBe(
      true
    )
    expect(canHandle({ url: 'https://example.com/article', html: null, resourceKey: null })).toBe(
      false
    )
  })
})
