import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readTweetWithBird, withBirdTip } from '../src/run/bird.js'
import { BIRD_TIP } from '../src/run/constants.js'

const makeBirdScript = (script: string) => {
  const root = mkdtempSync(join(tmpdir(), 'summarize-bird-'))
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const birdPath = join(binDir, 'bird')
  writeFileSync(birdPath, script, 'utf8')
  chmodSync(birdPath, 0o755)
  return { root, binDir }
}

const scriptForJson = (payload: unknown) => {
  const json = JSON.stringify(payload)
  return `#!/bin/sh\necho '${json}'\n`
}

describe('bird helpers', () => {
  it('reads tweets and extracts media from extended entities', async () => {
    const payload = {
      id: '1',
      text: 'Hello from bird',
      _raw: {
        legacy: {
          extended_entities: {
            media: [
              { type: 'photo' },
              {
                type: 'audio',
                video_info: {
                  variants: [
                    { url: 'not-a-url', content_type: 'video/mp4', bitrate: 64 },
                    {
                      url: 'https://video.twimg.com/low.mp4',
                      content_type: 'video/mp4',
                      bitrate: 120,
                    },
                    {
                      url: 'https://video.twimg.com/high.mp4',
                      content_type: 'video/mp4',
                      bitrate: 240,
                    },
                    { url: 'https://video.twimg.com/playlist.m3u8', content_type: 'text/plain' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    const { binDir } = makeBirdScript(scriptForJson(payload))
    const result = await readTweetWithBird({
      url: 'https://x.com/user/status/123',
      timeoutMs: 1000,
      env: { PATH: binDir },
    })

    expect(result.text).toBe('Hello from bird')
    expect(result.media?.source).toBe('extended_entities')
    expect(result.media?.kind).toBe('audio')
    expect(result.media?.preferredUrl).toBe('https://video.twimg.com/high.mp4')
    expect(result.media?.urls).toContain('https://video.twimg.com/low.mp4')
  })

  it('extracts broadcast urls from cards when no extended media exists', async () => {
    const payload = {
      id: '2',
      text: 'Card media',
      _raw: {
        card: {
          legacy: {
            binding_values: [
              { key: 'ignored', value: { string_value: 'nope' } },
              { key: 'broadcast_url', value: { string_value: 'https://x.com/i/broadcasts/1' } },
            ],
          },
        },
      },
    }
    const { binDir } = makeBirdScript(scriptForJson(payload))
    const result = await readTweetWithBird({
      url: 'https://twitter.com/user/status/456',
      timeoutMs: 1000,
      env: { PATH: binDir },
    })

    expect(result.media?.source).toBe('card')
    expect(result.media?.preferredUrl).toBe('https://x.com/i/broadcasts/1')
  })

  it('extracts video urls from entities when no card is present', async () => {
    const payload = {
      id: '3',
      text: 'Entities media',
      _raw: {
        legacy: {
          entities: {
            urls: [
              { expanded_url: 'https://example.com/article' },
              { expanded_url: 'https://video.twimg.com/ext.mp4' },
            ],
          },
        },
      },
    }
    const { binDir } = makeBirdScript(scriptForJson(payload))
    const result = await readTweetWithBird({
      url: 'https://x.com/user/status/789',
      timeoutMs: 1000,
      env: { PATH: binDir },
    })

    expect(result.media?.source).toBe('entities')
    expect(result.media?.preferredUrl).toBe('https://video.twimg.com/ext.mp4')
  })

  it('surfaces bird errors, empty output, and invalid payloads', async () => {
    const { binDir: errorBin } = makeBirdScript('#!/bin/sh\necho "boom" 1>&2\nexit 1\n')
    await expect(
      readTweetWithBird({
        url: 'https://x.com/user/status/1',
        timeoutMs: 1000,
        env: { PATH: errorBin },
      })
    ).rejects.toThrow(/bird read failed: boom/)

    const { binDir: emptyBin } = makeBirdScript('#!/bin/sh\n')
    await expect(
      readTweetWithBird({
        url: 'https://x.com/user/status/1',
        timeoutMs: 1000,
        env: { PATH: emptyBin },
      })
    ).rejects.toThrow(/bird read returned empty output/)

    const { binDir: invalidJson } = makeBirdScript('#!/bin/sh\necho "not json"\n')
    await expect(
      readTweetWithBird({
        url: 'https://x.com/user/status/1',
        timeoutMs: 1000,
        env: { PATH: invalidJson },
      })
    ).rejects.toThrow(/bird read returned invalid JSON/)

    const { binDir: invalidPayload } = makeBirdScript(scriptForJson({ id: '1' }))
    await expect(
      readTweetWithBird({
        url: 'https://x.com/user/status/1',
        timeoutMs: 1000,
        env: { PATH: invalidPayload },
      })
    ).rejects.toThrow(/bird read returned invalid payload/)
  })

  it('adds bird install tips only when needed', () => {
    const baseError = new Error('nope')
    const url = 'https://x.com/user/status/123'
    const tipError = withBirdTip(baseError, url, { PATH: '' })
    expect(tipError.message).toContain(BIRD_TIP)

    const { binDir } = makeBirdScript('#!/bin/sh\nexit 0\n')
    const noTip = withBirdTip(baseError, url, { PATH: binDir })
    expect(noTip.message).toBe(baseError.message)

    const nonStatus = withBirdTip(baseError, 'https://x.com/user', { PATH: '' })
    expect(nonStatus.message).toBe(baseError.message)
  })
})
