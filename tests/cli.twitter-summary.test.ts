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

const tweetUrl = 'https://x.com/user/status/123'

const nitterUrl = 'https://nitter.net/user/status/123'

const buildFetchMock = (html: string) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.url
    if (url === tweetUrl || url === nitterUrl) {
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  })

describe('cli tweet summarization bypass', () => {
  it('skips LLM summary for short tweets', async () => {
    const tweet = 'Short tweet content.'
    const html = `<!doctype html><html><head><title>Tweet</title></head><body><article><p>${tweet}</p></article></body></html>`
    const fetchMock = buildFetchMock(html)

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli([tweetUrl], {
      env: { PATH: '' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: noopStream(),
    })

    expect(stdoutText).toContain(tweet)
  })

  it('still summarizes when tweet exceeds target length', async () => {
    const tweet = 'A'.repeat(600)
    const html = `<!doctype html><html><head><title>Tweet</title></head><body><article><p>${tweet}</p></article></body></html>`
    const fetchMock = buildFetchMock(html)

    await expect(
      runCli(['--length', '200', tweetUrl], {
        env: { PATH: '' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing GEMINI_API_KEY/)
  })
})
