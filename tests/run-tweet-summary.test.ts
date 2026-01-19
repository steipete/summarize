import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/run.js'

const mocks = vi.hoisted(() => ({
  fetchLinkContent: vi.fn(),
  generateTextWithModelId: vi.fn(),
  streamTextWithModelId: vi.fn(),
}))

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient: () => ({
    fetchLinkContent: (...args: unknown[]) => mocks.fetchLinkContent(...args),
  }),
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: (...args: unknown[]) => mocks.generateTextWithModelId(...args),
  streamTextWithModelId: (...args: unknown[]) => mocks.streamTextWithModelId(...args),
}))

const createBufferStream = () => {
  let buffer = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString()
      callback()
    },
  })
  return {
    stream,
    read: () => buffer,
  }
}

const baseExtracted = {
  url: 'https://x.com/ivanhzhao/status/2003192654545539400',
  title: null,
  description: null,
  siteName: 'X',
  content: 'Short tweet content.',
  truncated: false,
  totalCharacters: 21,
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
    strategy: 'bird',
    firecrawl: {
      attempted: false,
      used: false,
      cacheMode: 'default',
      cacheStatus: 'miss',
    },
    markdown: {
      requested: false,
      used: false,
      provider: null,
      notes: null,
    },
    transcript: {
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: false,
      provider: null,
      attemptedProviders: [],
    },
  },
}

beforeEach(() => {
  mocks.fetchLinkContent.mockReset()
  mocks.generateTextWithModelId.mockReset()
  mocks.streamTextWithModelId.mockReset()
})

describe('tweet summary behavior', () => {
  it('skips LLM for short tweets by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-tests-run-tweet-summary-'))
    mocks.fetchLinkContent.mockResolvedValue(baseExtracted)
    mocks.generateTextWithModelId.mockResolvedValue({
      text: 'LLM summary output.',
      provider: 'openai',
      canonicalModelId: 'openai/gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
    })

    const stdout = createBufferStream()
    const stderr = createBufferStream()

    await runCli(
      [baseExtracted.url, '--model', 'openai/gpt-4o-mini', '--stream', 'off', '--plain'],
      {
        env: { ...process.env, HOME: home, OPENAI_API_KEY: 'test-key' },
        fetch: async () => {
          throw new Error('unexpected fetch')
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(mocks.generateTextWithModelId).not.toHaveBeenCalled()
    expect(mocks.streamTextWithModelId).not.toHaveBeenCalled()
    expect(stdout.read()).toContain(baseExtracted.content)
    expect(stderr.read()).toContain('short content')
  })
})
