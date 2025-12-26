import { describe, expect, it } from 'vitest'

import {
  isAnubisHtml,
  toNitterUrls,
} from '../packages/core/src/content/link-preview/content/twitter-utils.js'

describe('toNitterUrls', () => {
  it('returns empty for non-twitter urls', () => {
    expect(toNitterUrls('https://example.com')).toEqual([])
  })

  it('returns a stable rotated list for twitter status urls', () => {
    const url = 'https://x.com/user/status/123'
    const first = toNitterUrls(url)
    const second = toNitterUrls(url)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)

    const hosts = new Set(first.map((item) => new URL(item).host))
    expect(hosts.size).toBe(first.length)

    for (const item of first) {
      expect(new URL(item).pathname).toBe('/user/status/123')
    }
  })
})

describe('isAnubisHtml', () => {
  it('detects Anubis challenge pages', () => {
    const html = '<html><body>Anubis – Proof-of-Work challenge. JShelter blocks this.</body></html>'
    expect(isAnubisHtml(html)).toBe(true)
  })

  it('does not flag unrelated content', () => {
    const html = '<html><body>Normal tweet content.</body></html>'
    expect(isAnubisHtml(html)).toBe(false)
  })
})
