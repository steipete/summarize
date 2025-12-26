import { describe, expect, it } from 'vitest'

import { transcribeMediaWithWhisper } from '../packages/core/src/transcription/whisper.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null
const LIVE = process.env.SUMMARIZE_LIVE_TESTS === '1' && Boolean(OPENAI_API_KEY)

function decodeXmlEntities(value: string): string {
  return value.replaceAll(/&amp;/gi, '&').replaceAll(/&#38;/g, '&')
}

describe('live Whisper transcription (media)', () => {
  const run = LIVE ? it : it.skip

  run(
    'transcribes an MP3 enclosure URL',
    async () => {
      const feedUrl = 'https://feeds.npr.org/500005/podcast.xml'
      const feed = await (await fetch(feedUrl)).text()
      const match = feed.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i)
      if (!match?.[2]) {
        throw new Error('Failed to find enclosure url in feed')
      }
      const mp3Url = decodeXmlEntities(match[2])

      const res = await fetch(mp3Url)
      if (!res.ok) throw new Error(`MP3 download failed (${res.status})`)
      const bytes = new Uint8Array(await res.arrayBuffer())

      const out = await transcribeMediaWithWhisper({
        bytes,
        mediaType: 'audio/mpeg',
        filename: 'episode.mp3',
        openaiApiKey: OPENAI_API_KEY,
        falApiKey: null,
      })

      expect(out.text?.trim().length ?? 0).toBeGreaterThan(20)
      expect(out.provider).toBe('openai')
    },
    240_000
  )
})
