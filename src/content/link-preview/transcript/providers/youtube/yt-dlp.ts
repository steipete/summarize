import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFalClient } from '@fal-ai/client'

const YT_DLP_TIMEOUT_MS = 300_000 // 5 minutes for download
const FAL_TIMEOUT_MS = 600_000 // 10 minutes for transcription

export const fetchTranscriptWithYtDlp = async (
  ytDlpPath: string | null,
  falApiKey: string | null,
  url: string
): Promise<string | null> => {
  if (!ytDlpPath || !falApiKey) {
    return null
  }

  const tempDir = tmpdir()
  const outputFile = join(tempDir, `summarize-${randomUUID()}.mp3`)

  try {
    // 1. Download audio with yt-dlp
    await downloadAudio(ytDlpPath, url, outputFile)

    // 2. Read the downloaded file
    const audioBytes = await fs.readFile(outputFile)

    // 3. Upload to FAL AI storage
    const fal = createFalClient({ credentials: falApiKey })
    const audioUrl = await fal.storage.upload(new Blob([audioBytes], { type: 'audio/mpeg' }))

    // 4. Transcribe with Wizper
    const result = await Promise.race([
      fal.subscribe('fal-ai/wizper', {
        input: { audio_url: audioUrl, language: 'en' },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('FAL transcription timeout')), FAL_TIMEOUT_MS)
      ),
    ])

    // Extract text from result
    const text = extractText(result)
    return text
  } catch {
    return null
  } finally {
    // Cleanup temp file
    await fs.unlink(outputFile).catch(() => {})
  }
}

function extractText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const data = 'data' in result ? (result as { data: unknown }).data : result
  if (typeof data !== 'object' || data === null) return null
  if ('text' in data && typeof (data as { text: unknown }).text === 'string') {
    const text = (data as { text: string }).text.trim()
    return text.length > 0 ? text : null
  }
  // Fallback: concatenate chunks
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

async function downloadAudio(
  ytDlpPath: string,
  url: string,
  outputFile: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-x',
      '--audio-format',
      'mp3',
      '--retries',
      '3',
      '--no-warnings',
      '-o',
      outputFile,
      url,
    ]

    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('yt-dlp download timeout'))
    }, YT_DLP_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
