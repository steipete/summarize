import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: vi.fn(async () => {
    throw new Error('No allowed providers are available for the selected model.')
  }),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error('No allowed providers are available for the selected model.')
  }),
}))

describe('model bags: OpenRouter provider routing errors', () => {
  it('fails loudly instead of returning extracted text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-bag-openrouter-no-provider-'))
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      join(root, '.summarize', 'config.json'),
      JSON.stringify({
        bags: {
          free: { mode: 'auto', rules: [{ candidates: ['openrouter/openai/gpt-5-nano'] }] },
        },
      }),
      'utf8'
    )
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      2000
    )}</p></article></body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://openrouter.ai/api/v1/models/')) {
        return new Response(
          JSON.stringify({
            data: {
              endpoints: [{ provider_name: 'Google AI Studio' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(html, { status: 200 })
    })

    const stdout = collectStream()
    const stderr = collectStream()

    await expect(
      runCli(['--model', 'free', '--timeout', '2s', 'https://example.com'], {
        env: { HOME: root, OPENROUTER_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/Providers to allow:.*Google AI Studio/i)

    expect(stdout.getText()).not.toContain('A'.repeat(50))
    expect(stdout.getText().trim()).toBe('')
  })
})
