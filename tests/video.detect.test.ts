import { describe, expect, it } from 'vitest'

import { detectPrimaryVideoFromHtml } from '../packages/core/src/content/link-preview/content/video.js'

const BASE_URL = 'https://example.com/article'
const YT_ID = 'dQw4w9WgXcQ'

describe('detectPrimaryVideoFromHtml', () => {
  it('prefers YouTube embeds', () => {
    const html = `<iframe src="https://www.youtube.com/embed/${YT_ID}?rel=0"></iframe>`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${YT_ID}`,
    })
  })

  it('accepts youtu.be embeds', () => {
    const html = `<iframe src="https://youtu.be/${YT_ID}"></iframe>`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${YT_ID}`,
    })
  })

  it('skips invalid iframe src and falls back to OpenGraph', () => {
    const html = `<iframe src="http://[invalid"></iframe>
      <meta property="og:video" content="https://cdn.example.com/video.mp4">`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'direct',
      url: 'https://cdn.example.com/video.mp4',
    })
  })

  it('uses OpenGraph direct video URLs', () => {
    const html = `<meta property="og:video" content="https://cdn.example.com/video.mp4">`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'direct',
      url: 'https://cdn.example.com/video.mp4',
    })
  })

  it('accepts OpenGraph YouTube embeds', () => {
    const html = `<meta property="og:video:url" content="https://www.youtube.com/embed/${YT_ID}">`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${YT_ID}`,
    })
  })

  it('reads OpenGraph values from the value attribute', () => {
    const html = `<meta name="og:video" value="https://cdn.example.com/video.webm">`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'direct',
      url: 'https://cdn.example.com/video.webm',
    })
  })

  it('ignores non-video OpenGraph and falls back to video tag sources', () => {
    const html = `<meta property="og:video" content="https://cdn.example.com/not-video.txt">
      <video><source src="/assets/movie.mp4"></video>`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'direct',
      url: 'https://example.com/assets/movie.mp4',
    })
  })

  it('falls back to video tag sources', () => {
    const html = `<video src="/assets/movie.m4v"></video>`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toEqual({
      kind: 'direct',
      url: 'https://example.com/assets/movie.m4v',
    })
  })

  it('returns null for invalid YouTube embed ids', () => {
    const html = `<iframe src="https://www.youtube.com/embed/not-valid"></iframe>`
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toBeNull()
  })

  it('returns null when no usable video is present', () => {
    const html = '<div>No video here</div>'
    expect(detectPrimaryVideoFromHtml(html, BASE_URL)).toBeNull()
  })
})
