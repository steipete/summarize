import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Api } from '@mariozechner/pi-ai'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'
import { makeAssistantMessage } from './helpers/pi-ai-mock.js'

type MockModel = { provider: string; id: string; api: Api }

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

mocks.completeSimple.mockImplementation(async (model: MockModel) =>
  makeAssistantMessage({ text: 'OK', provider: model.provider, model: model.id, api: model.api })
)

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

function collectStdout() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

describe('cli config legacy apiKeys', () => {
  it('maps config apiKeys to env fallback when process env is missing', async () => {
    mocks.completeSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-cli-config-apikeys-legacy-'))
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      join(root, '.summarize', 'config.json'),
      JSON.stringify({
        model: { id: 'openai/gpt-5.2' },
        apiKeys: { openai: 'test-legacy-openai-key' },
      }),
      'utf8'
    )

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })
    const stdout = collectStdout()

    await runCli(['--timeout', '2s', 'https://example.com'], {
      env: { HOME: root },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    expect(stdout.getText().trim()).toBe('OK')
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1)
  })
})
