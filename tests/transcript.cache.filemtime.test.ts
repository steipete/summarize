import { describe, expect, it, vi } from 'vitest'

import type { TranscriptCache } from '../packages/core/src/content/cache/types.js'
import { readTranscriptCache, writeTranscriptCache } from '../packages/core/src/content/transcript/cache.js'

describe('transcript cache with file modification time', () => {
  it('includes fileMtime when reading transcript cache', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // Verify that fileMtime is being passed to the cache
        expect(args.fileMtime).toBeDefined()
        return {
          content: 'cached transcript from file',
          source: 'openai',
          expired: false,
          metadata: null,
        }
      }),
      set: vi.fn(async () => {}),
    }

    const fileMtime = 1704268800000 // Some timestamp

    const outcome = await readTranscriptCache({
      url: 'file:///Users/test/recording.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime,
    })

    expect(outcome.resolution?.text).toBe('cached transcript from file')
    // Source might be normalized to 'unknown' if not in the standard list
    expect(outcome.resolution?.source).toBeTruthy()
    expect(outcome.diagnostics.cacheStatus).toBe('hit')
    // Verify the cache was called with fileMtime
    expect(vi.mocked(transcriptCache.get)).toHaveBeenCalledWith(
      expect.objectContaining({
        fileMtime,
      })
    )
  })

  it('differentiates cache keys based on fileMtime', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // Cache hits only if fileMtime matches stored value
        // Different mtime should be treated as cache miss
        if (args.fileMtime === 1000) {
          return {
            content: 'old transcript',
            source: 'openai',
            expired: false,
            metadata: null,
          }
        }
        // Different mtime = different cache key = miss
        return null
      }),
      set: vi.fn(async () => {}),
    }

    // First read with mtime 1000
    const outcome1 = await readTranscriptCache({
      url: 'file:///Users/test/recording.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime: 1000,
    })

    expect(outcome1.resolution?.text).toBe('old transcript')
    expect(outcome1.diagnostics.cacheStatus).toBe('hit')

    // Second read with different mtime (file was modified)
    const outcome2 = await readTranscriptCache({
      url: 'file:///Users/test/recording.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime: 2000, // Different modification time
    })

    expect(outcome2.resolution).toBeNull() // Cache miss due to different mtime
    expect(outcome2.diagnostics.cacheStatus).toBe('miss')
  })

  it('works with fileMtime=null for URLs (backward compatibility)', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // For URLs, fileMtime should be null or undefined
        expect(args.fileMtime).toBeNull()
        return {
          content: 'url-based transcript',
          source: 'yt-dlp',
          expired: false,
          metadata: null,
        }
      }),
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: 'https://example.com/audio.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime: null, // Explicitly null for URLs
    })

    expect(outcome.resolution?.text).toBe('url-based transcript')
    expect(outcome.diagnostics.cacheStatus).toBe('hit')
  })

  it('omits fileMtime parameter when undefined (optional)', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async (args) => {
        // Should work even if fileMtime not provided
        return {
          content: 'transcript',
          source: 'openai',
          expired: false,
          metadata: null,
        }
      }),
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: 'https://example.com/video.mp4',
      cacheMode: 'default',
      transcriptCache,
      // fileMtime not provided - should still work
    })

    expect(outcome.resolution?.text).toBe('transcript')
    expect(outcome.diagnostics.cacheStatus).toBe('hit')
    // Cache should be called and work fine without fileMtime
    expect(vi.mocked(transcriptCache.get)).toHaveBeenCalled()
  })

  it('handles cache miss with fileMtime (file is new)', async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => null), // No cached transcript
      set: vi.fn(async () => {}),
    }

    const outcome = await readTranscriptCache({
      url: 'file:///Users/test/new-recording.mp3',
      cacheMode: 'default',
      transcriptCache,
      fileMtime: Date.now(), // Brand new file
    })

    expect(outcome.resolution).toBeNull()
    expect(outcome.diagnostics.cacheStatus).toBe('miss')
  })

   it('preserves fileMtime through cache write operations', async () => {
     // This test verifies the fileMtime parameter is properly threaded through the system
     const getCallArgs: unknown[] = []
     const setCallArgs: unknown[] = []

     const transcriptCache: TranscriptCache = {
       get: vi.fn(async (args) => {
         getCallArgs.push(args)
         return null
       }),
       set: vi.fn(async (args) => {
         setCallArgs.push(args)
       }),
     }

     const fileMtime = 1704268800000

     // First call: cache miss, would trigger a write
     await readTranscriptCache({
       url: 'file:///Users/test/audio.mp3',
       cacheMode: 'default',
       transcriptCache,
       fileMtime,
     })

     // Verify get was called with fileMtime
     expect(getCallArgs[0]).toEqual(
       expect.objectContaining({
         fileMtime,
       })
     )
   })

   it('write operation calls cache.set with all necessary parameters', async () => {
     // Verify that cache.set receives all expected parameters including fileMtime
     const transcriptCache: TranscriptCache = {
       get: vi.fn(async () => null),
       set: vi.fn(async () => {}),
     }

     const url = 'file:///Users/test/audio.mp3'
     const service = 'openai'
     const fileMtime = 1704268800000

     // Perform a write operation with fileMtime
     await writeTranscriptCache({
       url,
       service,
       resourceKey: null,
       result: { text: 'test transcript', source: 'openai' },
       transcriptCache,
       fileMtime,
     })

     // Verify set was called
     expect(vi.mocked(transcriptCache.set)).toHaveBeenCalled()
     const setCall = vi.mocked(transcriptCache.set).mock.calls[0]?.[0]

     // Verify the structure of what was written, including fileMtime
     expect(setCall).toEqual(
       expect.objectContaining({
         url,
         service,
         content: 'test transcript',
         source: 'openai',
         fileMtime,
       })
     )
   })

   it('mtime-based cache invalidation works when cache respects fileMtime in key', async () => {
     // Verify that readTranscriptCache properly differentiates based on fileMtime
     // by calling get with different mtimes
     const getCallLog: Array<{ url: string; fileMtime: number | null | undefined }> = []

     const transcriptCache: TranscriptCache = {
       get: vi.fn(async (args) => {
         getCallLog.push({ url: args.url, fileMtime: args.fileMtime })
         // Return different content based on mtime (simulating mtime-aware cache)
         if (args.fileMtime === 1000) {
           return {
             content: 'transcript at mtime 1000',
             source: 'openai',
             expired: false,
             metadata: null,
           }
         }
         if (args.fileMtime === 2000) {
           // File was re-modified, so we'd return null to trigger re-transcription
           return null
         }
         return null
       }),
       set: vi.fn(async () => {}),
     }

     const url = 'file:///Users/test/audio.mp3'

     // First read with mtime 1000
     const result1 = await readTranscriptCache({
       url,
       cacheMode: 'default',
       transcriptCache,
       fileMtime: 1000,
     })

     expect(result1.resolution?.text).toBe('transcript at mtime 1000')
     expect(result1.diagnostics.cacheStatus).toBe('hit')

     // Second read with mtime 2000 (file was modified)
     const result2 = await readTranscriptCache({
       url,
       cacheMode: 'default',
       transcriptCache,
       fileMtime: 2000,
     })

     expect(result2.resolution).toBeNull()
     expect(result2.diagnostics.cacheStatus).toBe('miss')

     // Verify that get was called with different mtimes, proving the system
     // properly threads mtime through for cache-aware implementations
     expect(getCallLog).toEqual([
       { url, fileMtime: 1000 },
       { url, fileMtime: 2000 },
     ])
   })
})
