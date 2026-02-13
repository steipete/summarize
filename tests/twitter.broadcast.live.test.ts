import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createLinkPreviewClient } from '../src/content/index.js'
import { readTweetWithBird } from '../src/run/bird.js'
import { resolveTwitterCookies } from '../src/run/cookies/twitter.js'
import { resolveExecutableInPath } from '../src/run/env.js'
import { extractSlidesForSource, resolveSlideSource } from '../src/slides/index.js'
import { resolveSlideSettings } from '../src/slides/settings.js'

const ENV = process.env as Record<string, string | undefined>
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null
const FAL_KEY = process.env.FAL_KEY ?? null
const YT_DLP_PATH = process.env.YT_DLP_PATH ?? null
const BIRD_PATH = resolveExecutableInPath('bird', ENV)
const FFMPEG_PATH = resolveExecutableInPath('ffmpeg', ENV)

const LIVE =
  process.env.SUMMARIZE_LIVE_TESTS === '1' &&
  Boolean(YT_DLP_PATH) &&
  Boolean(BIRD_PATH) &&
  (Boolean(OPENAI_API_KEY) || Boolean(FAL_KEY))
const LIVE_SLIDES = LIVE && Boolean(FFMPEG_PATH)

const TWEET_URL =
  process.env.SUMMARIZE_LIVE_TWITTER_BROADCAST_URL ??
  'https://x.com/RayFernando1337/status/2013371120922304918'

const createClient = () =>
  createLinkPreviewClient({
    groqApiKey: null,
    openaiApiKey: OPENAI_API_KEY,
    falApiKey: FAL_KEY,
    ytDlpPath: YT_DLP_PATH,
    readTweetWithBird: ({ url, timeoutMs }) => readTweetWithBird({ url, timeoutMs, env: ENV }),
    resolveTwitterCookies: async () => {
      const res = await resolveTwitterCookies({ env: ENV })
      return {
        cookiesFromBrowser: res.cookies.cookiesFromBrowser,
        source: res.cookies.source,
        warnings: res.warnings,
      }
    },
  })

describe('live X broadcast (tweet video)', () => {
  const run = LIVE ? it : it.skip

  run(
    'transcribes tweet video via yt-dlp and exposes a video url',
    async () => {
      const client = createClient()
      const result = await client.fetchLinkContent(TWEET_URL, { timeoutMs: 180_000 })

      expect(result.video).not.toBeNull()
      expect(result.transcriptSource).not.toBeNull()
      expect(result.transcriptCharacters ?? 0).toBeGreaterThan(20)
    },
    240_000
  )
})

describe('live X broadcast slides', () => {
  const run = LIVE_SLIDES ? it : it.skip

  run(
    'extracts slides for tweet video',
    async () => {
      const client = createClient()
      const result = await client.fetchLinkContent(TWEET_URL, { timeoutMs: 180_000 })
      const source = resolveSlideSource({ url: TWEET_URL, extracted: result })

      expect(source).not.toBeNull()
      if (!source) return

      const slidesDir = mkdtempSync(path.join(tmpdir(), 'summarize-live-slides-'))
      const settings = resolveSlideSettings({
        slides: true,
        slidesDir,
        cwd: slidesDir,
      })
      if (!settings) {
        throw new Error('Failed to resolve slide settings')
      }

      const slides = await extractSlidesForSource({
        source,
        settings,
        noCache: true,
        env: ENV,
        timeoutMs: 300_000,
        ytDlpPath: YT_DLP_PATH,
        ffmpegPath: null,
        tesseractPath: null,
      })

      expect(slides.slides.length).toBeGreaterThan(0)
    },
    360_000
  )
})
