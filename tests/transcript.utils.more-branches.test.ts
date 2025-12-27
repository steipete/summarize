import { describe, expect, it } from 'vitest'

import {
  decodeHtmlEntities,
  extractYouTubeVideoId,
  extractYoutubeBootstrapConfig,
  isRecord,
  isYouTubeUrl,
  isYouTubeVideoUrl,
  sanitizeYoutubeJsonResponse,
} from '../packages/core/src/content/transcript/utils.js'

describe('transcript utils - more branches', () => {
  it('detects YouTube URLs even when URL parsing fails', () => {
    expect(isYouTubeUrl('not a url but has youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubeUrl('https://example.com')).toBe(false)
  })

  it('detects YouTube video URLs across common patterns', () => {
    expect(isYouTubeVideoUrl('https://youtu.be/abc')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/shorts/abc')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/embed/abc')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/v/abc')).toBe(true)
    expect(isYouTubeVideoUrl('not a url')).toBe(false)
  })

  it('extracts a validated YouTube video id (11 chars) from different URLs', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=too-short')).toBeNull()
    expect(extractYouTubeVideoId('not a url')).toBeNull()
  })

  it('sanitizes JSON responses with the XSSI prefix', () => {
    expect(sanitizeYoutubeJsonResponse('\n)]}\'\n{"ok":true}')).toBe('\n{"ok":true}')
    expect(sanitizeYoutubeJsonResponse(' {"ok":true}')).toBe('{"ok":true}')
  })

  it('decodes common HTML entities', () => {
    expect(decodeHtmlEntities('a&amp;b &lt; &gt; &quot;x&quot; &#39;y&#39;')).toBe(
      'a&b < > "x" \'y\''
    )
  })

  it('parses ytcfg.set and var ytcfg bootstrap configs', () => {
    const config1 = extractYoutubeBootstrapConfig(
      `<script>ytcfg.set({"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_NAME":"WEB"})</script>`
    )
    expect(isRecord(config1)).toBe(true)
    expect(config1?.INNERTUBE_API_KEY).toBe('k')

    const config2 = extractYoutubeBootstrapConfig(
      `var ytcfg = {"INNERTUBE_API_KEY":"k2","X": {"a": 1}};`
    )
    expect(isRecord(config2)).toBe(true)
    expect(config2?.INNERTUBE_API_KEY).toBe('k2')
  })

  it('ignores invalid ytcfg JSON and returns null', () => {
    expect(extractYoutubeBootstrapConfig('<script>ytcfg.set({nope)</script>')).toBeNull()
    expect(extractYoutubeBootstrapConfig('var ytcfg = {nope')).toBeNull()
  })
})
