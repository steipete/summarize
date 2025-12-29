import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type { ExecFileFn } from '../src/markitdown.js'
import { runCli } from '../src/run.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

function noopStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

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

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

describe('cli preprocess / markitdown integration', () => {
  it('requires markitdown for binary files (PDF) in this build', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['OK\n'],
        makeAssistantMessage({ text: 'OK\n', usage: { input: 1, output: 1, totalTokens: 2 } })
      )
    )
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-preprocess-off-by-format-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      void file
      void args
      cb(new Error('boom'), '', '')
    })

    const run = () =>
      runCli(
        ['--model', 'xai/grok-4-fast-non-reasoning', '--timeout', '2s', '--stream', 'on', pdfPath],
        {
          env: { XAI_API_KEY: 'test', UVX_PATH: 'uvx' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          execFile: execFileMock as unknown as ExecFileFn,
          stdout: noopStream(),
          stderr: noopStream(),
        }
      )

    await expect(run()).rejects.toThrow(/Failed to preprocess application\/pdf/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('preprocesses PDF to Markdown and inlines it into the prompt', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['OK\n'],
        makeAssistantMessage({ text: 'OK\n', usage: { input: 1, output: 1, totalTokens: 2 } })
      )
    )
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-preprocess-auto-retry-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('uvx')
      expect(args.slice(0, 3)).toEqual(['--from', 'markitdown[all]', 'markitdown'])
      cb(null, '# Converted\n\nHello\n', '')
    })

    const stdout = collectStream()

    await runCli(
      [
        '--model',
        'xai/grok-4-fast-non-reasoning',
        '--format',
        'md',
        '--timeout',
        '2s',
        '--stream',
        'on',
        pdfPath,
      ],
      {
        env: { XAI_API_KEY: 'test', UVX_PATH: 'uvx' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        execFile: execFileMock as unknown as ExecFileFn,
        stdout: stdout.stream,
        stderr: noopStream(),
      }
    )

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)
    const context = mocks.streamSimple.mock.calls[0]?.[1] as {
      messages?: Array<{ content?: unknown }>
    }
    expect(String(context.messages?.[0]?.content ?? '')).toContain('# Converted')
    expect(stdout.getText()).toContain('OK')
  })

  it('sends PDFs directly to Anthropic without markitdown when supported', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['OK\n'],
        makeAssistantMessage({ text: 'OK\n', usage: { input: 1, output: 1, totalTokens: 2 } })
      )
    )
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-preprocess-anthropic-pdf-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%PDF minimal\n%%EOF\n', 'utf8'))

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      void file
      void args
      cb(null, '# Converted\n\nShould not run\n', '')
    })

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'OK' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const stdout = collectStream()

    await runCli(
      [
        '--model',
        'anthropic/claude-opus-4-5',
        '--timeout',
        '2s',
        '--stream',
        'on',
        '--plain',
        pdfPath,
      ],
      {
        env: { ANTHROPIC_API_KEY: 'test', UVX_PATH: 'uvx' },
        fetch: fetchMock as unknown as typeof fetch,
        execFile: execFileMock as unknown as ExecFileFn,
        stdout: stdout.stream,
        stderr: noopStream(),
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(execFileMock).toHaveBeenCalledTimes(0)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(options.body))
    expect(body.messages?.[0]?.content?.[0]?.type).toBe('document')
  })

  it('sends PDFs directly to OpenAI without markitdown when supported', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['OK\n'],
        makeAssistantMessage({ text: 'OK\n', usage: { input: 1, output: 1, totalTokens: 2 } })
      )
    )
    mocks.streamSimple.mockClear()
    process.env.OPENAI_BASE_URL = ''

    const root = mkdtempSync(join(tmpdir(), 'summarize-preprocess-openai-pdf-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%PDF minimal\n%%EOF\n', 'utf8'))

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      void file
      void args
      cb(null, '# Converted\n\nShould not run\n', '')
    })

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text: 'OK',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const stdout = collectStream()

    await runCli(
      ['--model', 'openai/gpt-5.2', '--timeout', '2s', '--stream', 'on', '--plain', pdfPath],
      {
        env: { OPENAI_API_KEY: 'test', UVX_PATH: 'uvx' },
        fetch: fetchMock as unknown as typeof fetch,
        execFile: execFileMock as unknown as ExecFileFn,
        stdout: stdout.stream,
        stderr: noopStream(),
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(execFileMock).toHaveBeenCalledTimes(0)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(options.body))
    expect(body.input?.[0]?.content?.[0]?.type).toBe('input_file')
  })

  it('errors when --preprocess off is used for PDFs (no binary attachments)', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['OK\n'],
        makeAssistantMessage({ text: 'OK\n', usage: { input: 1, output: 1, totalTokens: 2 } })
      )
    )
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-preprocess-always-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      void file
      void args
      cb(null, '# Converted\n\nAlways\n', '')
    })

    const run = () =>
      runCli(
        [
          '--model',
          'xai/grok-4-fast-non-reasoning',
          '--preprocess',
          'off',
          '--timeout',
          '2s',
          '--stream',
          'on',
          pdfPath,
        ],
        {
          env: { XAI_API_KEY: 'test', UVX_PATH: 'uvx' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          execFile: execFileMock as unknown as ExecFileFn,
          stdout: noopStream(),
          stderr: noopStream(),
        }
      )

    await expect(run()).rejects.toThrow(/does not support attaching binary files/i)
    expect(execFileMock).toHaveBeenCalledTimes(0)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })
})
