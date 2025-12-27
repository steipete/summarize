import { formatCompactCount, formatDurationSecondsSmart, formatElapsedMs } from '../tty/format.js'
import { formatUSD, sumNumbersOrNull } from './format.js'
import { ansi } from './terminal.js'

export type ExtractDiagnosticsForFinishLine = {
  strategy: 'bird' | 'firecrawl' | 'html' | 'nitter'
  firecrawl: { used: boolean }
  markdown: { used: boolean; provider: 'firecrawl' | 'llm' | null; notes?: string | null }
  transcript: { textProvided: boolean; provider: string | null }
}

export type ExtractedForLengths = {
  url: string
  siteName: string | null
  totalCharacters: number
  wordCount: number
  transcriptCharacters: number | null
  transcriptLines: number | null
  transcriptWordCount: number | null
  transcriptSource: string | null
  transcriptionProvider: string | null
  mediaDurationSeconds: number | null
  video: { kind: 'youtube' | 'direct'; url: string } | null
  isVideoOnly: boolean
  diagnostics: { transcript: { cacheStatus: string } }
}

export function formatModelLabelForDisplay(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return trimmed

  // Tricky UX: OpenRouter models routed via the OpenAI-compatible API often appear as
  // `openai/<publisher>/<model>` in the "model" field, which reads like we're using OpenAI.
  // Collapse that to `<publisher>/<model>` for display.
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length >= 3 && parts[0] === 'openai') {
    return `${parts[1]}/${parts.slice(2).join('/')}`
  }

  return trimmed
}

function inferMediaKindLabelForFinishLine(
  extracted: ExtractedForLengths
): 'audio' | 'video' | null {
  if (extracted.siteName === 'YouTube' || /youtube\.com|youtu\.be/i.test(extracted.url)) {
    return 'video'
  }
  if (extracted.isVideoOnly || extracted.video) {
    return 'video'
  }

  // For everything else with a transcript, default to audio. This covers podcasts and direct audio files.
  const hasTranscript =
    typeof extracted.transcriptCharacters === 'number' && extracted.transcriptCharacters > 0
  if (!hasTranscript) return null
  return 'audio'
}

function buildCompactTranscriptPart(extracted: ExtractedForLengths): string | null {
  const isYouTube =
    extracted.siteName === 'YouTube' || /youtube\.com|youtu\.be/i.test(extracted.url)
  if (!isYouTube && !extracted.transcriptCharacters) return null

  const transcriptChars = extracted.transcriptCharacters
  if (typeof transcriptChars !== 'number' || transcriptChars <= 0) return null

  const wordEstimate = Math.max(0, Math.round(transcriptChars / 6))
  const transcriptWords = extracted.transcriptWordCount ?? wordEstimate
  const minutesEstimate = Math.max(1, Math.round(transcriptWords / 160))

  const exactDurationSeconds =
    typeof extracted.mediaDurationSeconds === 'number' && extracted.mediaDurationSeconds > 0
      ? extracted.mediaDurationSeconds
      : null
  const duration =
    exactDurationSeconds != null
      ? formatDurationSecondsSmart(exactDurationSeconds)
      : `~${formatDurationSecondsSmart(minutesEstimate * 60)}`

  const wordLabel = `${formatCompactCount(transcriptWords)} words`

  const mediaKind = inferMediaKindLabelForFinishLine(extracted)

  return mediaKind ? `${duration} ${mediaKind} · ${wordLabel}` : `${duration} · ${wordLabel}`
}

