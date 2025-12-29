import { describe, expect, it } from 'vitest'

import {
  type AssetAttachment,
  assertAssetMediaTypeSupported,
  getTextContentFromAttachment,
  isTextLikeMediaType,
  isUnsupportedAttachmentError,
  supportsNativeFileAttachment,
} from '../src/run/attachments.js'

describe('run/attachments', () => {
  it('detects unsupported attachment errors', () => {
    expect(isUnsupportedAttachmentError(null)).toBe(false)
    expect(isUnsupportedAttachmentError(new Error('Functionality not supported'))).toBe(true)
    expect(isUnsupportedAttachmentError({ name: 'UnsupportedFunctionalityError' })).toBe(true)
  })

  it('detects text-like media types', () => {
    expect(isTextLikeMediaType('text/plain')).toBe(true)
    expect(isTextLikeMediaType('application/json')).toBe(true)
    expect(isTextLikeMediaType('application/pdf')).toBe(false)
  })

  it('extracts text content from file attachments', () => {
    const a1 = {
      kind: 'file',
      mediaType: 'application/json',
      bytes: new TextEncoder().encode('{"ok":true}'),
      filename: 'a.json',
    } as unknown as AssetAttachment
    expect(getTextContentFromAttachment(a1)).toMatchObject({ content: '{"ok":true}' })

    const a2 = {
      kind: 'file',
      mediaType: 'application/xml',
      bytes: new TextEncoder().encode('<ok/>'),
      filename: 'a.xml',
    } as unknown as AssetAttachment
    expect(getTextContentFromAttachment(a2)?.content).toContain('<ok/>')

    const a3 = {
      kind: 'file',
      mediaType: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.7'),
    } as unknown as AssetAttachment
    expect(getTextContentFromAttachment(a3)).toBeNull()
  })

  it('rejects archive media types', () => {
    const zip = {
      kind: 'file',
      mediaType: 'application/zip',
      bytes: new Uint8Array([1]),
    } as unknown as AssetAttachment
    expect(() => assertAssetMediaTypeSupported({ attachment: zip, sizeLabel: '1B' })).toThrow(
      /Unsupported file type/i
    )
  })

  it('detects native file attachment support', () => {
    expect(
      supportsNativeFileAttachment({
        provider: 'anthropic',
        attachment: { kind: 'file', mediaType: 'application/pdf' },
      })
    ).toBe(true)
    expect(
      supportsNativeFileAttachment({
        provider: 'openai',
        attachment: { kind: 'file', mediaType: 'application/pdf' },
      })
    ).toBe(true)
    expect(
      supportsNativeFileAttachment({
        provider: 'google',
        attachment: { kind: 'file', mediaType: 'application/pdf' },
      })
    ).toBe(true)
  })
})
