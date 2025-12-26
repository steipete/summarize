import { createFalClient } from '@fal-ai/client'
import { TRANSCRIPTION_TIMEOUT_MS } from './constants.js'
import { toArrayBuffer } from './utils.js'

export async function transcribeWithFal(
  bytes: Uint8Array,
  mediaType: string,
  apiKey: string
): Promise<string | null> {
  const fal = createFalClient({ credentials: apiKey })
  const blob = new Blob([toArrayBuffer(bytes)], { type: mediaType })
  const audioUrl = await fal.storage.upload(blob)

  const result = await Promise.race([
    fal.subscribe('fal-ai/wizper', {
      input: { audio_url: audioUrl, language: 'en' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('FAL transcription timeout')), TRANSCRIPTION_TIMEOUT_MS)
    ),
  ])

  return extractText(result)
}

function extractText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const data = 'data' in result ? (result as { data: unknown }).data : result
  if (typeof data !== 'object' || data === null) return null
  if ('text' in data && typeof (data as { text: unknown }).text === 'string') {
    const text = (data as { text: string }).text.trim()
    return text.length > 0 ? text : null
  }
  if ('chunks' in data && Array.isArray((data as { chunks: unknown }).chunks)) {
    const chunks = (data as { chunks: unknown[] }).chunks
    const lines: string[] = []
    for (const chunk of chunks) {
      if (typeof chunk === 'object' && chunk !== null && 'text' in chunk) {
        const text = (chunk as { text: unknown }).text
        if (typeof text === 'string' && text.trim()) {
          lines.push(text.trim())
        }
      }
    }
    return lines.length > 0 ? lines.join(' ') : null
  }
  return null
}
