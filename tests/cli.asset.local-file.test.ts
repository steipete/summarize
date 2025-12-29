import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ExecFileFn } from '../src/markitdown.js'
import { runCli } from '../src/run.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

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
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

mocks.streamSimple.mockImplementation(() =>
  makeTextDeltaStream(
    ['OK'],
    makeAssistantMessage({ text: 'OK', usage: { input: 10, output: 2, totalTokens: 12 } })
  )
)

vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}))

const execFileMock: ExecFileFn = ((file, args, _options, callback) => {
  void file
  void args
  callback(null, '# converted\n\nhello\n', '')
  return { pid: 123 } as unknown as ChildProcess
}) as ExecFileFn

describe('cli asset inputs (local file)', () => {
  it('attaches a local PDF when the provider supports file attachments', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const stdout = collectStream()
    const stderr = collectStream()

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://api.openai.com/v1/responses')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          input?: Array<{ content?: Array<{ type?: string; file_data?: string }> }>
        }
        const fileBlock = body.input?.[0]?.content?.[0]
        expect(fileBlock?.type).toBe('input_file')
        expect(fileBlock?.file_data).toBeTruthy()
        return new Response(JSON.stringify({ output_text: 'OK' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    await runCli(
      ['--model', 'openai/gpt-5.2', '--timeout', '2s', '--stream', 'on', '--plain', pdfPath],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test', UVX_PATH: 'uvx' },
        fetch: fetchMock as unknown as typeof fetch,
        execFile: execFileMock,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)

    globalFetchSpy.mockRestore()
  })

  it('inlines text files into the prompt instead of attaching a file part', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-txt-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'test.txt')
    writeFileSync(txtPath, 'Hello from text file.\nSecond line.\n', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      ['--model', 'openai/gpt-5.2', '--timeout', '2s', '--stream', 'on', '--plain', txtPath],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)
    const context = mocks.streamSimple.mock.calls[0]?.[1] as {
      messages?: Array<{ role: string; content: unknown }>
    }
    expect(String(context.messages?.[0]?.content ?? '')).toContain('Hello from text file.')

    globalFetchSpy.mockRestore()
  })

  it('allows xAI models to summarize local text files (inlined prompt)', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-txt-xai-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'grok-4-fast-non-reasoning': {
          input_cost_per_token: 0.0000002,
          output_cost_per_token: 0.0000008,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'test.txt')
    writeFileSync(txtPath, 'Hello from xAI text file.\nSecond line.\n', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'xai/grok-4-fast-non-reasoning',
        '--timeout',
        '2s',
        '--stream',
        'on',
        '--plain',
        txtPath,
      ],
      {
        env: { HOME: root, XAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)
    const context = mocks.streamSimple.mock.calls[0]?.[1] as {
      messages?: Array<{ role: string; content: unknown }>
    }
    expect(String(context.messages?.[0]?.content ?? '')).toContain('Hello from xAI text file.')

    globalFetchSpy.mockRestore()
  })

  it('rejects local text files that exceed the input token limit', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-token-limit-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': {
          max_input_tokens: 10,
          input_cost_per_token: 0.00000175,
          output_cost_per_token: 0.000014,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'test.txt')
    writeFileSync(txtPath, 'A'.repeat(2000), 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()

    await expect(
      runCli(
        ['--model', 'openai/gpt-5.2', '--timeout', '2s', '--stream', 'on', '--plain', txtPath],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }
      )
    ).rejects.toThrow(/Input token count/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)

    globalFetchSpy.mockRestore()
  })

  it('rejects local text files above the 10 MB limit before tokenizing', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-size-limit-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'huge.txt')
    writeFileSync(txtPath, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'))

    const run = () =>
      runCli(
        ['--model', 'openai/gpt-5.2', '--timeout', '2s', '--stream', 'on', '--plain', txtPath],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          stdout: collectStream().stream,
          stderr: collectStream().stream,
        }
      )

    await expect(run()).rejects.toThrow(/Text file too large/i)
    await expect(run()).rejects.toThrow(/10 MB/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)

    globalFetchSpy.mockRestore()
  })

  it('errors early for zip archives with a helpful message', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-zip-'))
    const zipPath = join(root, 'JetBrainsMono-2.304.zip')
    // ZIP local file header: PK\x03\x04
    writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]))

    const run = () =>
      runCli(['--model', 'google/gemini-3-flash-preview', '--timeout', '2s', zipPath], {
        env: { HOME: root },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      })

    await expect(run()).rejects.toThrow(/Unsupported file type/i)
    await expect(run()).rejects.toThrow(/application\/zip/i)
    await expect(run()).rejects.toThrow(/unzip/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

  it('errors when a text file exceeds the size limit', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-large-'))
    const txtPath = join(root, 'large.txt')
    const oversizeBytes = 10 * 1024 * 1024 + 1
    writeFileSync(txtPath, Buffer.alloc(oversizeBytes, 'a'))

    const run = () =>
      runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', txtPath], {
        env: { OPENAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      })

    await expect(run()).rejects.toThrow(/Text file too large/i)
    await expect(run()).rejects.toThrow(/Limit is 10 MB/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

  it('errors when a text file exceeds the model input token limit', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-tokens-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': {
          max_input_tokens: 10,
          input_cost_per_token: 0.00000175,
          output_cost_per_token: 0.000014,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'tokens.txt')
    writeFileSync(txtPath, 'hello '.repeat(50), 'utf8')

    const run = () =>
      runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', txtPath], {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      })

    await expect(run()).rejects.toThrow(/token count/i)
    await expect(run()).rejects.toThrow(/input limit/i)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)

    globalFetchSpy.mockRestore()
  })
})
