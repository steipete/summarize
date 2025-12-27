import { load } from 'cheerio'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isYouTubeUrl = (rawUrl: string): boolean => {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname.includes('youtube.com') || hostname.includes('youtu.be')
  } catch {
    const lower = rawUrl.toLowerCase()
    return lower.includes('youtube.com') || lower.includes('youtu.be')
  }
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/
const MAX_EMBED_YOUTUBE_TEXT_CHARS = 2000
const MAX_EMBED_YOUTUBE_READABILITY_CHARS = 2000

export function isYouTubeVideoUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'youtu.be') {
      return true
    }
    if (hostname.includes('youtube.com')) {
      return (
        url.pathname.startsWith('/watch') ||
        url.pathname.startsWith('/shorts/') ||
        url.pathname.startsWith('/embed/') ||
        url.pathname.startsWith('/v/')
      )
    }
  } catch {
    return false
  }
  return false
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()
    let candidate: string | null = null
    if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/')[1] ?? null
    }
    if (hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/watch')) {
        candidate = url.searchParams.get('v')
      } else if (url.pathname.startsWith('/shorts/')) {
        candidate = url.pathname.split('/')[2] ?? null
      } else if (url.pathname.startsWith('/embed/')) {
        candidate = url.pathname.split('/')[2] ?? null
      } else if (url.pathname.startsWith('/v/')) {
        candidate = url.pathname.split('/')[2] ?? null
      }
    }

    const trimmed = candidate?.trim() ?? ''
    if (!trimmed) {
      return null
    }
    return YOUTUBE_VIDEO_ID_PATTERN.test(trimmed) ? trimmed : null
  } catch {
    // Ignore parsing errors for malformed URLs
  }
  return null
}

async function extractReadabilityText(html: string): Promise<string> {
  try {
    const cleanedHtml = stripCssFromHtml(html)
    const { Readability } = await import('@mozilla/readability')
    const { JSDOM, VirtualConsole } = await import('jsdom')
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', (err) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message ?? '')
          : ''
      if (message.includes('Could not parse CSS stylesheet')) return
      console.error(err)
    })

    const dom = new JSDOM(cleanedHtml, { virtualConsole })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()
    const text = (article?.textContent ?? '').replace(/\s+/g, ' ').trim()
    return text
  } catch {
    return ''
  }
}

function stripCssFromHtml(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

export async function extractEmbeddedYouTubeUrlFromHtml(
  html: string,
  maxTextChars = MAX_EMBED_YOUTUBE_TEXT_CHARS,
  maxReadabilityChars = MAX_EMBED_YOUTUBE_READABILITY_CHARS
): Promise<string | null> {
  try {
    const $ = load(html)
    const rawText = $('body').text() || $.text()
    const normalizedText = rawText.replace(/\s+/g, ' ').trim()

    const readabilityText = await extractReadabilityText(html)
    const effectiveLength =
      readabilityText.length > 0 ? readabilityText.length : normalizedText.length
    const threshold = readabilityText.length > 0 ? maxReadabilityChars : maxTextChars
    if (effectiveLength > threshold) return null

    const candidates: string[] = []

    const iframeSrc =
      $('iframe[src*="youtube.com/embed/"], iframe[src*="youtu.be/"]').first().attr('src') ?? null
    if (iframeSrc) candidates.push(iframeSrc)

    const ogVideo =
      $(
        'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="og:video"], meta[name="og:video:url"], meta[name="og:video:secure_url"]'
      )
        .first()
        .attr('content') ?? null
    if (ogVideo) candidates.push(ogVideo)

    for (const candidate of candidates) {
      let url = candidate.trim()
      if (!url) continue
      if (url.startsWith('//')) url = `https:${url}`
      if (url.startsWith('/')) url = `https://www.youtube.com${url}`
      const id = extractYouTubeVideoId(url)
      if (id) return `https://www.youtube.com/watch?v=${id}`
    }
  } catch {
    return null
  }
  return null
}

export function sanitizeYoutubeJsonResponse(input: string): string {
  const trimmed = input.trimStart()
  if (trimmed.startsWith(")]}'")) {
    return trimmed.slice(4)
  }
  return trimmed
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&#x2F;', '/')
    .replaceAll('&nbsp;', ' ')
}

export function extractYoutubeBootstrapConfig(html: string): Record<string, unknown> | null {
  try {
    const $ = load(html)
    const scripts = $('script').toArray()

    for (const script of scripts) {
      const source = $(script).html()
      if (!source) {
        continue
      }

      const config = parseBootstrapFromScript(source)
      if (config) {
        return config
      }
    }
  } catch {
    // fall through to legacy regex
  }

  return parseBootstrapFromScript(html)
}

const YTCFG_SET_TOKEN = 'ytcfg.set'
const YTCFG_VAR_TOKEN = 'var ytcfg'

function extractBalancedJsonObject(source: string, startAt: number): string | null {
  const start = source.indexOf('{', startAt)
  if (start < 0) {
    return null
  }

  let depth = 0
  let inString = false
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (!ch) {
      continue
    }

    if (inString) {
      if (escaping) {
        escaping = false
        continue
      }
      if (ch === '\\') {
        escaping = true
        continue
      }
      if (quote && ch === quote) {
        inString = false
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      continue
    }

    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }

  return null
}

function parseBootstrapFromScript(source: string): Record<string, unknown> | null {
  const sanitizedSource = sanitizeYoutubeJsonResponse(source.trimStart())

  for (let index = 0; index >= 0; ) {
    index = sanitizedSource.indexOf(YTCFG_SET_TOKEN, index)
    if (index < 0) {
      break
    }
    const object = extractBalancedJsonObject(sanitizedSource, index)
    if (object) {
      try {
        const parsed: unknown = JSON.parse(object)
        if (isRecord(parsed)) {
          return parsed
        }
      } catch {
        // keep searching
      }
    }
    index += YTCFG_SET_TOKEN.length
  }

  const varIndex = sanitizedSource.indexOf(YTCFG_VAR_TOKEN)
  if (varIndex >= 0) {
    const object = extractBalancedJsonObject(sanitizedSource, varIndex)
    if (object) {
      try {
        const parsed: unknown = JSON.parse(object)
        if (isRecord(parsed)) {
          return parsed
        }
      } catch {
        return null
      }
    }
  }

  return null
}
