import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

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

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: vi.fn(async ({ modelId }: { modelId: string }) => {
    if (/allenai\/olmo/i.test(modelId)) {
      throw new Error('LLM request timed out after 10000ms (model openai/allenai/olmo-3.1).')
    }
    throw new Error('No allowed providers are available for the selected model.')
  }),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error('unexpected stream call')
  }),
}))

describe('model bags: OpenRouter "no allowed providers" beats timeout', () => {
  it('throws OpenRouter providers hint even if the last attempt times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-bag-providers-'))
    const filePath = join(root, 'input.txt')
    writeFileSync(filePath, 'hello world', 'utf8')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      join(root, '.summarize', 'config.json'),
      JSON.stringify({
        bags: {
          free: {
            mode: 'auto',
            rules: [
              {
                candidates: [
                  'openrouter/google/gemini-2.0-flash-exp:free',
                  'openrouter/allenai/olmo-3.1-32b-think:free',
                ],
              },
            ],
          },
        },
      }),
      'utf8'
    )

    const stdout = collectStream()
    const stderr = collectStream()

    await expect(
      runCli(['--model', 'free', '--timeout', '10s', '--render', 'plain', filePath], {
        env: { HOME: root, OPENROUTER_API_KEY: 'test' },
        fetch: async () => new Response('{}', { status: 404 }),
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/OpenRouter could not route any models/i)

    expect(stdout.getText()).not.toContain('hello world')
    expect(stderr.getText()).not.toMatch(/\bvia\b/i)
  })
})
