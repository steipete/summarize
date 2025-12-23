import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildAssetPromptMessages,
  classifyUrl,
  loadLocalAsset,
  loadRemoteAsset,
  resolveInputTarget,
} from '../src/content/asset.js'

describe('asset loaders', () => {
  it('rejects non-files and oversize local files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-'))
    const dirPath = join(root, 'dir')
    mkdirSync(dirPath, { recursive: true })
    await expect(loadLocalAsset({ filePath: dirPath })).rejects.toThrow(/Not a file/i)

    const bigPath = join(root, 'big.bin')
    writeFileSync(bigPath, Buffer.alloc(10, 0))
    await expect(loadLocalAsset({ filePath: bigPath, maxBytes: 5 })).rejects.toThrow(
      /File too large/i
    )
  })

  it('rejects remote non-200 and oversize downloads', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        fetchImpl: async () => new Response('nope', { status: 500 }),
      })
    ).rejects.toThrow(/Download failed/i)

    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        maxBytes: 10,
        fetchImpl: async () =>
          new Response(new Uint8Array(1), { status: 200, headers: { 'content-length': '999' } }),
      })
    ).rejects.toThrow(/Remote file too large/i)

    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        maxBytes: 10,
        fetchImpl: async () => new Response(Buffer.alloc(11), { status: 200 }),
      })
    ).rejects.toThrow(/Remote file too large/i)
  })

  it('detects HTML masquerading as a file', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        fetchImpl: async () =>
          new Response('<html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      })
    ).rejects.toThrow(/appears to be a website/i)
  })

  it('creates image parts when media type is image/*', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-img-'))
    const jpgPath = join(root, 'test.jpg')
    // Minimal JPEG header.
    writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]))

    const loaded = await loadLocalAsset({ filePath: jpgPath, maxBytes: 1024 })
    expect(loaded.attachment.mediaType).toBe('image/jpeg')
    expect(loaded.attachment.part.type).toBe('image')
  })

  it('detects HTML based on bytes when content-type is missing', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/',
        timeoutMs: 2000,
        fetchImpl: async () =>
          new Response('<!doctype html><html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
      })
    ).rejects.toThrow(/appears to be a website/i)
  })

  it('loads a remote asset when headers specify media type', async () => {
    const loaded = await loadRemoteAsset({
      url: 'https://example.com/image.png',
      timeoutMs: 2000,
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    })

    expect(loaded.attachment.mediaType).toBe('image/png')
    expect(loaded.attachment.part.type).toBe('image')
  })
})

describe('asset helpers', () => {
  it('resolves input targets from files and urls', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-input-'))
    const filePath = join(root, 'doc.txt')
    writeFileSync(filePath, 'hello')

    expect(resolveInputTarget(filePath)).toEqual({ kind: 'file', filePath })

    expect(resolveInputTarget('https://example.com/file.pdf')).toEqual({
      kind: 'url',
      url: 'https://example.com/file.pdf',
    })
  })

  it('resolves embedded urls and trims punctuation', () => {
    const target = resolveInputTarget('See https://example.com/file.pdf).')
    expect(target).toEqual({ kind: 'url', url: 'https://example.com/file.pdf' })
  })

  it('handles file urls and rejects unsupported protocols', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-file-url-'))
    const filePath = join(root, 'report.txt')
    writeFileSync(filePath, 'hello')
    const fileUrl = new URL(`file://${filePath}`)

    expect(resolveInputTarget(fileUrl.toString())).toEqual({ kind: 'file', filePath })
    expect(() => resolveInputTarget('ftp://example.com/file.pdf')).toThrow(/Only HTTP and HTTPS/)
  })

  it('rescues embedded http urls from non-http schemes', () => {
    const target = resolveInputTarget('ftp://example.com/http://example.com/asset.png')
    expect(target).toEqual({ kind: 'url', url: 'http://example.com/asset.png' })
  })

  it('throws on invalid inputs', () => {
    expect(() => resolveInputTarget('')).toThrow(/Missing input/)
    expect(() => resolveInputTarget('not a url')).toThrow(/Invalid URL or file path/)
  })

  it('classifies urls as assets or websites', async () => {
    await expect(
      classifyUrl({
        url: 'https://example.com/image.jpg',
        fetchImpl: fetch,
        timeoutMs: 10,
      })
    ).resolves.toEqual({ kind: 'asset' })

    await expect(
      classifyUrl({
        url: 'https://example.com/page.html',
        fetchImpl: fetch,
        timeoutMs: 10,
      })
    ).resolves.toEqual({ kind: 'website' })
  })

  it('builds prompt messages with attachments', () => {
    const attachment = {
      mediaType: 'image/png',
      filename: 'image.png',
      part: { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
    }
    const messages = buildAssetPromptMessages({ promptText: 'Summarize', attachment })
    expect(messages[0]?.role).toBe('user')
    const content = messages[0]?.content ?? []
    expect(content).toHaveLength(2)
  })
})
