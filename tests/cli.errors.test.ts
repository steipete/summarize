import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { toNitterUrls } from '../packages/core/src/content/link-preview/content/twitter-utils.js'
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
  const home = mkdtempSync(join(tmpdir(), 'summarize-tests-errors-'))

  it('errors when url is missing', async () => {
    await expect(
      runCli([], {
        env: { HOME: home },
        fetch: globalThis.fetch.bind(globalThis),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Usage: summarize/)
  })

  it('errors when url is not http(s)', async () => {
    await expect(
      runCli(['ftp://example.com'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('Only HTTP and HTTPS URLs can be summarized')
  })

  it('errors when --firecrawl always is set without a key', async () => {
    await expect(
      runCli(['--firecrawl', 'always', '--extract', 'https://example.com'], {
        env: { HOME: home },
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
      runCli(['--format', 'md', '--markdown-mode', 'llm', '--extract', 'https://example.com'], {
        env: { HOME: home },
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--markdown-mode llm requires GEMINI_API_KEY/)
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

    await runCli(
      ['--format', 'md', '--markdown-mode', 'auto', '--extract', 'https://example.com'],
      {
        env: { HOME: home },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: noopStream(),
      }
    )

    expect(stdoutText.length).toBeGreaterThan(0)
  })

  it('errors when --markdown-mode is used without --format md', async () => {
    await expect(
      runCli(['--markdown-mode', 'auto', 'https://example.com'], {
        env: { HOME: home },
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--markdown-mode is only supported with --format md')
  })

  it('errors when --format md conflicts with --markdown-mode off', async () => {
    await expect(
      runCli(['--extract', '--format', 'md', '--markdown-mode', 'off', 'https://example.com'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--format md conflicts with --markdown-mode off')
  })

  it('errors when --cli and --model are both set', async () => {
    await expect(
      runCli(['--cli', 'gemini', '--model', 'openai/gpt-5.2', 'https://example.com'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('Use either --model or --cli')
  })

  it('prints extracted content when summarizing without any model API keys (default auto)', async () => {
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

    await runCli(['--timeout', '2s', 'https://example.com'], {
      env: { HOME: home },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: noopStream(),
    })

    expect(stdoutText).toContain('A'.repeat(50))
  })

  it('adds a bird tip when Twitter fetch fails and bird is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }))

    await expect(
      runCli(['--extract-only', 'https://x.com/user/status/123'], {
        env: { HOME: home, PATH: '' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Tip: Install bird🐦 for better Twitter support/)
  })

  it('fails gracefully when Twitter content is unavailable after bird and nitter', async () => {
    const tweetUrl = 'https://x.com/user/status/123'
    const nitterUrls = toNitterUrls(tweetUrl)
    const blockedHtml = `<!doctype html><html><body><p>Something went wrong, but don’t fret — let’s give it another shot.</p></body></html>`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === tweetUrl || nitterUrls.includes(url)) {
        return new Response(blockedHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    await expect(
      runCli(['--extract-only', tweetUrl], {
        env: { HOME: home, PATH: '' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Unable to fetch tweet content from X/)
  })
})
