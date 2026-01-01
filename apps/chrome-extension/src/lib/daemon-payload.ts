import type { Settings } from './settings'

export type ExtractedPage = {
  url: string
  title: string | null
  text: string
  truncated: boolean
  mediaDurationSeconds?: number | null
  media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null
}

export function buildDaemonRequestBody({
  extracted,
  settings,
  noCache,
}: {
  extracted: ExtractedPage
  settings: Settings
  noCache?: boolean
}): Record<string, unknown> {
  const promptOverride = settings.promptOverride?.trim()
  const maxOutputTokens = settings.maxOutputTokens?.trim()
  const timeout = settings.timeout?.trim()
  const overrides: Record<string, unknown> = {}
  if (settings.requestMode) overrides.mode = settings.requestMode
  if (settings.firecrawlMode) overrides.firecrawl = settings.firecrawlMode
  if (settings.markdownMode) overrides.markdownMode = settings.markdownMode
  if (settings.preprocessMode) overrides.preprocess = settings.preprocessMode
  if (settings.youtubeMode) overrides.youtube = settings.youtubeMode
  if (settings.transcriber) overrides.transcriber = settings.transcriber
  if (timeout) overrides.timeout = timeout
  if (typeof settings.retries === 'number' && Number.isFinite(settings.retries)) {
    overrides.retries = settings.retries
  }
  if (maxOutputTokens) overrides.maxOutputTokens = maxOutputTokens
  const diagnostics = settings.extendedLogging ? { includeContent: true } : null
  return {
    url: extracted.url,
    title: extracted.title,
    text: extracted.text,
    truncated: extracted.truncated,
    model: settings.model,
    length: settings.length,
    language: settings.language,
    ...(promptOverride ? { prompt: promptOverride } : {}),
    ...(noCache ? { noCache: true } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...overrides,
    maxCharacters: settings.maxChars,
  }
}

export function buildSummarizeRequestBody({
  extracted,
  settings,
  noCache,
  inputMode,
  timestamps,
}: {
  extracted: ExtractedPage
  settings: Settings
  noCache?: boolean
  inputMode?: 'page' | 'video'
  timestamps?: boolean
}): Record<string, unknown> {
  const baseBody = buildDaemonRequestBody({ extracted, settings, noCache })
  const withTimestamps = timestamps ? { ...baseBody, timestamps: true } : baseBody
  if (inputMode === 'video') {
    return { ...withTimestamps, mode: 'url', videoMode: 'transcript' }
  }
  if (inputMode === 'page') {
    return { ...withTimestamps, mode: 'page' }
  }
  return withTimestamps
}
