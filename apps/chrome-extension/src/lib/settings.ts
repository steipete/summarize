import {
  type ColorMode,
  type ColorScheme,
  defaultColorMode,
  defaultColorScheme,
  normalizeColorMode,
  normalizeColorScheme,
} from './theme'

export type Settings = {
  token: string
  autoSummarize: boolean
  hoverSummaries: boolean
  chatEnabled: boolean
  automationEnabled: boolean
  summaryTimestamps: boolean
  extendedLogging: boolean
  hoverPrompt: string
  transcriber: string
  model: string
  length: string
  language: string
  promptOverride: string
  maxChars: number
  requestMode: string
  firecrawlMode: string
  markdownMode: string
  preprocessMode: string
  youtubeMode: string
  timeout: string
  retries: number | null
  maxOutputTokens: string
  fontFamily: string
  fontSize: number
  lineHeight: number
  colorScheme: ColorScheme
  colorMode: ColorMode
}

const storageKey = 'settings'

const legacyFontFamilyMap = new Map<string, string>([
  [
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  ],
])

function normalizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.fontFamily
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.fontFamily
  return legacyFontFamilyMap.get(trimmed) ?? trimmed
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.model
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.model
  const lowered = trimmed.toLowerCase()
  if (lowered === 'auto' || lowered === 'free') return lowered
  return trimmed
}

function normalizeLength(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.length
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.length
  const lowered = trimmed.toLowerCase()
  if (lowered === 's') return 'short'
  if (lowered === 'm') return 'medium'
  if (lowered === 'l') return 'long'
  return lowered
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.language
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.language
  return trimmed
}

function normalizePromptOverride(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.promptOverride
  return value
}

function normalizeHoverPrompt(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.hoverPrompt
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.hoverPrompt
  return value
}

function normalizeTranscriber(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.transcriber
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.transcriber
  if (trimmed === 'whisper' || trimmed === 'parakeet' || trimmed === 'canary') return trimmed
  return defaultSettings.transcriber
}

function normalizeRequestMode(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.requestMode
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.requestMode
  if (trimmed === 'page' || trimmed === 'url') return trimmed
  return defaultSettings.requestMode
}

function normalizeFirecrawlMode(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.firecrawlMode
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.firecrawlMode
  if (trimmed === 'off' || trimmed === 'auto' || trimmed === 'always') return trimmed
  return defaultSettings.firecrawlMode
}

function normalizeMarkdownMode(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.markdownMode
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.markdownMode
  if (trimmed === 'off' || trimmed === 'auto' || trimmed === 'llm' || trimmed === 'readability') {
    return trimmed
  }
  return defaultSettings.markdownMode
}

function normalizePreprocessMode(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.preprocessMode
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.preprocessMode
  if (trimmed === 'off' || trimmed === 'auto' || trimmed === 'always') return trimmed
  return defaultSettings.preprocessMode
}

function normalizeYoutubeMode(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.youtubeMode
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return defaultSettings.youtubeMode
  if (
    trimmed === 'auto' ||
    trimmed === 'web' ||
    trimmed === 'apify' ||
    trimmed === 'yt-dlp' ||
    trimmed === 'no-auto'
  ) {
    return trimmed
  }
  return defaultSettings.youtubeMode
}

function normalizeTimeout(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.timeout
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.timeout
  return trimmed
}

function normalizeRetries(value: unknown): number | null {
  if (value == null || value === '') return defaultSettings.retries
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN
  if (!Number.isFinite(numeric)) return defaultSettings.retries
  const intValue = Math.trunc(numeric)
  if (intValue < 0 || intValue > 5) return defaultSettings.retries
  return intValue
}

function normalizeMaxOutputTokens(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.maxOutputTokens
  return value.trim()
}

function normalizeLineHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultSettings.lineHeight
  if (value < 1.1 || value > 2.2) return defaultSettings.lineHeight
  return Math.round(value * 100) / 100
}

export const defaultSettings: Settings = {
  token: '',
  autoSummarize: true,
  hoverSummaries: false,
  chatEnabled: true,
  automationEnabled: false,
  summaryTimestamps: true,
  extendedLogging: false,
  hoverPrompt:
    'Plain text only (no Markdown). Summarize the linked page concisely in 1-2 sentences; aim for 100-200 characters.',
  transcriber: '',
  model: 'auto',
  length: 'xl',
  language: 'auto',
  promptOverride: '',
  maxChars: 120_000,
  requestMode: '',
  firecrawlMode: '',
  markdownMode: '',
  preprocessMode: '',
  youtubeMode: '',
  timeout: '',
  retries: null,
  maxOutputTokens: '',
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  fontSize: 14,
  lineHeight: 1.45,
  colorScheme: defaultColorScheme,
  colorMode: defaultColorMode,
}

