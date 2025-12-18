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

  it('errors when --prompt and --extract-only are both set', async () => {
    await expect(
      runCli(['--prompt', '--extract-only', 'https://example.com'], {
        env: {},
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--prompt and --extract-only are mutually exclusive')
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
    ).rejects.toThrow(/--markdown llm requires XAI_API_KEY/)
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
    ).rejects.toThrow(/Missing XAI_API_KEY/)
  })

  it('errors when --raw is combined with --firecrawl or --markdown', async () => {
    await expect(
      runCli(['--raw', '--firecrawl', 'off', '--extract-only', 'https://example.com'], {
        env: {},
        fetch: vi.fn(
          async () => new Response('<html></html>', { status: 200 })
        ) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--raw cannot be combined with --firecrawl or --markdown')
  })
})