function buildDetailedLengthPartsForExtracted(extracted: ExtractedForLengths): string[] {
  const parts: string[] = []

  const isYouTube =
    extracted.siteName === 'YouTube' || /youtube\.com|youtu\.be/i.test(extracted.url)
  if (!isYouTube && !extracted.transcriptCharacters) return parts

  const transcriptChars = extracted.transcriptCharacters
  const shouldOmitInput =
    typeof transcriptChars === 'number' &&
    transcriptChars > 0 &&
    extracted.totalCharacters > 0 &&
    transcriptChars / extracted.totalCharacters >= 0.95
  if (!shouldOmitInput) {
    parts.push(
      `input=${formatCompactCount(extracted.totalCharacters)} chars (~${formatCompactCount(extracted.wordCount)} words)`
    )
  }

  if (typeof extracted.transcriptCharacters === 'number' && extracted.transcriptCharacters > 0) {
    // Transcript stats:
    // - `transcriptWordCount`: exact-ish (derived from transcript text after truncation budgeting)
    // - `mediaDurationSeconds`: best-effort, sourced from provider metadata (e.g. RSS itunes:duration)
    const wordEstimate = Math.max(0, Math.round(extracted.transcriptCharacters / 6))
    const transcriptWords = extracted.transcriptWordCount ?? wordEstimate
    const minutesEstimate = Math.max(1, Math.round(transcriptWords / 160))

    const details: string[] = [
      `~${formatCompactCount(transcriptWords)} words`,
      `${formatCompactCount(extracted.transcriptCharacters)} chars`,
    ]

    const durationPart =
      typeof extracted.mediaDurationSeconds === 'number' && extracted.mediaDurationSeconds > 0
        ? formatDurationSecondsSmart(extracted.mediaDurationSeconds)
        : `~${formatDurationSecondsSmart(minutesEstimate * 60)}`

    parts.push(`transcript=${durationPart} (${details.join(' · ')})`)
  }

  const hasTranscript =
    typeof extracted.transcriptCharacters === 'number' && extracted.transcriptCharacters > 0
  if (hasTranscript && extracted.transcriptSource) {
    const providerSuffix =
      extracted.transcriptSource === 'whisper' &&
      extracted.transcriptionProvider &&
      extracted.transcriptionProvider.trim().length > 0
        ? `/${extracted.transcriptionProvider.trim()}`
        : ''
    const cacheStatus = extracted.diagnostics?.transcript?.cacheStatus
    const cachePart =
      typeof cacheStatus === 'string' && cacheStatus !== 'unknown' ? cacheStatus : null
    const txParts: string[] = [`tx=${extracted.transcriptSource}${providerSuffix}`]
    if (cachePart) txParts.push(`cache=${cachePart}`)
    parts.push(txParts.join(' '))
  }
  return parts
}

export function buildLengthPartsForFinishLine(
  extracted: ExtractedForLengths,
  detailed: boolean
): string[] | null {
  const compactTranscript = buildCompactTranscriptPart(extracted)
  if (!detailed) return compactTranscript ? [`txc=${compactTranscript}`] : null

  const parts = buildDetailedLengthPartsForExtracted(extracted)
  if (parts.length === 0 && !compactTranscript) return null
  if (compactTranscript) parts.unshift(`txc=${compactTranscript}`)
  return parts
}

export function writeFinishLine({
  stderr,
  elapsedMs,
  label,
  model,
  report,
  costUsd,
  detailed,
  extraParts,
  color,
}: {
  stderr: NodeJS.WritableStream
  elapsedMs: number
  label?: string | null
  model: string | null
  report: {
    llm: Array<{
      promptTokens: number | null
      completionTokens: number | null
      totalTokens: number | null
      calls: number
    }>
    services: { firecrawl: { requests: number }; apify: { requests: number } }
  }
  costUsd: number | null
  detailed: boolean
  extraParts?: string[] | null
  color: boolean
}): void {
  const promptTokens = sumNumbersOrNull(report.llm.map((row) => row.promptTokens))
  const completionTokens = sumNumbersOrNull(report.llm.map((row) => row.completionTokens))
  const totalTokens = sumNumbersOrNull(report.llm.map((row) => row.totalTokens))

  const hasAnyTokens = promptTokens !== null || completionTokens !== null || totalTokens !== null
  const tokensPart = hasAnyTokens
    ? `↑${promptTokens != null ? formatCompactCount(promptTokens) : 'unknown'} ↓${
        completionTokens != null ? formatCompactCount(completionTokens) : 'unknown'
      } Δ${totalTokens != null ? formatCompactCount(totalTokens) : 'unknown'}`
    : null

  const compactTranscript = extraParts
    ? (extraParts.find((part) => part.startsWith('txc=')) ?? null)
    : null
  const compactTranscriptLabel = compactTranscript?.startsWith('txc=')
    ? compactTranscript.slice('txc='.length)
    : null

  const stripWordPrefix = (input: string): string | null => {
    // Examples:
    // - "2.9k words" => null
    // - "2.9k words via firecrawl" => "via firecrawl"
    const match = input.trim().match(/^~?\d[\d.]*[kmb]?\s+words(?:\s+via\s+(.+))?$/i)
    if (!match) return input
    const via = match[1]?.trim()
    return via ? `via ${via}` : null
  }

  const effectiveLabel = (() => {
    if (!label) return null
    if (!compactTranscriptLabel?.toLowerCase().includes('words')) return label
    const stripped = stripWordPrefix(label)
    if (stripped === null) return null
    if (stripped !== label) return stripped
    // If we still have a "… words" label here, drop it to avoid duplicated word counts.
    if (/\bwords\b/i.test(label)) return null
    return label
  })()
  const filteredExtraParts =
    compactTranscriptLabel && extraParts
      ? extraParts.filter((part) => part !== compactTranscript)
      : extraParts
  const summaryParts: Array<string | null> = [
    formatElapsedMs(elapsedMs),
    compactTranscriptLabel,
    costUsd != null ? formatUSD(costUsd) : null,
    effectiveLabel,
    model ? formatModelLabelForDisplay(model) : null,
    tokensPart,
  ]
  const line1 = summaryParts.filter((part): part is string => typeof part === 'string').join(' · ')

  const totalCalls = report.llm.reduce((sum, row) => sum + row.calls, 0)

  stderr.write('\n')
  stderr.write(`${ansi('1;32', line1, color)}\n`)
  const lenParts =
    filteredExtraParts?.filter(
      (part) => part.startsWith('input=') || part.startsWith('transcript=')
    ) ?? []
  const miscParts =
    filteredExtraParts?.filter(
      (part) => !part.startsWith('input=') && !part.startsWith('transcript=')
    ) ?? []

  if (!detailed) {
    return
  }

  const line2Segments: string[] = []
  if (lenParts.length > 0) {
    line2Segments.push(`len ${lenParts.join(' ')}`)
  }
  if (totalCalls > 1) line2Segments.push(`calls=${formatCompactCount(totalCalls)}`)
  if (report.services.firecrawl.requests > 0 || report.services.apify.requests > 0) {
    const svcParts: string[] = []
    if (report.services.firecrawl.requests > 0) {
      svcParts.push(`firecrawl=${formatCompactCount(report.services.firecrawl.requests)}`)
    }
    if (report.services.apify.requests > 0) {
      svcParts.push(`apify=${formatCompactCount(report.services.apify.requests)}`)
    }
    line2Segments.push(`svc ${svcParts.join(' ')}`)
  }
  if (miscParts.length > 0) {
    line2Segments.push(...miscParts)
  }

  if (line2Segments.length > 0) {
    stderr.write(`${ansi('0;90', line2Segments.join(' | '), color)}\n`)
  }
}

