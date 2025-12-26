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

const tweetUrl = 'https://x.com/user/status/123'
const nitterUrls = toNitterUrls(tweetUrl)

const buildFetchMock = (html: string) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.url
    if (url === tweetUrl || nitterUrls.includes(url)) {
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  })

describe('cli tweet summarization bypass', () => {
  const home = mkdtempSync(join(tmpdir(), 'summarize-tests-twitter-summary-'))

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
      env: { HOME: home, PATH: '' },
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

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(['--length', '200', tweetUrl], {
      env: { HOME: home, PATH: '' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: noopStream(),
    })

    expect(stdoutText).toContain(tweet.slice(0, 50))
  }, 15_000)
})
