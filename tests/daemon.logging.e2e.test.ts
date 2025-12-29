import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const summary = url ? 'Summary for ' + url : 'Summary';
if (outputPath) {
  fs.writeFileSync(outputPath, summary);
}
console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
`
  writeFileSync(scriptPath, script, 'utf8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

describe('daemon logging', () => {
  it('logs extended content only when requested', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-logging-'))
    const port = await findFreePort()
    const token = 'test-token-logging-123'
    const codexPath = createFakeCodex(home)

    const configDir = join(home, '.summarize')
    const logPath = join(configDir, 'logs', 'daemon.jsonl')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          logging: {
            enabled: true,
            level: 'debug',
            format: 'json',
            file: logPath,
            maxMb: 1,
            maxFiles: 1,
          },
        },
        null,
        2
      ),
      'utf8'
    )

    const fetchImpl = async () => {
      const html = '<!doctype html><html><head><title>Ok</title></head><body>Hello</body></html>'
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }

    const abortController = new AbortController()
    const pendingDone = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
    const doneSessions = new Set<string>()
    const errorSessions = new Map<string, string>()

    const waitForDone = async (sessionId: string) =>
      await new Promise<void>((resolve, reject) => {
        const error = errorSessions.get(sessionId)
        if (error) {
          reject(new Error(error))
          return
        }
        if (doneSessions.has(sessionId)) {
          resolve()
          return
        }
        pendingDone.set(sessionId, { resolve, reject })
      })

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
          errorSessions.set(sessionId, event.data.message)
          const pending = pendingDone.get(sessionId)
          pendingDone.delete(sessionId)
          pending?.reject(new Error(event.data.message))
          return
        }
        if (event.event === 'done') {
          doneSessions.add(sessionId)
          const pending = pendingDone.get(sessionId)
          pendingDone.delete(sessionId)
          pending?.resolve()
        }
      },
    })

    await ready

    try {
      const run = async (includeContent: boolean) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://example.com/article',
            title: 'Example',
            model: 'cli/codex',
            length: 'short',
            language: 'auto',
            mode: 'url',
            diagnostics: includeContent ? { includeContent: true } : undefined,
          }),
        })
        const json = (await res.json()) as { ok: boolean; id?: string }
        expect(res.ok).toBe(true)
        expect(json.ok).toBe(true)
        expect(json.id).toBeTruthy()
        const id = json.id as string
        await waitForDone(id)
        return id
      }

      const extendedId = await run(true)
      const minimalId = await run(false)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lines = readFileSync(logPath, 'utf8')
        .trim()
        .split(/\n+/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      const doneExtended = lines.find(
        (entry) => entry.event === 'summarize.done' && entry.requestId === extendedId
      )
      const doneMinimal = lines.find(
        (entry) => entry.event === 'summarize.done' && entry.requestId === minimalId
      )

      expect(doneExtended).toBeTruthy()
      expect(doneMinimal).toBeTruthy()
      expect(doneExtended?.summary).toContain('https://example.com/article')
      expect(doneExtended?.extracted).toBeTruthy()
      expect(doneMinimal?.summary).toBeUndefined()
      expect(doneMinimal?.extracted).toBeUndefined()
    } finally {
      abortController.abort()
      await serverPromise
    }
  }, 20_000)
})
