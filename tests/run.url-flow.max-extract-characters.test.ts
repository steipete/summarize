import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CacheState } from '../src/cache.js'
import type { ExtractedLinkContent } from '../src/content/index.js'
import { createDaemonUrlFlowContext } from '../src/daemon/flow-context.js'
import { runUrlFlow } from '../src/run/flows/url/flow.js'

describe('runUrlFlow', () => {
  it('honors ctx.maxExtractCharacters (for daemon/extension)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-url-flow-maxchars-'))
    const url = 'https://example.com/article'
    const content = `<!doctype html><html><head><title>Hello</title></head><body><article>${'word '.repeat(5000)}</article></body></html>`

    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl !== url) {
        throw new Error(`unexpected fetch: ${requestUrl}`)
      }
      return new Response(content, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    const cache: CacheState = {
      mode: 'bypass',
      store: null,
      ttlMs: 0,
      maxBytes: 0,
      path: null,
    }

    let extracted: ExtractedLinkContent | null = null
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: root, OPENAI_API_KEY: 'test' },
      fetchImpl,
      cache,
      modelOverride: 'openai/gpt-5.2',
      promptOverride: null,
      lengthRaw: 'xl',
      languageRaw: 'auto',
      maxExtractCharacters: 9_000,
      hooks: {
        onExtracted: (value) => {
          extracted = value
        },
      },
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })

    ;(ctx as unknown as { extractMode: boolean }).extractMode = true

    await runUrlFlow({ ctx, url, isYoutubeUrl: false })

    expect(extracted).not.toBeNull()
    expect(extracted?.content.length).toBeLessThanOrEqual(9_000)
    expect(extracted?.truncated).toBe(true)
  })
})
