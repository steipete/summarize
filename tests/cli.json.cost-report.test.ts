import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({
  text: 'OK',
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
}))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
  }),
}))

describe('cli json + metrics report', () => {
  it('prints a finish line when --json --metrics detailed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-json-cost-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
          max_output_tokens: 2048,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(
          '<!doctype html><html><body><article><p>Hello</p></article></body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    await runCli(
      [
        '--json',
        '--metrics',
        'detailed',
        '--model',
        'openai/gpt-5.2',
        '--timeout',
        '10s',
        'https://example.com',
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    expect(stdoutText).toContain('"summary"')
    expect(stdoutText).toContain('"metrics"')
    expect(stdoutText).not.toContain('estimatedUsd')
    expect(stdoutText).not.toContain('totalEstimatedUsd')
    expect(stderrText).toContain('10/1/11 (in/out/Σ)')
    expect(stderrText).toContain('calls=1')
    expect(stderrText).not.toContain('metrics llm provider=')
    expect(stderrText).not.toContain('cost total')
  })
})
