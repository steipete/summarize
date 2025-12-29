import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runDaemonServer } from '../src/daemon/server.js'

const findFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve port')))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })

const createFakeCodex = (dir: string): string => {
  const scriptPath = join(dir, 'fake-codex.js')
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const outputFlagIndex = args.indexOf('--output-last-message');
const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : null;
const input = fs.readFileSync(0, 'utf8');
const line = input.split(/\\r?\\n/).find((value) => value.startsWith('Source URL: '));
const url = line ? line.slice('Source URL: '.length).trim() : '';
if (outputPath) {
  fs.writeFileSync(outputPath, url ? 'URL=' + url : 'URL=');
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
`
  writeFileSync(scriptPath, script, 'utf8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

describe('daemon redirect e2e', () => {
  it('summarizes with the final redirect URL in the prompt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-redirects-'))
    const port = await findFreePort()
    const token = 'test-token-1234567890'
    const codexPath = createFakeCodex(home)

    const fetchImpl = async () => {
      const html = '<!doctype html><html><head><title>Ok</title></head><body>Hello</body></html>'
      const response = new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
      Object.defineProperty(response, 'url', {
        value: 'https://summarize.sh/',
        configurable: true,
      })
      return response
    }

    const abortController = new AbortController()
    let activeSessionId: string | null = null
    let resolveChunk: ((value: string) => void) | null = null
    let rejectChunk: ((error: Error) => void) | null = null
    const pendingChunks = new Map<string, string>()
    const pendingErrors = new Map<string, string>()
    let settled = false
    const chunkPromise = new Promise<string>((resolve, reject) => {
      resolveChunk = resolve
      rejectChunk = reject
    })
    const settleChunk = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const timeoutId = setTimeout(() => {
      settleChunk(() => {
        rejectChunk?.(new Error('Timed out waiting for daemon chunk event'))
      })
    }, 5000)

    let resolveReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const serverPromise = runDaemonServer({
      env: {
        HOME: home,
        SUMMARIZE_MODEL: 'cli/codex',
        SUMMARIZE_CLI_CODEX: codexPath,
      },
      fetchImpl: fetchImpl as typeof fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
      onSessionEvent: (event, sessionId) => {
        if (event.event === 'error') {
          pendingErrors.set(sessionId, event.data.message)
          if (activeSessionId && sessionId === activeSessionId) {
            clearTimeout(timeoutId)
            settleChunk(() => rejectChunk?.(new Error(event.data.message)))
          }
          return
        }
        if (event.event !== 'chunk') return
        pendingChunks.set(sessionId, event.data.text)
        if (activeSessionId && sessionId === activeSessionId) {
          clearTimeout(timeoutId)
          settleChunk(() => resolveChunk?.(event.data.text))
        }
      },
    })

    await ready

    try {
      const runRes = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://t.co/abc',
          title: null,
          model: 'cli/codex',
          length: 'short',
          language: 'auto',
          mode: 'url',
        }),
      })
      const runJson = (await runRes.json()) as { ok: boolean; id?: string }
      expect(runRes.ok).toBe(true)
      expect(runJson.ok).toBe(true)
      expect(runJson.id).toBeTruthy()

      activeSessionId = runJson.id ?? null
      if (activeSessionId) {
        const pendingError = pendingErrors.get(activeSessionId)
        if (pendingError) {
          throw new Error(pendingError)
        }
        const pendingChunk = pendingChunks.get(activeSessionId)
        if (pendingChunk) {
          clearTimeout(timeoutId)
          settleChunk(() => resolveChunk?.(pendingChunk))
        }
      }

      const summary = await chunkPromise
      expect(summary).toContain('https://summarize.sh/')
      expect(summary).not.toContain('https://t.co/abc')
    } finally {
      clearTimeout(timeoutId)
      abortController.abort()
      await serverPromise
    }
  }, 20_000)
})
