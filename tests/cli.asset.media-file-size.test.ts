import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AssetSummaryContext } from '../src/run/flows/asset/summary.js'

const statSync = vi.fn()

vi.mock('node:fs', () => ({
  statSync,
}))

const createLinkPreviewClient = vi.fn()

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient,
}))

function makeContext(): AssetSummaryContext {
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  return {
    env: {
      OPENAI_API_KEY: 'test-key',
      YT_DLP_PATH: 'yt-dlp',
      SUMMARIZE_WHISPER_CPP_BINARY: '/usr/bin/whisper-cli',
    },
    envForRun: {},
    stdout,
    stderr,
    execFileImpl: vi.fn() as unknown as AssetSummaryContext['execFileImpl'],
    timeoutMs: 1000,
    preprocessMode: 'auto',
    format: 'text',
    extractMode: false,
    lengthArg: { kind: 'preset', preset: 'short' },
    forceSummary: false,
    outputLanguage: { kind: 'auto' },
    videoMode: 'auto',
    fixedModelSpec: null,
    promptOverride: null,
    lengthInstruction: null,
    languageInstruction: null,
    isFallbackModel: false,
    desiredOutputTokens: null,
    envForAuto: {},
    configForModelSelection: null,
    cliAvailability: {},
    requestedModel: { kind: 'auto' },
    requestedModelInput: 'auto',
    requestedModelLabel: 'auto',
    wantsFreeNamedModel: false,
    isNamedModelSelection: false,
    maxOutputTokensArg: null,
    json: false,
    metricsEnabled: false,
    metricsDetailed: false,
    shouldComputeReport: false,
    runStartedAtMs: 0,
    verbose: false,
    verboseColor: false,
    streamingEnabled: false,
    plain: false,
    summaryEngine: {} as AssetSummaryContext['summaryEngine'],
    trackedFetch: vi.fn() as unknown as typeof fetch,
    writeViaFooter: vi.fn(),
    clearProgressForStdout: vi.fn(),
    restoreProgressAfterStdout: null,
    getLiteLlmCatalog: vi.fn(),
    buildReport: vi.fn(),
    estimateCostUsd: vi.fn(),
    llmCalls: [],
    cache: { mode: 'default', store: null, ttlMs: 0, maxBytes: 0, path: null },
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
  }
}

describe('summarizeMediaFile size limits', () => {
  it('rejects local media larger than 2GB', async () => {
    const hugeSize = 2 * 1024 * 1024 * 1024 + 1
    statSync.mockReturnValue({ size: hugeSize, mtimeMs: 123 })

    const { summarizeMediaFile } = await import('../src/run/flows/asset/media.js')
    const ctx = makeContext()

    await expect(
      summarizeMediaFile(ctx, {
        sourceKind: 'file',
        sourceLabel: '/tmp/huge.mp3',
        attachment: {
          kind: 'file',
          mediaType: 'audio/mpeg',
          filename: 'huge.mp3',
          bytes: new Uint8Array(),
        },
      })
    ).rejects.toThrow(/2 GB/)
  })
})
