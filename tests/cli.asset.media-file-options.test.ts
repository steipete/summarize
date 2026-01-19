import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { CacheStore } from '../src/cache.js'
import { summarizeMediaFile } from '../src/run/flows/asset/media.js'
import type { AssetSummaryContext } from '../src/run/flows/asset/summary.js'

const createLinkPreviewClient = vi.hoisted(() => vi.fn())

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient,
}))

function makeContext(overrides: Partial<AssetSummaryContext>): AssetSummaryContext {
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  return {
    env: { OPENAI_API_KEY: 'test-key' },
    apiStatus: {
      xaiApiKey: null,
      apiKey: null,
      openrouterApiKey: null,
      apifyToken: null,
      firecrawlConfigured: false,
      googleConfigured: false,
      anthropicConfigured: false,
      providerBaseUrls: { openai: null, anthropic: null, google: null, xai: null },
      zaiApiKey: null,
      zaiBaseUrl: '',
    },
    trackedFetch: vi.fn(),
    cache: { mode: 'default', store: null, ttlMs: 0, maxBytes: 0, path: null },
    timeoutMs: 1234,
    forceSummary: false,
    stderr,
    verbose: false,
    verboseColor: false,
    ...overrides,
  } as AssetSummaryContext
}

describe('summarizeMediaFile options', () => {
  it('passes timeout/cacheMode and bypasses transcript cache when cache is disabled', async () => {
    createLinkPreviewClient.mockReset()
    const root = mkdtempSync(join(tmpdir(), 'summarize-media-options-bypass-'))
    const audioPath = join(root, 'audio.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    let capturedClientOptions: { transcriptCache?: unknown | null } | null = null
    let capturedFetchOptions: { cacheMode?: string; timeoutMs?: number } | null = null

    createLinkPreviewClient.mockImplementation((options: unknown) => {
      capturedClientOptions = options
      return {
        fetchLinkContent: async (_url: string, optionsArg: unknown) => {
          capturedFetchOptions = optionsArg
          throw new Error('boom')
        },
      }
    })

    const ctx = makeContext({
      cache: {
        mode: 'bypass',
        store: { transcriptCache: {} } as CacheStore,
        ttlMs: 0,
        maxBytes: 0,
        path: null,
      },
      timeoutMs: 3456,
    })

    await expect(
      summarizeMediaFile(ctx, {
        sourceKind: 'file',
        sourceLabel: audioPath,
        attachment: {
          kind: 'file',
          mediaType: 'audio/mpeg',
          filename: 'audio.mp3',
          bytes: new Uint8Array(),
        },
      })
    ).rejects.toThrow(/Transcription failed/)

    expect(capturedClientOptions?.transcriptCache ?? null).toBeNull()
    expect(capturedFetchOptions?.cacheMode).toBe('bypass')
    expect(capturedFetchOptions?.timeoutMs).toBe(3456)
  })

  it('uses transcript cache and default cache mode when enabled', async () => {
    createLinkPreviewClient.mockReset()
    const root = mkdtempSync(join(tmpdir(), 'summarize-media-options-default-'))
    const audioPath = join(root, 'audio.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    let capturedClientOptions: { transcriptCache?: unknown | null } | null = null
    let capturedFetchOptions: { cacheMode?: string; timeoutMs?: number } | null = null

    const transcriptCache = {}

    createLinkPreviewClient.mockImplementation((options: unknown) => {
      capturedClientOptions = options
      return {
        fetchLinkContent: async (_url: string, optionsArg: unknown) => {
          capturedFetchOptions = optionsArg
          throw new Error('boom')
        },
      }
    })

    const ctx = makeContext({
      cache: {
        mode: 'default',
        store: { transcriptCache } as CacheStore,
        ttlMs: 0,
        maxBytes: 0,
        path: null,
      },
      timeoutMs: 5678,
    })

    await expect(
      summarizeMediaFile(ctx, {
        sourceKind: 'file',
        sourceLabel: audioPath,
        attachment: {
          kind: 'file',
          mediaType: 'audio/mpeg',
          filename: 'audio.mp3',
          bytes: new Uint8Array(),
        },
      })
    ).rejects.toThrow(/Transcription failed/)

    expect(capturedClientOptions?.transcriptCache).toBe(transcriptCache)
    expect(capturedFetchOptions?.cacheMode).toBe('default')
    expect(capturedFetchOptions?.timeoutMs).toBe(5678)
  })
})