export function buildExtractFinishLabel(args: {
  extracted: { diagnostics: ExtractDiagnosticsForFinishLine }
  format: 'text' | 'markdown'
  markdownMode: 'off' | 'auto' | 'llm' | 'readability'
  hasMarkdownLlmCall: boolean
}): string {
  const base = args.format === 'markdown' ? 'markdown' : 'text'

  const transcriptProvided = Boolean(args.extracted.diagnostics.transcript?.textProvided)
  if (transcriptProvided) {
    const provider = args.extracted.diagnostics.transcript?.provider
    return provider ? `${base} via transcript/${provider}` : `${base} via transcript`
  }

  if (args.format === 'markdown') {
    const strategy = String(args.extracted.diagnostics.strategy ?? '')
    const firecrawlUsed =
      strategy === 'firecrawl' || Boolean(args.extracted.diagnostics.firecrawl?.used)
    if (firecrawlUsed) return `${base} via firecrawl`
    if (strategy === 'html' && args.markdownMode === 'readability') return `${base} via readability`

    const mdUsed = Boolean(args.extracted.diagnostics.markdown?.used)
    const mdProvider = args.extracted.diagnostics.markdown.provider
    const mdNotes = args.extracted.diagnostics.markdown.notes ?? null

    if (mdUsed && mdProvider === 'firecrawl') {
      return `${base} via firecrawl`
    }

    if (mdUsed && mdNotes && mdNotes.toLowerCase().includes('readability html used')) {
      return `${base} via readability`
    }

    if (mdUsed) {
      if (args.markdownMode === 'readability') return `${base} via readability`
      if (args.hasMarkdownLlmCall) return `${base} via llm`
      return `${base} via markitdown`
    }
  }

  const strategy = String(args.extracted.diagnostics.strategy ?? '')
  if (strategy === 'firecrawl' || args.extracted.diagnostics.firecrawl?.used) {
    return `${base} via firecrawl`
  }
  if (strategy === 'bird') return `${base} via bird`
  if (strategy === 'nitter') return `${base} via nitter`

  // Default: avoid noisy "via html"
  return base
}

export function buildSummaryFinishLabel(args: {
  extracted: { diagnostics: ExtractDiagnosticsForFinishLine; wordCount: number }
}): string | null {
  const strategy = String(args.extracted.diagnostics.strategy ?? '')
  const sources: string[] = []
  if (strategy === 'bird') sources.push('bird')
  if (strategy === 'nitter') sources.push('nitter')
  if (strategy === 'firecrawl' || args.extracted.diagnostics.firecrawl?.used) {
    sources.push('firecrawl')
  }
  const transcriptProvided = Boolean(args.extracted.diagnostics.transcript?.textProvided)
  const words =
    typeof args.extracted.wordCount === 'number' && Number.isFinite(args.extracted.wordCount)
      ? args.extracted.wordCount
      : 0
  const wordLabel = words > 0 ? `${formatCompactCount(words)} words` : null
  if (transcriptProvided) {
    if (sources.length === 0) return null
    return `via ${sources.join('+')}`
  }
  if (sources.length === 0 && !wordLabel) return null
  if (wordLabel && sources.length > 0) return `${wordLabel} via ${sources.join('+')}`
  if (wordLabel) return wordLabel
  return `via ${sources.join('+')}`
}
