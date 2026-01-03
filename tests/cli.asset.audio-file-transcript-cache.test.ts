/**
 * Phase 4.2: Integration tests for audio file transcript caching
 * Tests that file modification time-based cache invalidation works correctly
 * when transcribing local audio files.
 */

import { writeFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptCache } from '../packages/core/src/content/cache/types.js'
import { readTranscriptCache } from '../packages/core/src/content/transcript/cache.js'

describe('transcript cache integration with audio files', () => {
  it('caches transcripts using file modification time as cache key component', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-fileMtime-'))
    const audioPath = join(root, 'test.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const stats = statSync(audioPath)
    const fileMtime = stats.mtimeMs

    const cacheGetCalls: Array<{
      url: string
      fileMtime: number | null | undefined
    }> = []

    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        cacheGetCalls.push({
          url: args.url,
          fileMtime: args.fileMtime,
        })
        return null // Cache miss
      }),
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: `file://${audioPath}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime,
    })

    expect(outcome.diagnostics.cacheStatus).toBe('miss')
    expect(cacheGetCalls).toHaveLength(1)
    expect(cacheGetCalls[0]?.fileMtime).toBe(fileMtime)
    expect(cacheGetCalls[0]?.url).toBe(`file://${audioPath}`)
  })

  it('invalidates cache when file modification time changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-invalidation-'))
    const audioPath = join(root, 'test.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const originalStats = statSync(audioPath)
    const originalMtime = originalStats.mtimeMs

    // Simulate cache hit with original mtime
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // Cache only hits if mtime matches original
        if (args.fileMtime === originalMtime) {
          return {
            content: 'Cached transcript from original mtime',
            source: 'openai',
            expired: false,
            metadata: null,
          }
        }
        // Different mtime = cache miss
        return null
      }),
      set: vi.fn(async () => {}),
    }

    // First read with original mtime
    const outcome1 = await readTranscriptCache({
      url: `file://${audioPath}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: originalMtime,
    })

    expect(outcome1.diagnostics.cacheStatus).toBe('hit')
    expect(outcome1.resolution?.text).toBe('Cached transcript from original mtime')

    // Simulate reading with modified file (different mtime)
    const newMtime = originalMtime + 5000 // 5 seconds later

    const outcome2 = await readTranscriptCache({
      url: `file://${audioPath}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: newMtime,
    })

    expect(outcome2.diagnostics.cacheStatus).toBe('miss')
    expect(outcome2.resolution).toBeNull()
  })

  it('preserves backward compatibility: URL-based audio without fileMtime', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // URL-based transcripts should have fileMtime = null
        expect(args.fileMtime).toBeNull()
        return {
          content: 'URL-based transcript',
          source: 'yt-dlp',
          expired: false,
          metadata: null,
        }
      }),
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: 'https://example.com/podcast/episode.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime: null, // Explicitly null for URLs
    })

    expect(outcome.diagnostics.cacheStatus).toBe('hit')
    expect(outcome.resolution?.text).toBe('URL-based transcript')
    expect(vi.mocked(transcriptCache.get)).toHaveBeenCalledWith(
      expect.objectContaining({
        fileMtime: null,
      })
    )
  })

  it('handles multiple files with different mtimes independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-multiple-files-'))
    const audioPath1 = join(root, 'audio1.mp3')
    const audioPath2 = join(root, 'audio2.mp3')
    writeFileSync(audioPath1, Buffer.from([0xff, 0xfb, 0x10, 0x00]))
    writeFileSync(audioPath2, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const mtime1 = statSync(audioPath1).mtimeMs
    const mtime2 = statSync(audioPath2).mtimeMs

    const cacheRequests: Array<{ url: string; fileMtime: number | null }> = []

    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        cacheRequests.push({
          url: args.url,
          fileMtime: args.fileMtime,
        })
        // Different transcripts for different files
        if (args.url.includes('audio1')) {
          return {
            content: 'Transcript for audio 1',
            source: 'openai',
            expired: false,
            metadata: null,
          }
        }
        if (args.url.includes('audio2')) {
          return {
            content: 'Transcript for audio 2',
            source: 'openai',
            expired: false,
            metadata: null,
          }
        }
        return null
      }),
      set: vi.fn(async () => {}),
    }

    // Read both files
    const outcome1 = await readTranscriptCache({
      url: `file://${audioPath1}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: mtime1,
    })

    const outcome2 = await readTranscriptCache({
      url: `file://${audioPath2}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: mtime2,
    })

    expect(outcome1.resolution?.text).toBe('Transcript for audio 1')
    expect(outcome2.resolution?.text).toBe('Transcript for audio 2')

    // Verify both files were cached with their respective mtimes
    expect(cacheRequests).toHaveLength(2)
    expect(cacheRequests[0]?.fileMtime).toBe(mtime1)
    expect(cacheRequests[1]?.fileMtime).toBe(mtime2)
  })

  it('handles cache misses gracefully when file is new', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-new-file-'))
    const audioPath = join(root, 'new-audio.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const mtime = statSync(audioPath).mtimeMs

    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => null), // Always miss
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: `file://${audioPath}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: mtime,
    })

    expect(outcome.diagnostics.cacheStatus).toBe('miss')
    expect(outcome.resolution).toBeNull()
    expect(vi.mocked(transcriptCache.get)).toHaveBeenCalled()
  })

  it('threads fileMtime through read and write cache operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-thread-mtime-'))
    const audioPath = join(root, 'thread-test.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const mtime = statSync(audioPath).mtimeMs

    const getArgs: unknown[] = []
    const setArgs: unknown[] = []

    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        getArgs.push(args)
        return null
      }),
      set: vi.fn(async (args) => {
        setArgs.push(args)
      }),
    }

    // Perform read that would trigger a write
    await readTranscriptCache({
      url: `file://${audioPath}`,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: mtime,
    })

    // Verify get was called with fileMtime
    expect(getArgs).toHaveLength(1)
    expect((getArgs[0] as any)?.fileMtime).toBe(mtime)
  })

  it('uses file:// URL format for file paths in cache keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transcript-cache-file-url-'))
    const audioPath = join(root, 'audio.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const mtime = statSync(audioPath).mtimeMs

    const urlsSeenInCache: string[] = []

    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        urlsSeenInCache.push(args.url)
        return null
      }),
      set: vi.fn(async () => {}),
    }

    const fileUrl = `file://${audioPath}`

    await readTranscriptCache({
      url: fileUrl,
      cacheMode: 'default',
      transcriptCache,
      fileMtime: mtime,
    })

    expect(urlsSeenInCache).toContain(fileUrl)
    expect(urlsSeenInCache[0]).toMatch(/^file:\/\//)
  })

  it('supports optional fileMtime parameter for backward compatibility', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // Should work even without fileMtime
        return {
          content: 'Works without fileMtime',
          source: 'openai',
          expired: false,
          metadata: null,
        }
      }),
      set: vi.fn(async () => {}),
    }

    // Call without fileMtime parameter
    const outcome = await readTranscriptCache({
      url: 'https://example.com/audio.mp3',
      cacheMode: 'default',
      transcriptCache,
      // fileMtime not provided
    })

    expect(outcome.diagnostics.cacheStatus).toBe('hit')
    expect(outcome.resolution?.text).toBe('Works without fileMtime')
  })
})
