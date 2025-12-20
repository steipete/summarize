import { describe, expect, it } from 'vitest'
import { createLinkPreviewClient } from '../src/content/index.js'

const LIVE = process.env.SUMMARIZE_LIVE_TESTS === '1'
const NO_TRANSCRIPT_URL =
  process.env.SUMMARIZE_LIVE_NO_TRANSCRIPT_URL ?? 'https://www.youtube.com/watch?v=XJ1SaNX4s8I'

describe('live YouTube transcript (web, no captions)', () => {
  const run = LIVE ? it : it.skip

  run(
    'returns unavailable transcript when captions are missing',
    async () => {
      const client = createLinkPreviewClient()
      const result = await client.fetchLinkContent(NO_TRANSCRIPT_URL, {
        timeoutMs: 120_000,
        youtubeTranscript: 'web',
      })

      expect(result.transcriptSource).toBe('unavailable')
      expect(result.transcriptCharacters).toBeNull()
    },
    180_000
  )
})
