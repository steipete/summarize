import { isRecord } from './utils.js'

export const normalizeTranscriptText = (input: string): string =>
  input
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[\t ]+/g, ' ')
    .replaceAll(/\s*\n\s*/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()

export const normalizeTranscriptLines = (lines: readonly string[]): string | null => {
  if (lines.length === 0) {
    return null
  }
  const normalized = normalizeTranscriptText(lines.join('\n'))
  return normalized.length > 0 ? normalized : null
}

export const normalizeApifyTranscript = (raw: unknown): string | null => {
  if (typeof raw === 'string') {
    const trimmed = normalizeTranscriptText(raw)
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(raw)) {
    type TextCandidate = { text?: unknown }
    const lines = raw
      .map((entry) => {
        if (!isRecord(entry)) {
          return ''
        }
        const textValue = (entry as TextCandidate).text
        return typeof textValue === 'string' ? textValue.trim() : ''
      })
      .filter((line) => line.length > 0)
    if (lines.length > 0) {
      return normalizeTranscriptLines(lines) ?? null
    }
  }

  if (isRecord(raw)) {
    const singleText = (raw as { text?: unknown }).text
    if (typeof singleText === 'string') {
      const trimmed = normalizeTranscriptText(singleText)
      return trimmed.length > 0 ? trimmed : null
    }
  }

  return null
}
