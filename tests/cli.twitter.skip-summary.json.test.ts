import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { makeAssistantMessage } from './helpers/pi-ai-mock.js'

const mocks = vi.hoisted(() => {
  const completeSimple = vi.fn()
  const streamSimple = vi.fn()
  const getModel = vi.fn(() => {
    throw new Error('no model')
  })
  const createLinkPreviewClient = vi.fn(() => {
    return {
      fetchLinkContent: vi.fn(async (url: string) => {
        return {
          url,
          title: 'Tweet',
          description: null,
          siteName: 'X',
          content: 'Short tweet text',
          truncated: false,
          totalCharacters: 15,
          wordCount: 3,
          transcriptCharacters: null,
          transcriptLines: null,
          transcriptWordCount: null,
          transcriptSource: null,
          transcriptionProvider: null,
          transcriptMetadata: null,
          transcriptSegments: null,
          transcriptTimedText: null,
          mediaDurationSeconds: null,
          video: null,
          isVideoOnly: false,
          diagnostics: {
            strategy: 'html',
            cacheMode: 'default',
            cacheStatus: 'miss',
            firecrawl: { used: false },
            markdown: { used: false, provider: null },
            transcript: {
              cacheMode: 'default',
              cacheStatus: 'miss',
              textProvided: false,
              provider: null,
              attemptedProviders: [],
              notes: null,
            },
          },
        }
      }),
    }
  })

  return { completeSimple, streamSimple, getModel, createLinkPreviewClient }
})

mocks.completeSimple.mockImplementation(async () =>
  makeAssistantMessage({
    text: 'SUMMARY',
    provider: 'openai',
    model: 'gpt-5.2',
    api: 'openai-responses',
  })
)

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
}))

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

describe('cli twitter skip-summary branches', () => {
  it('skips summarization for short tweet content in --json mode', async () => {
    mocks.completeSimple.mockClear()
    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      ['--json', '--metrics', 'off', '--timeout', '2s', 'https://twitter.com/x/status/123'],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stderr.getText()).toBe('')
    const payload = JSON.parse(stdout.getText())
    expect(payload.llm).toBeNull()
    expect(payload.summary).toBe('Short tweet text')
    expect(payload.input.url).toBe('https://twitter.com/x/status/123')
    expect(mocks.completeSimple).not.toHaveBeenCalled()
  })

  it('prints a finish line when metrics are enabled (json)', async () => {
    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      ['--json', '--metrics', 'detailed', '--timeout', '2s', 'https://twitter.com/x/status/123'],
      {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    const payload = JSON.parse(stdout.getText())
    expect(payload.llm).toBeNull()
    expect(payload.metrics).not.toBeNull()
    expect(stderr.getText()).toContain('·')
  })
})
