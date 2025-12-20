import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const noopStream = () =>
  new Writable({
    write(chunk, encoding, callback) {
      void chunk
      void encoding
      callback()
    },
  })

describe('cli error handling', () => {
  it('errors when url is missing', async () => {
    await expect(
      runCli([], {
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Usage: summarize/)
  })

  it('errors when url is not http(s)', async () => {
    await expect(
      runCli(['ftp://example.com'], {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('Only HTTP and HTTPS URLs can be summarized')
  })

  it('errors when --firecrawl always is set without a key', async () => {
    await expect(
      runCli(['--firecrawl', 'always', '--extract-only', 'https://example.com'], {
        env: {},
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--firecrawl always requires FIRECRAWL_API_KEY')
  })

  it('errors when --markdown llm is set without any LLM keys', async () => {
    await expect(
      runCli(['--markdown', 'llm', '--extract-only', 'https://example.com'], {
        env: {},
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--markdown llm requires GEMINI_API_KEY/)
  })

  it('does not error for --markdown auto without keys', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }))

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(['--markdown', 'auto', '--extract-only', 'https://example.com'], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: noopStream(),
    })

    expect(stdoutText.length).toBeGreaterThan(0)
  })

  it('errors when summarizing without the required model API key', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing GEMINI_API_KEY/)
  })

  it('adds a bird tip when Twitter fetch fails and bird is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }))

    await expect(
      runCli(['--extract-only', 'https://x.com/user/status/123'], {
        env: { PATH: '' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Tip: Install bird🐦 for better Twitter support/)
  })

  it('fails gracefully when Twitter content is unavailable after bird and nitter', async () => {
    const tweetUrl = 'https://x.com/user/status/123'
    const nitterUrl = 'https://nitter.net/user/status/123'
    const blockedHtml = `<!doctype html><html><body><p>Something went wrong, but don’t fret — let’s give it another shot.</p></body></html>`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === tweetUrl || url === nitterUrl) {
        return new Response(blockedHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    await expect(
      runCli(['--extract-only', tweetUrl], {
        env: { PATH: '' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Unable to fetch tweet content from X/)
  })
})
