import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { resolveSlideSourceFromUrl } from '../src/slides/index.js'

describe('resolveSlideSourceFromUrl', () => {
  it('prefixes YouTube ids for slide folders', () => {
    const source = resolveSlideSourceFromUrl('https://www.youtube.com/watch?v=abc123def45')
    expect(source?.sourceId).toBe('youtube-abc123def45')
  })

  it('builds direct source ids from host + basename + hash', () => {
    const url = 'https://cdn.example.com/videos/Hello%20World.mp4'
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
    const source = resolveSlideSourceFromUrl(url)
    expect(source?.sourceId).toBe(`cdn-example-com-hello-20world-${hash}`)
  })
})