export async function loadSettings(): Promise<Settings> {
  const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false
    const maybePromise = chrome.storage.local.get(storageKey, (result) => {
      settled = true
      resolve(result as Record<string, unknown>)
    })
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      ;(maybePromise as Promise<Record<string, unknown>>)
        .then((result) => {
          if (settled) return
          resolve(result as Record<string, unknown>)
        })
        .catch(reject)
    }
  })
  const raw = (res[storageKey] ?? {}) as Partial<Settings>
  return {
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === 'string' ? raw.token : defaultSettings.token,
    model: normalizeModel(raw.model),
    length: normalizeLength(raw.length),
    language: normalizeLanguage(raw.language),
    promptOverride: normalizePromptOverride(raw.promptOverride),
    autoSummarize:
      typeof raw.autoSummarize === 'boolean' ? raw.autoSummarize : defaultSettings.autoSummarize,
    hoverSummaries:
      typeof raw.hoverSummaries === 'boolean' ? raw.hoverSummaries : defaultSettings.hoverSummaries,
    chatEnabled:
      typeof raw.chatEnabled === 'boolean' ? raw.chatEnabled : defaultSettings.chatEnabled,
    automationEnabled:
      typeof raw.automationEnabled === 'boolean'
        ? raw.automationEnabled
        : defaultSettings.automationEnabled,
    summaryTimestamps:
      typeof raw.summaryTimestamps === 'boolean'
        ? raw.summaryTimestamps
        : defaultSettings.summaryTimestamps,
    extendedLogging:
      typeof raw.extendedLogging === 'boolean'
        ? raw.extendedLogging
        : defaultSettings.extendedLogging,
    hoverPrompt: normalizeHoverPrompt(raw.hoverPrompt),
    transcriber: normalizeTranscriber(raw.transcriber),
    maxChars: typeof raw.maxChars === 'number' ? raw.maxChars : defaultSettings.maxChars,
    requestMode: normalizeRequestMode(raw.requestMode),
    firecrawlMode: normalizeFirecrawlMode(raw.firecrawlMode),
    markdownMode: normalizeMarkdownMode(raw.markdownMode),
    preprocessMode: normalizePreprocessMode(raw.preprocessMode),
    youtubeMode: normalizeYoutubeMode(raw.youtubeMode),
    timeout: normalizeTimeout(raw.timeout),
    retries: normalizeRetries(raw.retries),
    maxOutputTokens: normalizeMaxOutputTokens(raw.maxOutputTokens),
    fontFamily: normalizeFontFamily(raw.fontFamily),
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : defaultSettings.fontSize,
    lineHeight: normalizeLineHeight(raw.lineHeight),
    colorScheme: normalizeColorScheme(raw.colorScheme),
    colorMode: normalizeColorMode(raw.colorMode),
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({
    [storageKey]: {
      ...settings,
      model: normalizeModel(settings.model),
      length: normalizeLength(settings.length),
      language: normalizeLanguage(settings.language),
      promptOverride: normalizePromptOverride(settings.promptOverride),
      hoverPrompt: normalizeHoverPrompt(settings.hoverPrompt),
      requestMode: normalizeRequestMode(settings.requestMode),
      firecrawlMode: normalizeFirecrawlMode(settings.firecrawlMode),
      markdownMode: normalizeMarkdownMode(settings.markdownMode),
      preprocessMode: normalizePreprocessMode(settings.preprocessMode),
      youtubeMode: normalizeYoutubeMode(settings.youtubeMode),
      timeout: normalizeTimeout(settings.timeout),
      retries: normalizeRetries(settings.retries),
      maxOutputTokens: normalizeMaxOutputTokens(settings.maxOutputTokens),
      transcriber: normalizeTranscriber(settings.transcriber),
      fontFamily: normalizeFontFamily(settings.fontFamily),
      lineHeight: normalizeLineHeight(settings.lineHeight),
      colorScheme: normalizeColorScheme(settings.colorScheme),
      colorMode: normalizeColorMode(settings.colorMode),
    },
  })
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  await saveSettings(next)
  return next
}
