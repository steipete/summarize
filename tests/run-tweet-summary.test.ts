import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/run.js'

const fetchLinkContentMock = vi.fn()
const generateTextWithModelIdMock = vi.fn()
const streamTextWithModelIdMock = vi.fn()

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient: () => ({
    fetchLinkContent: (...args: unknown[]) => fetchLinkContentMock(...args),
  }),
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: (...args: unknown[]) => generateTextWithModelIdMock(...args),
  streamTextWithModelId: (...args: unknown[]) => streamTextWithModelIdMock(...args),
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
  fetchLinkContentMock.mockReset()
  generateTextWithModelIdMock.mockReset()
  streamTextWithModelIdMock.mockReset()
})

describe('tweet summary behavior', () => {
  it('uses LLM and claim source in finish line for tweets', async () => {
    fetchLinkContentMock.mockResolvedValue(baseExtracted)
    generateTextWithModelIdMock.mockResolvedValue({
      text: 'LLM summary output.',
      provider: 'openai',
      canonicalModelId: 'openai/gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
    })

    const stdout = createBufferStream()
    const stderr = createBufferStream()

    await runCli(
      [baseExtracted.url, '--model', 'openai/gpt-4o-mini', '--stream', 'off', '--render', 'plain'],
      {
        env: { ...process.env, OPENAI_API_KEY: 'test-key' },
        fetch: async () => {
          throw new Error('unexpected fetch')
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(generateTextWithModelIdMock).toHaveBeenCalledTimes(1)
    expect(streamTextWithModelIdMock).not.toHaveBeenCalled()
    expect(stdout.read()).toContain('LLM summary output.')
    expect(stdout.read()).not.toContain(baseExtracted.content)
    expect(stderr.read()).toContain('3 words via bird')
  })
})
