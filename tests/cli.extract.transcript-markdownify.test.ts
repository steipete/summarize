import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const jsonResponse = (payload: unknown, status = 200) =>
  Response.json(payload, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli --extract --format md --markdown-mode llm (transcript markdownify)', () => {
  it('converts YouTube transcript to markdown via LLM when --markdown-mode llm is specified', async () => {
    const youtubeHtml =
      '<!doctype html><html><head><title>How to Speak</title><meta name="description" content="MIT lecture" />' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions"}]}},"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body><main><p>Fallback</p></main></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')

      // YouTube page fetch
      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }

      // YouTube transcript API
      if (url.includes('youtubei/v1/get_transcript')) {
        return Promise.resolve(
          jsonResponse({
            actions: [
              {
                updateEngagementPanelAction: {
                  content: {
                    transcriptRenderer: {
                      content: {
                        transcriptSearchPanelRenderer: {
                          body: {
                            transcriptSegmentListRenderer: {
                              initialSegments: [
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'SPEAKER: Hello everyone.' }] },
                                  },
                                },
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'Um, today we talk about speaking.' }] },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          })
        )
      }

      // OpenRouter API call for transcript→markdown conversion
      if (url.includes('openrouter.ai') || url.includes('openai.com')) {
        const body = JSON.parse((init?.body as string) ?? '{}')
        // Verify the prompt contains transcript-specific instructions
        const systemMessage = body.messages?.find((m: { role: string }) => m.role === 'system')
        expect(systemMessage?.content).toContain('convert raw transcripts')

        return Promise.resolve(
          jsonResponse({
            id: 'test-id',
            object: 'chat.completion',
            created: Date.now(),
            model: 'openai/gpt-5-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '# How to Speak\n\nHello everyone. Today we talk about speaking.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          })
        )
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const stdoutChunks: string[] = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(chunk.toString())
        callback()
      },
    })

    const stderrChunks: string[] = []
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(
      [
        '--extract',
        '--format',
        'md',
        '--markdown-mode',
        'llm',
        '--timeout',
        '10s',
        'https://www.youtube.com/watch?v=abcdefghijk',
      ],
      {
        env: { OPENROUTER_API_KEY: 'test-key' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    const output = stdoutChunks.join('')
    // Should contain the LLM-formatted markdown, not raw transcript
    expect(output).toContain('# How to Speak')
    expect(output).toContain('Hello everyone')
    // Should NOT contain the raw "SPEAKER:" prefix or "Um,"
    expect(output).not.toContain('SPEAKER:')
  })

  it('outputs raw transcript when --markdown-mode is not llm (default behavior)', async () => {
    const youtubeHtml =
      '<!doctype html><html><head><title>Test Video</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions"}]}},"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body><main><p>Fallback</p></main></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')

      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }

      if (url.includes('youtubei/v1/get_transcript')) {
        return Promise.resolve(
          jsonResponse({
            actions: [
              {
                updateEngagementPanelAction: {
                  content: {
                    transcriptRenderer: {
                      content: {
                        transcriptSearchPanelRenderer: {
                          body: {
                            transcriptSegmentListRenderer: {
                              initialSegments: [
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'Raw transcript line one' }] },
                                  },
                                },
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'Raw transcript line two' }] },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          })
        )
      }

      // Should NOT call any LLM API
      if (url.includes('openrouter.ai') || url.includes('openai.com')) {
        throw new Error('LLM API should not be called without --markdown-mode llm')
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const stdoutChunks: string[] = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(
      ['--extract', '--timeout', '10s', 'https://www.youtube.com/watch?v=abcdefghijk'],
      {
        env: { OPENROUTER_API_KEY: 'test-key' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({ write: (_c, _e, cb) => cb() }),
      }
    )

    const output = stdoutChunks.join('')
    // Should contain raw transcript
    expect(output).toContain('Raw transcript line one')
    expect(output).toContain('Raw transcript line two')
  })

  it('requires API key when --markdown-mode llm is specified', async () => {
    const youtubeHtml =
      '<!doctype html><html><head><title>Test</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST"}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')
      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const noopStream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      })

    // Should throw an error about missing API key
    await expect(
      runCli(
        [
          '--extract',
          '--format',
          'md',
          '--markdown-mode',
          'llm',
          'https://www.youtube.com/watch?v=test',
        ],
        {
          env: {}, // No API keys
          fetch: fetchMock as unknown as typeof fetch,
          stdout: noopStream(),
          stderr: noopStream(),
        }
      )
    ).rejects.toThrow(/GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/)
  })
})
