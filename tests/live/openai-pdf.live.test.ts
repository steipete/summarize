import { describe, expect, it } from 'vitest'

import { generateTextWithModelId } from '../../src/llm/generate-text.js'
import { buildDocumentPrompt } from '../../src/llm/prompt.js'

const LIVE = process.env.SUMMARIZE_LIVE_TEST === '1'

function shouldSoftSkipLiveError(message: string): boolean {
  return /(model.*not found|does not exist|permission|access|unauthorized|forbidden|404|not_found|model_not_found|unsupported|invalid_request)/i.test(
    message
  )
}

function escapePdfText(text: string): string {
  return text.replace(/[()\\]/g, (match) => `\\${match}`)
}

function buildMinimalPdf(text: string): Uint8Array {
  const header = '%PDF-1.4\n'
  const escaped = escapePdfText(text)
  const content = `BT /F1 18 Tf 72 120 Td (${escaped}) Tj ET`

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]

  const offsets: number[] = [0]
  let offset = header.length
  for (const obj of objects) {
    offsets.push(offset)
    offset += obj.length
  }

  const xrefOffset = offset
  const xrefEntries = offsets
    .map((entryOffset, index) =>
      index === 0
        ? '0000000000 65535 f \n'
        : `${String(entryOffset).padStart(10, '0')} 00000 n \n`
    )
    .join('')
  const xref = `xref\n0 ${objects.length + 1}\n${xrefEntries}`
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  const pdf = `${header}${objects.join('')}${xref}${trailer}`
  return new TextEncoder().encode(pdf)
}

;(LIVE ? describe : describe.skip)('live openai PDF', () => {
  const timeoutMs = 120_000
  const openaiApiKey = process.env.OPENAI_API_KEY ?? null

  it(
    'summarizes PDF attachments',
    async () => {
      if (!openaiApiKey) {
        it.skip('requires OPENAI_API_KEY', () => {})
        return
      }

      try {
        const pdfBytes = buildMinimalPdf('Hello PDF')
        const result = await generateTextWithModelId({
          modelId: 'openai/gpt-5.2',
          apiKeys: {
            xaiApiKey: null,
            openaiApiKey,
            googleApiKey: null,
            anthropicApiKey: null,
            openrouterApiKey: null,
          },
          prompt: buildDocumentPrompt({
            text: 'Summarize the attached PDF in one sentence.',
            document: {
              bytes: pdfBytes,
              mediaType: 'application/pdf',
              filename: 'hello.pdf',
            },
          }),
          maxOutputTokens: 256,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
        expect(result.text.trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )
})
