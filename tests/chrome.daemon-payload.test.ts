import { describe, expect, it } from 'vitest'

import {
  buildDaemonRequestBody,
  buildSummarizeRequestBody,
} from '../apps/chrome-extension/src/lib/daemon-payload.js'
import { defaultSettings } from '../apps/chrome-extension/src/lib/settings.js'

describe('chrome/daemon-payload', () => {
  it('builds a stable daemon request body', () => {
    const body = buildDaemonRequestBody({
      extracted: {
        url: 'https://example.com/article',
        title: 'Hello',
        text: 'Content',
        truncated: false,
      },
      settings: { ...defaultSettings, token: 't', model: 'auto', length: 'xl', language: 'auto' },
    })

    expect(body).toEqual({
      url: 'https://example.com/article',
      title: 'Hello',
      text: 'Content',
      truncated: false,
      model: 'auto',
      length: 'xl',
      language: 'auto',
      maxCharacters: defaultSettings.maxChars,
    })
  })

  it('includes advanced overrides when set', () => {
    const body = buildDaemonRequestBody({
      extracted: {
        url: 'https://example.com/article',
        title: 'Hello',
        text: 'Content',
        truncated: false,
      },
      settings: {
        ...defaultSettings,
        token: 't',
        requestMode: 'url',
        firecrawlMode: 'auto',
        markdownMode: 'llm',
        preprocessMode: 'always',
        youtubeMode: 'no-auto',
        timeout: '90s',
        retries: 2,
        maxOutputTokens: '2k',
      },
    })

    expect(body).toEqual({
      url: 'https://example.com/article',
      title: 'Hello',
      text: 'Content',
      truncated: false,
      model: 'auto',
      length: 'xl',
      language: 'auto',
      mode: 'url',
      firecrawl: 'auto',
      markdownMode: 'llm',
      preprocess: 'always',
      youtube: 'no-auto',
      timeout: '90s',
      retries: 2,
      maxOutputTokens: '2k',
      maxCharacters: defaultSettings.maxChars,
    })
  })

  it('forces transcript video mode when inputMode=video', () => {
    const body = buildSummarizeRequestBody({
      extracted: {
        url: 'https://example.com/video',
        title: 'Video',
        text: '',
        truncated: false,
      },
      settings: defaultSettings,
      inputMode: 'video',
    })

    expect(body.mode).toBe('url')
    expect(body.videoMode).toBe('transcript')
  })

  it('forces page mode when inputMode=page', () => {
    const body = buildSummarizeRequestBody({
      extracted: {
        url: 'https://example.com/article',
        title: 'Article',
        text: 'Hello',
        truncated: false,
      },
      settings: defaultSettings,
      inputMode: 'page',
    })

    expect(body.mode).toBe('page')
    expect(body.videoMode).toBeUndefined()
  })

  it('adds timestamps when requested', () => {
    const body = buildSummarizeRequestBody({
      extracted: {
        url: 'https://example.com/video',
        title: 'Video',
        text: '',
        truncated: false,
      },
      settings: defaultSettings,
      timestamps: true,
    })

    expect(body.timestamps).toBe(true)
  })

  it('requests slides when enabled', () => {
    const body = buildSummarizeRequestBody({
      extracted: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Video',
        text: '',
        truncated: false,
      },
      settings: { ...defaultSettings, slidesEnabled: true },
      slidesEnabled: true,
    })

    expect(body.slides).toBe(true)
    expect(body.slidesOcr).toBe(true)
    expect(body.mode).not.toBe('page')
  })
})
