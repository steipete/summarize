import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CacheState } from '../src/cache.js'
import { createDaemonUrlFlowContext } from '../src/daemon/flow-context.js'

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'summarize-daemon-home-'))
}

describe('daemon/flow-context (overrides)', () => {
  const makeCacheState = (): CacheState => ({
    mode: 'bypass',
    store: null,
    ttlMs: 0,
    maxBytes: 0,
    path: null,
  })

  it('defaults to xl + auto language when unset', () => {
    const home = makeTempHome()
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: '',
      languageRaw: '',
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })

    expect(ctx.lengthArg).toEqual({ kind: 'preset', preset: 'xl' })
    expect(ctx.outputLanguage).toEqual({ kind: 'auto' })
  })

  it('accepts custom length and language overrides', () => {
    const home = makeTempHome()
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: '20k',
      languageRaw: 'German',
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })

    expect(ctx.lengthArg).toEqual({ kind: 'chars', maxCharacters: 20000 })
    expect(ctx.outputLanguage.kind).toBe('fixed')
    expect(ctx.outputLanguage.kind === 'fixed' ? ctx.outputLanguage.tag : null).toBe('de')
  })

  it('adjusts desired output tokens based on length', () => {
    const home = makeTempHome()
    const shortCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: 'short',
      languageRaw: 'auto',
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })
    const xlCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: 'xl',
      languageRaw: 'auto',
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })

    const shortTokens = shortCtx.desiredOutputTokens
    const xlTokens = xlCtx.desiredOutputTokens
    if (typeof shortTokens !== 'number' || typeof xlTokens !== 'number') {
      throw new Error('expected desiredOutputTokens to be a number')
    }
    expect(shortTokens).toBeLessThan(xlTokens)
  })
})
