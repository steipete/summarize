import { describe, expect, it } from 'vitest'

import {
  extractYouTubeVideoId,
  isDirectMediaExtension,
  isDirectMediaUrl,
  isPodcastHost,
  isTwitterBroadcastUrl,
  isTwitterStatusUrl,
  isYouTubeUrl,
  isYouTubeVideoUrl,
  shouldPreferUrlMode,
} from '../packages/core/src/content/url.js'

describe('content/url', () => {
  it('detects YouTube hosts', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBe(false)
  })

  it('detects YouTube video URLs by id', () => {
    expect(isYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true)
    expect(isYouTubeVideoUrl('https://youtu.be/')).toBe(false)
    expect(isYouTubeVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
  })

  it('extracts YouTube video ids', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=1')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://youtu.be/')).toBeNull()
  })

  it('detects Twitter/X status URLs', () => {
    expect(isTwitterStatusUrl('https://x.com/user/status/123')).toBe(true)
    expect(isTwitterStatusUrl('https://twitter.com/user/status/123')).toBe(true)
    expect(isTwitterStatusUrl('https://x.com/home')).toBe(false)
  })

  it('detects Twitter/X broadcast URLs', () => {
    expect(isTwitterBroadcastUrl('https://x.com/i/broadcasts/1PlJQOpPLXXKE')).toBe(true)
    expect(isTwitterBroadcastUrl('https://twitter.com/i/broadcasts/abc123')).toBe(true)
    expect(isTwitterBroadcastUrl('https://x.com/i/spaces/1')).toBe(false)
  })

  it('detects direct media URLs', () => {
    expect(isDirectMediaUrl('https://example.com/video.mp4')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/audio.mp3?x=1')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/voice.ogg')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/voice.opus')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/clip.avi')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/track.wma#t=10')).toBe(true)
    expect(isDirectMediaUrl('https://example.com/article')).toBe(false)
  })

  it('detects direct media extensions', () => {
    expect(isDirectMediaExtension('.ogg')).toBe(true)
    expect(isDirectMediaExtension('MP4')).toBe(true)
    expect(isDirectMediaExtension('.txt')).toBe(false)
  })

  it('detects podcast hosts', () => {
    expect(isPodcastHost('https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5')).toBe(true)
    expect(isPodcastHost('https://podcasts.apple.com/us/podcast/foo/id123456789')).toBe(true)
    expect(isPodcastHost('https://example.com/podcast')).toBe(false)
  })

  it('prefers url mode for media-like urls', () => {
    expect(shouldPreferUrlMode('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(shouldPreferUrlMode('https://x.com/user/status/123')).toBe(true)
    expect(shouldPreferUrlMode('https://x.com/i/broadcasts/1PlJQOpPLXXKE')).toBe(true)
    expect(shouldPreferUrlMode('https://example.com/video.mp4')).toBe(true)
    expect(shouldPreferUrlMode('https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5')).toBe(
      true
    )
    expect(shouldPreferUrlMode('https://example.com/article')).toBe(false)
  })
})
