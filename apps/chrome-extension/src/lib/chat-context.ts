export type ChatContextMetadata = {
  url?: string | null
  title?: string | null
  source?: 'page' | 'url' | string | null
  extractionStrategy?: string | null
  markdownProvider?: string | null
  firecrawlUsed?: boolean | null
  transcriptSource?: string | null
  transcriptionProvider?: string | null
  transcriptCache?: string | null
  attemptedTranscriptProviders?: string[] | null
  mediaDurationSeconds?: number | null
  totalCharacters?: number | null
  wordCount?: number | null
  transcriptCharacters?: number | null
  transcriptWordCount?: number | null
  transcriptLines?: number | null
  truncated?: boolean | null
}

export type ChatContextInput = {
  transcript: string
  summary?: string | null
  summaryCap: number
  metadata?: ChatContextMetadata
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

function buildMetadataBlock(metadata?: ChatContextMetadata): string {
  if (!metadata) return ''
  const lines: string[] = []

  if (metadata.url) lines.push(`URL: ${metadata.url}`)
  if (metadata.title) lines.push(`Title: ${metadata.title}`)

  if (metadata.source) {
    const sourceLabel =
      metadata.source === 'page'
        ? 'Visible page (Readability)'
        : metadata.source === 'url'
          ? 'URL extraction (daemon)'
          : metadata.source
    lines.push(`Source: ${sourceLabel}`)
  }

  if (metadata.extractionStrategy) {
    lines.push(`Extraction strategy: ${metadata.extractionStrategy}`)
  }

  if (metadata.markdownProvider) {
    lines.push(`Markdown: ${metadata.markdownProvider}`)
  }

  if (metadata.firecrawlUsed === true) {
    lines.push('Firecrawl: used')
  }

  if (metadata.transcriptSource || metadata.transcriptionProvider) {
    const parts = [metadata.transcriptSource ?? 'unknown']
    if (metadata.transcriptionProvider) parts.push(metadata.transcriptionProvider)
    lines.push(`Transcript source: ${parts.join(' · ')}`)
  }

  if (metadata.transcriptCache) {
    lines.push(`Transcript cache: ${metadata.transcriptCache}`)
  }

  if (metadata.attemptedTranscriptProviders?.length) {
    lines.push(`Transcript attempts: ${metadata.attemptedTranscriptProviders.join(', ')}`)
  }

  if (metadata.mediaDurationSeconds && metadata.mediaDurationSeconds > 0) {
    lines.push(`Media duration: ${formatDuration(metadata.mediaDurationSeconds)}`)
  }

  const contentParts: string[] = []
  if (typeof metadata.wordCount === 'number' && Number.isFinite(metadata.wordCount)) {
    contentParts.push(`${metadata.wordCount.toLocaleString()} words`)
  }
  if (
    typeof metadata.totalCharacters === 'number' &&
    Number.isFinite(metadata.totalCharacters)
  ) {
    contentParts.push(`${metadata.totalCharacters.toLocaleString()} chars`)
  }
  if (contentParts.length) lines.push(`Content size: ${contentParts.join(' · ')}`)

  const transcriptParts: string[] = []
  if (
    typeof metadata.transcriptWordCount === 'number' &&
    Number.isFinite(metadata.transcriptWordCount)
  ) {
    transcriptParts.push(`${metadata.transcriptWordCount.toLocaleString()} words`)
  }
  if (
    typeof metadata.transcriptCharacters === 'number' &&
    Number.isFinite(metadata.transcriptCharacters)
  ) {
    transcriptParts.push(`${metadata.transcriptCharacters.toLocaleString()} chars`)
  }
  if (
    typeof metadata.transcriptLines === 'number' &&
    Number.isFinite(metadata.transcriptLines)
  ) {
    transcriptParts.push(`${metadata.transcriptLines.toLocaleString()} lines`)
  }
  if (transcriptParts.length) lines.push(`Transcript size: ${transcriptParts.join(' · ')}`)

  if (typeof metadata.truncated === 'boolean') {
    lines.push(`Truncated: ${metadata.truncated ? 'yes' : 'no'}`)
  }

  if (!lines.length) return ''
  return `Metadata:\n- ${lines.join('\n- ')}\n\n`
}

export function buildChatPageContent({
  transcript,
  summary,
  summaryCap,
  metadata,
}: ChatContextInput): string {
  const cleanSummary = typeof summary === 'string' ? summary.trim() : ''
  const cleanTranscript = transcript.trim()
  const metadataBlock = buildMetadataBlock(metadata)

  if (!cleanSummary) {
    return `${metadataBlock}Full transcript:\n${cleanTranscript}`.trim()
  }

  if (summaryCap > 0 && cleanTranscript.length > summaryCap) {
    return `${metadataBlock}Full transcript:\n${cleanTranscript}`.trim()
  }

  return `${metadataBlock}Summary (auto-generated):\n${cleanSummary}\n\nFull transcript:\n${cleanTranscript}`.trim()
}
