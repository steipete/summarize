import { describe, expect, it } from 'vitest'
import { createLinkPreviewClient } from '../src/content/index.js'

const LIVE = process.env.SUMMARIZE_LIVE_TEST === '1'

describe('live YouTube transcript (Lex URL)', () => {
  const run = LIVE ? it : it.skip

  run(
    'fetches a non-empty transcript for the Lex Carmack video',
    async () => {
      const url = 'https://www.youtube.com/watch?v=I845O57ZSy4&t=11s'

      const client = createLinkPreviewClient()
      const result = await client.fetchLinkContent(url, {
        timeoutMs: 120_000,
        youtubeTranscript: 'web',
      })

      expect(result.siteName).toBe('YouTube')
      expect(result.transcriptSource).not.toBe('unavailable')
      expect(result.transcriptCharacters).not.toBeNull()
      expect(result.transcriptCharacters ?? 0).toBeGreaterThan(10_000)
    },
    180_000
  )
})
