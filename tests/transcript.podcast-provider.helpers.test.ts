import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { __test__ } from '../packages/core/src/content/transcript/providers/podcast.js'

describe('podcast transcript provider - helper branches', () => {
  it('parses and normalizes headers', () => {
    expect(__test__.normalizeHeaderType(null)).toBeNull()
    expect(__test__.normalizeHeaderType('   ')).toBeNull()
    expect(__test__.normalizeHeaderType('Audio/MPEG; charset=utf-8')).toBe('audio/mpeg')

    expect(__test__.parseContentLength(null)).toBeNull()
    expect(__test__.parseContentLength('0')).toBeNull()
    expect(__test__.parseContentLength('12.3')).toBe(12)
    expect(__test__.parseContentLength('123')).toBe(123)
    expect(__test__.parseContentLength('NaN')).toBeNull()
  })

  it('extracts filenames from URLs (including invalid URLs)', () => {
    expect(__test__.filenameFromUrl('https://example.com/path/episode.mp3')).toBe('episode.mp3')
    expect(__test__.filenameFromUrl('https://example.com/path/')).toBeNull()
    expect(__test__.filenameFromUrl('not a url')).toBeNull()
  })

  it('detects blocked HTML (but treats __NEXT_DATA__ as not blocked)', () => {
    expect(__test__.looksLikeBlockedHtml('<html><body>captcha</body></html>')).toBe(true)
    expect(
      __test__.looksLikeBlockedHtml(
        '<script id="__NEXT_DATA__">{"ok":true}</script><body>captcha</body>'
      )
    ).toBe(false)
  })

  it('parses common itunes:duration formats', () => {
    const item = (duration: string) =>
      `<item><title>Ep</title><itunes:duration>${duration}</itunes:duration><enclosure url="https://example.com/ep.mp3" type="audio/mpeg"/></item>`

    expect(__test__.extractItemDurationSeconds(item('44'))).toBe(44)
    expect(__test__.extractItemDurationSeconds(item('1:02'))).toBe(62)
    expect(__test__.extractItemDurationSeconds(item('01:02:03'))).toBe(3723)
    expect(__test__.extractItemDurationSeconds(item('00:00'))).toBeNull()
    expect(__test__.extractItemDurationSeconds(item('nope'))).toBeNull()
  })

  it('finds matching RSS enclosure by normalized title', () => {
    const feed = `
<rss><channel>
  <item>
    <title><![CDATA[Hello – World]]></title>
    <itunes:duration>1:02</itunes:duration>
    <enclosure url="https://example.com/ep.mp3?x=1&amp;y=2" type="audio/mpeg"/>
  </item>
</channel></rss>`.trim()

    const match = __test__.extractEnclosureForEpisode(feed, 'Hello - World')
    expect(match).toEqual({
      enclosureUrl: 'https://example.com/ep.mp3?x=1&amp;y=2',
      durationSeconds: 62,
    })
    expect(__test__.extractEnclosureForEpisode(feed, 'Other')).toBeNull()
  })

  it('probeRemoteMedia returns best-effort defaults on HEAD failure (including invalid URL)', async () => {
    const okFetch = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '2048', 'content-type': 'audio/mpeg; charset=utf-8' },
      })
    })
    const ok = await __test__.probeRemoteMedia(
      okFetch as unknown as typeof fetch,
      'https://example.com/ep.mp3'
    )
    expect(ok.contentLength).toBe(2048)
    expect(ok.mediaType).toBe('audio/mpeg')
    expect(ok.filename).toBe('ep.mp3')

    const throwingFetch = vi.fn(async () => {
      throw new Error('no head')
    })
    const fallback = await __test__.probeRemoteMedia(
      throwingFetch as unknown as typeof fetch,
      'https://example.com/ep.mp3'
    )
    expect(fallback.contentLength).toBeNull()
    expect(fallback.mediaType).toBeNull()
    expect(fallback.filename).toBe('ep.mp3')

    const invalid = await __test__.probeRemoteMedia(
      throwingFetch as unknown as typeof fetch,
      'not a url'
    )
    expect(invalid.filename).toBeNull()
  })

  it('downloadCappedBytes handles non-OK and non-stream bodies', async () => {
    await expect(
      __test__.downloadCappedBytes(
        vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch,
        'https://example.com/ep.mp3',
        10,
        null
      )
    ).rejects.toThrow(/Download failed \(403\)/)

    const fetchNoBody = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3, 4, 5]).buffer
        },
      } as unknown as Response
    })
    const bytes = await __test__.downloadCappedBytes(
      fetchNoBody as unknown as typeof fetch,
      'https://example.com/ep.mp3',
      3,
      null
    )
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('downloadToFile throws on non-OK responses and writes when body is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-podcast-dl-'))
    const filePath = join(root, 'episode.bin')

    await expect(
      __test__.downloadToFile(
        vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
        'https://example.com/ep.mp3',
        filePath,
        null
      )
    ).rejects.toThrow(/Download failed \(401\)/)

    const fetchNoBody = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        async arrayBuffer() {
          return new Uint8Array([9, 8, 7]).buffer
        },
      } as unknown as Response
    })
    const written = await __test__.downloadToFile(
      fetchNoBody as unknown as typeof fetch,
      'https://example.com/ep.mp3',
      filePath,
      null
    )
    expect(written).toBe(3)
    const disk = await fs.readFile(filePath)
    expect(Array.from(disk)).toEqual([9, 8, 7])
  })
})
