import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { runCli } from '../../src/run.js'

const LIVE = process.env.SUMMARIZE_LIVE_TEST === '1'

function shouldSoftSkipLiveError(message: string): boolean {
  return /(rate limit exceeded|free-models-per-min|free-models-per-day|no working :free models|no :free models)/i.test(
    message
  )
}

const collectStream = () => {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

;(LIVE ? describe : describe.skip)('live free preset', () => {
  const timeoutMs = 180_000

  it(
    'refresh-free + --model free returns JSON with llm!=null',
    async () => {
      const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() ?? ''
      if (!OPENROUTER_API_KEY) {
        it.skip('requires OPENROUTER_API_KEY', () => {})
        return
      }

      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-live-free-'))
      const env = { ...process.env, HOME: home, OPENROUTER_API_KEY }

      try {
        const refreshOut = collectStream()
        await runCli(['refresh-free', '--runs', '0', '--min-params', '0b'], {
          env,
          fetch: globalThis.fetch.bind(globalThis),
          stdout: refreshOut.stream,
          stderr: silentStderr,
        })
        expect(refreshOut.getText()).toMatch(/models\.free/i)

        const out = collectStream()
        await runCli(
          ['--json', '--metrics', 'off', '--timeout', '60s', '--model', 'free', 'https://example.com'],
          {
            env,
            fetch: globalThis.fetch.bind(globalThis),
            stdout: out.stream,
            stderr: silentStderr,
          }
        )

        const payload = JSON.parse(out.getText()) as { llm: unknown; summary?: string | null }
        expect(payload.llm).not.toBe(null)
        expect(typeof payload.summary).toBe('string')
        expect((payload.summary ?? '').trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )
})

