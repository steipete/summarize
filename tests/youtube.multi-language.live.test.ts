import { describe, expect, it } from 'vitest'
import { createLinkPreviewClient } from '../src/content/index.js'

const LIVE = process.env.SUMMARIZE_LIVE_TESTS === '1'

const MULTI_LANGUAGE_URLS = [
  'https://www.youtube.com/watch?v=5MuIMqhT8DM',
  'https://www.youtube.com/watch?v=gUV5DJb6KGs',
] as const

describe('live YouTube transcript (web, multi-language captions)', () => {
  const run = LIVE ? it : it.skip

  for (const url of MULTI_LANGUAGE_URLS) {
    run(
      `fetches a non-empty transcript for ${url}`,
      async () => {
        const client = createLinkPreviewClient()
        const result = await client.fetchLinkContent(url, {
          timeoutMs: 120_000,
          youtubeTranscript: 'web',
        })

        expect(result.siteName).toBe('YouTube')
        expect(result.transcriptSource).not.toBe('unavailable')
        expect(result.transcriptCharacters ?? 0).toBeGreaterThan(2_000)
      },
      180_000
    )
  }
})
