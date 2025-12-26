import { describe, expect, it, vi } from 'vitest'
import type { TranscriptCache } from '../packages/core/src/content/link-preview/deps.js'
import {
  DEFAULT_TTL_MS,
  mapCachedSource,
  NEGATIVE_TTL_MS,
  readTranscriptCache,
  writeTranscriptCache,
} from '../packages/core/src/content/link-preview/transcript/cache.js'

describe('transcript cache - more branches', () => {
  it('reads cache miss / bypass / expired / hit', async () => {
    const miss = await readTranscriptCache({
      url: 'u',
      cacheMode: 'default',
      transcriptCache: null,
    })
    expect(miss.cached).toBeNull()
    expect(miss.diagnostics.cacheStatus).toBe('miss')

    const cache: TranscriptCache = {
      get: vi.fn(async (_args: { url: string }) => ({
        content: 'hi',
        source: 'youtubei',
        expired: false,
        metadata: { a: 1 },
      })),
      set: vi.fn(async () => {}),
    }

    const bypass = await readTranscriptCache({
      url: 'u',
      cacheMode: 'bypass',
      transcriptCache: cache,
    })
    expect(bypass.cached).not.toBeNull()
    expect(bypass.resolution).toBeNull()
    expect(bypass.diagnostics.cacheStatus).toBe('bypassed')
    expect(bypass.diagnostics.notes).toContain('Cache bypass requested')

    cache.get.mockResolvedValueOnce({
      content: 'hi',
      source: 'captionTracks',
      expired: true,
      metadata: null,
    })
    const expired = await readTranscriptCache({
      url: 'u',
      cacheMode: 'default',
      transcriptCache: cache,
    })
    expect(expired.diagnostics.cacheStatus).toBe('expired')
    expect(expired.resolution).toBeNull()

    cache.get.mockResolvedValueOnce({
      content: 'hi',
      source: 'captionTracks',
      expired: false,
      metadata: null,
    })
    const hit = await readTranscriptCache({
      url: 'u',
      cacheMode: 'default',
      transcriptCache: cache,
    })
    expect(hit.diagnostics.cacheStatus).toBe('hit')
    expect(hit.resolution?.text).toBe('hi')
    expect(hit.resolution?.source).toBe('captionTracks')

    cache.get.mockResolvedValueOnce({
      content: '',
      source: 'weird',
      expired: false,
      metadata: null,
    })
    const empty = await readTranscriptCache({
      url: 'u',
      cacheMode: 'default',
      transcriptCache: cache,
    })
    expect(empty.diagnostics.textProvided).toBe(false)
    expect(empty.resolution?.source).toBe('unknown')
  })

  it('maps cached sources, including unknown values', () => {
    expect(mapCachedSource(null)).toBeNull()
    expect(mapCachedSource('yt-dlp')).toBe('yt-dlp')
    expect(mapCachedSource('weird')).toBe('unknown')
  })

  it('writes cache entries with correct TTL + resolved source', async () => {
    const cache: TranscriptCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    }

    await writeTranscriptCache({
      url: 'u',
      service: 'svc',
      resourceKey: null,
      result: { text: 'hi', source: 'youtubei' },
      transcriptCache: null,
    })

    await writeTranscriptCache({
      url: 'u',
      service: 'svc',
      resourceKey: null,
      result: { text: null, source: null },
      transcriptCache: cache,
    })
    expect(cache.set).not.toHaveBeenCalled()

    await writeTranscriptCache({
      url: 'u',
      service: 'svc',
      resourceKey: null,
      result: { text: null, source: 'youtubei' },
      transcriptCache: cache,
    })
    expect(cache.set).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: NEGATIVE_TTL_MS, source: 'youtubei', content: null })
    )

    await writeTranscriptCache({
      url: 'u',
      service: 'svc',
      resourceKey: null,
      result: { text: 'hi', source: null, metadata: { x: 1 } },
      transcriptCache: cache,
    })
    expect(cache.set).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlMs: DEFAULT_TTL_MS,
        source: 'unknown',
        content: 'hi',
        metadata: { x: 1 },
      })
    )
  })
})
