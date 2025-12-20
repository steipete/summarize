import { describe, expect, it } from 'vitest'
import { createLinkPreviewClient } from '../src/content/index.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null
const YT_DLP_PATH = process.env.YT_DLP_PATH ?? null
const LIVE =
  process.env.SUMMARIZE_LIVE_TESTS === '1' && Boolean(OPENAI_API_KEY) && Boolean(YT_DLP_PATH)

describe('live YouTube transcript (yt-dlp)', () => {
  const run = LIVE ? it : it.skip

  run(
    'transcribes a short video via yt-dlp',
    async () => {
      const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

      const client = createLinkPreviewClient({
        openaiApiKey: OPENAI_API_KEY,
        ytDlpPath: YT_DLP_PATH,
      })
      const result = await client.fetchLinkContent(url, {
        timeoutMs: 120_000,
        youtubeTranscript: 'yt-dlp',
      })

      expect(result.transcriptSource).toBe('yt-dlp')
      expect(result.transcriptCharacters ?? 0).toBeGreaterThan(20)
      expect(result.content.toLowerCase()).toContain('elephant')
    },
    180_000
  )
})
