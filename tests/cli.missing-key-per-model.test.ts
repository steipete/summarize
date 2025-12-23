import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('cli missing API key errors', () => {
  it('errors when a bag uses OpenRouter but OPENROUTER_API_KEY is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-missing-key-'))
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      join(root, '.summarize', 'config.json'),
      JSON.stringify({
        bags: { free: { mode: 'auto', rules: [{ candidates: ['openrouter/openai/gpt-5-mini'] }] } },
      }),
      'utf8'
    )

    await expect(
      runCli(['--model', 'free', '--timeout', '2s', 'https://example.com'], {
        env: { HOME: root },
        fetch: vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing OPENROUTER_API_KEY/)
  })

  it('errors when --model openai/... is set without OPENAI_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing OPENAI_API_KEY/)
  })

  it('errors when --model google/... is set without GEMINI_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'google/gemini-2.0-flash', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing GEMINI_API_KEY/)
  })

  it('errors when --model anthropic/... is set without ANTHROPIC_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'anthropic/claude-sonnet-4-5', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing ANTHROPIC_API_KEY/)
  })
})
