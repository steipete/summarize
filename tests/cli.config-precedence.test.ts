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

const generateTextMock = vi.fn(async () => ({ text: 'OK' }))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

const createOpenAIMock = vi.fn(({ apiKey }: { apiKey: string }) => {
  return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}))

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

function captureStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

describe('cli config precedence', () => {
  it('uses config file model when --model and SUMMARIZE_MODEL are absent', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ model: { id: 'openai/gpt-5.2' } }), 'utf8')

    await runCli(['--timeout', '2s', 'https://example.com'], {
      env: { HOME: tempRoot, OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: noopStream(),
      stderr: noopStream(),
    })

    expect(createOpenAIMock).toHaveBeenCalledTimes(1)
  })

  it('uses config file model bag when --model and SUMMARIZE_MODEL are absent', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'mybag',
        bags: {
          mybag: {
            mode: 'auto',
            rules: [{ candidates: ['openai/gpt-5.2'] }],
          },
        },
      }),
      'utf8'
    )

    const stdout = captureStream()

    await runCli(['--timeout', '2s', '--extract', '--json', 'https://example.com'], {
      env: { HOME: tempRoot },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } }
    expect(parsed.input.model).toBe('mybag')

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(createOpenAIMock).toHaveBeenCalledTimes(0)
  })

  it('prefers SUMMARIZE_MODEL over config file', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({ model: { id: 'xai/grok-4-fast-non-reasoning' } }),
      'utf8'
    )

    const stdout = captureStream()

    await runCli(['--timeout', '2s', '--extract', '--json', 'https://example.com'], {
      env: { HOME: tempRoot, SUMMARIZE_MODEL: 'openai/gpt-5.2' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } }
    expect(parsed.input.model).toBe('openai/gpt-5.2')

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(createOpenAIMock).toHaveBeenCalledTimes(0)
  })
})
