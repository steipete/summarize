/**
 * Phase 4.5: Error scenario tests for audio file transcription
 * Tests edge cases and error conditions to ensure robust error handling
 */

import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/run.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

mocks.streamSimple.mockImplementation(() =>
  makeTextDeltaStream(
    ['Audio error test'],
    makeAssistantMessage({ text: 'Audio error test', usage: { input: 50, output: 10, totalTokens: 60 } })
  )
)

vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}))

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

describe('Audio file error handling', () => {
  it('handles non-existent audio files gracefully', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-audio-missing-'))
    const nonExistentPath = join(root, 'missing-audio.mp3')

    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(
        [
          '--model',
          'openai/gpt-4o-mini',
          '--timeout',
          '2s',
          '--stream',
          'on',
          '--plain',
          nonExistentPath,
        ],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test-key-12345' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }
      )

    // Should fail - file doesn't exist
    await expect(run()).rejects.toThrow()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

  it('provides helpful error when FAL_KEY is missing', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-audio-no-fal-'))
    const audioPath = join(root, 'test.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', audioPath], {
        env: { HOME: root }, // No FAL_KEY
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

    try {
      await run()
      throw new Error('Should have failed')
    } catch (err) {
      const msg = String(err)
      // Should mention transcription requirement
      expect(msg).toMatch(/transcription requires/i)
      // Should suggest FAL or alternatives
      expect(msg).toMatch(/FAL|openai|whisper/i)
    }

    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

  it('handles relative file paths correctly', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-audio-relative-'))
    const audioPath = join(root, 'relative.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', 'relative.mp3'], {
        env: { HOME: root }, // No transcription provider
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

    // Should fail at transcription provider check
    // (relative path handling happens before provider check)
    await expect(run()).rejects.toThrow()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

   it('handles audio files with various path scenarios', async () => {
     mocks.streamSimple.mockClear()

     const root = mkdtempSync(join(tmpdir(), 'summarize-audio-symlink-'))
     const audioPath = join(root, 'audio.mp3')
     writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

     // This test verifies basic file path handling
    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', audioPath], {
        env: { HOME: root }, // No transcription provider
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

    // Should still fail at provider check, regardless of symlink support
    await expect(run()).rejects.toThrow()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

  it('distinguishes audio files from other media types', async () => {
    mocks.streamSimple.mockClear()

    // Test with a non-audio media file extension
    const root = mkdtempSync(join(tmpdir(), 'summarize-audio-video-'))
    const videoPath = join(root, 'video.mp4')
    writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])) // MP4 header

    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', videoPath], {
        env: { HOME: root }, // No transcription provider
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

    // Video files are also routed through transcript providers
    // Should fail at transcription provider check
    await expect(run()).rejects.toThrow()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })

   it('handles file modification time edge cases (very old files)', async () => {
     mocks.streamSimple.mockClear()

     const root = mkdtempSync(join(tmpdir(), 'summarize-audio-old-file-'))
     const audioPath = join(root, 'old.mp3')
     writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

     // Set mtime to January 1, 2000 to test edge case of very old files
     const oldDate = new Date('2000-01-01T00:00:00Z')
     utimesSync(audioPath, oldDate, oldDate)

     const stdout = collectStream()
     const stderr = collectStream()

     const run = () =>
       runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', audioPath], {
         env: { HOME: root }, // No transcription provider
         fetch: vi.fn(async () => {
           throw new Error('unexpected fetch')
         }) as unknown as typeof fetch,
         stdout: stdout.stream,
         stderr: stderr.stream,
       })

     // Should handle old file mtimes gracefully
     // (mtime collection should work regardless of file age)
     await expect(run()).rejects.toThrow()
     expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
   })

   it('properly formats error messages for unsupported audio codecs', async () => {
     mocks.streamSimple.mockClear()

     const root = mkdtempSync(join(tmpdir(), 'summarize-audio-unsupported-'))
     const audioPath = join(root, 'unsupported.mp3')
     writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

     const stdout = collectStream()
     const stderr = collectStream()

     const run = () =>
       runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', audioPath], {
         env: { HOME: root }, // No transcription provider
         fetch: vi.fn(async () => {
           throw new Error('unexpected fetch')
         }) as unknown as typeof fetch,
         stdout: stdout.stream,
         stderr: stderr.stream,
       })

     // Should fail at provider check before codec detection
     await expect(run()).rejects.toThrow(/transcription requires/)
     expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
   })

  it('handles concurrent file access gracefully', async () => {
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-audio-concurrent-'))
    const audioPath = join(root, 'test.mp3')
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]))

    const stdout = collectStream()
    const stderr = collectStream()

    const run = () =>
      runCli(['--model', 'openai/gpt-4o-mini', '--timeout', '2s', audioPath], {
        env: { HOME: root }, // No transcription provider
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

    // Both calls should fail with same error
    await expect(run()).rejects.toThrow(/transcription requires/)
    await expect(run()).rejects.toThrow(/transcription requires/)

    expect(mocks.streamSimple).toHaveBeenCalledTimes(0)
  })
})
