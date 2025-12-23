import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({ text: 'SUMMARY' }))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
  }),
}))

const collectStdout = () => {
  let text = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stdout, getText: () => text }
}

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

describe('--model auto', () => {
  it('uses an LLM even when extracted content is short', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'SUMMARY' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(
          '<!doctype html><html><body><article><p>Hello world</p></article></body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'auto', '--timeout', '2s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: silentStderr,
    })

    expect(out.getText()).toMatch(/summary/i)
    expect(out.getText()).not.toMatch(/hello world/i)
    expect(generateTextMock).toHaveBeenCalled()
  })

  it('uses an LLM in --json mode (llm != null)', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'SUMMARY' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(
          '<!doctype html><html><body><article><p>Hello world</p></article></body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(
      ['--model', 'auto', '--json', '--metrics', 'off', '--timeout', '2s', 'https://example.com'],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: silentStderr,
      }
    )

    const payload = JSON.parse(out.getText()) as { llm: unknown; summary?: string }
    expect(payload.llm).not.toBe(null)
    expect(payload.summary).toMatch(/summary/i)
  })

  it('uses an LLM for local text files (does not echo file)', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'SUMMARY' })
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-test-'))
    const filePath = path.join(tmpDir, 'input.txt')
    await fs.writeFile(filePath, 'Hello world\n', 'utf8')

    const out = collectStdout()
    await runCli(['--model', 'auto', '--timeout', '2s', filePath], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: out.stdout,
      stderr: silentStderr,
    })

    expect(out.getText()).toMatch(/summary/i)
    expect(out.getText()).not.toMatch(/hello world/i)
    expect(generateTextMock).toHaveBeenCalled()
  })
})
