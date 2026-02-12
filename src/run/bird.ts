import { execFileTracked } from '../processes.js'
import { BIRD_TIP, TWITTER_HOSTS } from './constants.js'
import { hasBirdCli } from './env.js'

type BirdTweetPayload = {
  id?: string
  text: string
  author?: { username?: string; name?: string }
  createdAt?: string
  media?: BirdTweetMedia | null
}

type BirdTweetMedia = {
  kind: 'video' | 'audio'
  urls: string[]
  preferredUrl: string | null
  source: 'extended_entities' | 'card' | 'entities'
}

const URL_PREFIX_PATTERN = /^https?:\/\//i

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const isLikelyVideoUrl = (url: string): boolean =>
  url.includes('video.twimg.com') || url.includes('/i/broadcasts/') || url.endsWith('.m3u8')

const addUrl = (set: Set<string>, value: string | null) => {
  if (!value) return
  if (!URL_PREFIX_PATTERN.test(value)) return
  set.add(value)
}

function extractMediaFromBirdRaw(raw: unknown): BirdTweetMedia | null {
  const root = asRecord(raw)
  if (!root) return null

  const legacy = asRecord(root.legacy)
  const extended = asRecord(legacy?.extended_entities)
  const mediaEntries = asArray(extended?.media)
  if (mediaEntries && mediaEntries.length > 0) {
    const urls = new Set<string>()
    let preferredUrl: string | null = null
    let preferredBitrate = -1
    let kind: BirdTweetMedia['kind'] = 'video'

    for (const entry of mediaEntries) {
      const media = asRecord(entry)
      const mediaType = asString(media?.type)
      if (mediaType === 'audio') {
        kind = 'audio'
      }
      if (mediaType !== 'video' && mediaType !== 'animated_gif' && mediaType !== 'audio') {
        continue
      }
      const videoInfo = asRecord(media?.video_info)
      const variants = asArray(videoInfo?.variants)
      if (!variants) continue
      for (const variant of variants) {
        const variantRecord = asRecord(variant)
        const url = asString(variantRecord?.url)
        if (!url) continue
        addUrl(urls, url)
        const contentType = asString(variantRecord?.content_type) ?? ''
        const bitrate = typeof variantRecord?.bitrate === 'number' ? variantRecord.bitrate : -1
        if (contentType.includes('video/mp4') && bitrate >= preferredBitrate) {
          preferredBitrate = bitrate
          preferredUrl = url
        } else if (!preferredUrl) {
          preferredUrl = url
        }
      }
    }

    if (urls.size > 0) {
      return {
        kind,
        urls: Array.from(urls),
        preferredUrl,
        source: 'extended_entities',
      }
    }
  }

  const card = asRecord(root.card)
  const cardLegacy = asRecord(card?.legacy)
  const bindings = asArray(cardLegacy?.binding_values)
  if (bindings) {
    const urls = new Set<string>()
    for (const binding of bindings) {
      const record = asRecord(binding)
      const key = asString(record?.key)
      if (key !== 'broadcast_url') continue
      const value = asRecord(record?.value)
      const url = asString(value?.string_value)
      addUrl(urls, url)
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null
      return {
        kind: 'video',
        urls: Array.from(urls),
        preferredUrl,
        source: 'card',
      }
    }
  }

  const entities = asRecord(legacy?.entities)
  const entityUrls = asArray(entities?.urls)
  if (entityUrls) {
    const urls = new Set<string>()
    for (const entity of entityUrls) {
      const record = asRecord(entity)
      const expanded = asString(record?.expanded_url)
      if (!expanded || !isLikelyVideoUrl(expanded)) continue
      addUrl(urls, expanded)
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null
      return {
        kind: 'video',
        urls: Array.from(urls),
        preferredUrl,
        source: 'entities',
      }
    }
  }

  return null
}

function isTwitterStatusUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!TWITTER_HOSTS.has(host)) return false
    return /\/status\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
}

export async function readTweetWithBird(args: {
  url: string
  timeoutMs: number
  env: Record<string, string | undefined>
}): Promise<BirdTweetPayload> {
  return await new Promise((resolve, reject) => {
    const toText = (value: string | Buffer | null | undefined) =>
      typeof value === 'string' ? value : value ? value.toString('utf8') : ''

    execFileTracked(
      'bird',
      ['read', args.url, '--json-full'],
      {
        timeout: args.timeoutMs,
        env: { ...process.env, ...args.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = toText(stderr).trim()
          const suffix = detail ? `: ${detail}` : ''
          reject(new Error(`bird read failed${suffix}`))
          return
        }
        const trimmed = toText(stdout).trim()
        if (!trimmed) {
          reject(new Error('bird read returned empty output'))
          return
        }
        try {
          const parsed = JSON.parse(trimmed) as
            | (BirdTweetPayload & { _raw?: unknown })
            | Array<BirdTweetPayload & { _raw?: unknown }>
          const tweet = Array.isArray(parsed) ? parsed[0] : parsed
          if (!tweet || typeof tweet.text !== 'string') {
            reject(new Error('bird read returned invalid payload'))
            return
          }
          const { _raw, ...rest } = tweet as BirdTweetPayload & { _raw?: unknown }
          const media = extractMediaFromBirdRaw(_raw)
          resolve({ ...rest, media })
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : String(parseError)
          reject(new Error(`bird read returned invalid JSON: ${message}`))
        }
      }
    )
  })
}

export function withBirdTip(
  error: unknown,
  url: string | null,
  env: Record<string, string | undefined>
): Error {
  if (!url || !isTwitterStatusUrl(url) || hasBirdCli(env) || !BIRD_TIP) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const message = error instanceof Error ? error.message : String(error)
  const combined = `${message}\n${BIRD_TIP}`
  return error instanceof Error ? new Error(combined, { cause: error }) : new Error(combined)
}
