import { describe, expect, it, vi } from 'vitest'

import * as generic from '../packages/core/src/content/transcript/providers/generic.js'
import * as podcast from '../packages/core/src/content/transcript/providers/podcast.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
} from '../packages/core/src/content/transcript/types.js'

const noopFetch = vi.fn(async () => new Response('nope', { status: 500 }))

const contextFor = (url: string): ProviderContext => ({ url, html: null, resourceKey: null })

describe('placeholder transcript providers', () => {
  it('matches podcast URLs', () => {
    expect(podcast.canHandle(contextFor('https://example.com/podcast/123'))).toBe(true)
    expect(podcast.canHandle(contextFor('https://open.spotify.com/show/abc'))).toBe(true)
    expect(podcast.canHandle(contextFor('https://example.com/article'))).toBe(false)
  })

  it('matches generic URLs', () => {
    expect(generic.canHandle(contextFor('https://example.com/article'))).toBe(true)
  })

  it('returns not_implemented provider metadata', async () => {
    const options: ProviderFetchOptions = {
      fetch: noopFetch as unknown as typeof fetch,
      apifyApiToken: null,
      youtubeTranscriptMode: 'auto',
      ytDlpPath: null,
      falApiKey: null,
      openaiApiKey: null,
    }

    const podcastResult = await podcast.fetchTranscript(
      contextFor('https://example.com/podcast'),
      options
    )
    expect(podcastResult.text).toBeNull()
    expect(podcastResult.metadata).toEqual({
      provider: 'podcast',
      reason: 'missing_transcription_keys',
    })

    const genericResult = await generic.fetchTranscript(contextFor('https://example.com'), options)
    expect(genericResult.text).toBeNull()
    expect(genericResult.metadata).toEqual({ provider: 'generic', reason: 'not_implemented' })
  })
})
