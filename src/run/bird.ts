import { execFile } from 'node:child_process'
import { BIRD_TIP, TWITTER_HOSTS } from './constants.js'
import { hasBirdCli } from './env.js'

type BirdTweetPayload = {
  id?: string
  text: string
  author?: { username?: string; name?: string }
  createdAt?: string
}

/**
 * Full tweet data structure returned by bird search/read commands
 */
export type TweetData = {
  id: string
  text: string
  author: {
    username: string
    name: string
  }
  authorId?: string
  createdAt?: string
  replyCount?: number
  retweetCount?: number
  likeCount?: number
  conversationId?: string
  inReplyToStatusId?: string
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
    execFile(
      'bird',
      ['read', args.url, '--json'],
      {
        timeout: args.timeoutMs,
        env: { ...process.env, ...args.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim()
          const suffix = detail ? `: ${detail}` : ''
          reject(new Error(`bird read failed${suffix}`))
          return
        }
        const trimmed = stdout.trim()
        if (!trimmed) {
          reject(new Error('bird read returned empty output'))
          return
        }
        try {
          const parsed = JSON.parse(trimmed) as BirdTweetPayload | BirdTweetPayload[]
          const tweet = Array.isArray(parsed) ? parsed[0] : parsed
          if (!tweet || typeof tweet.text !== 'string') {
            reject(new Error('bird read returned invalid payload'))
            return
          }
          resolve(tweet)
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
  if (!url || !isTwitterStatusUrl(url) || hasBirdCli(env)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const message = error instanceof Error ? error.message : String(error)
  const combined = `${message}\n${BIRD_TIP}`
  return error instanceof Error ? new Error(combined, { cause: error }) : new Error(combined)
}

/**
 * Search for tweets from a user within a date range using bird CLI
 */
export async function searchTweetsWithBird(args: {
  user: string
  since?: string
  until?: string
  count: number
  timeoutMs: number
  env: Record<string, string | undefined>
}): Promise<{ success: true; tweets: TweetData[] } | { success: false; error: string }> {
  const queryParts: string[] = [`from:${args.user}`]
  if (args.since) queryParts.push(`since:${args.since}`)
  if (args.until) queryParts.push(`until:${args.until}`)
  const query = queryParts.join(' ')

  // Support BIRD_PATH environment variable for custom bird binary location
  const birdPath = args.env.BIRD_PATH || 'bird'

  return new Promise((resolve) => {
    execFile(
      birdPath,
      ['search', query, '--json', '-n', String(args.count)],
      {
        timeout: args.timeoutMs,
        env: { ...process.env, ...args.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB for large tweet sets
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            resolve({
              success: false,
              error: 'bird CLI not found. Install from https://github.com/steipete/bird',
            })
            return
          }
          const detail = stderr?.trim()
          const suffix = detail ? `: ${detail}` : ''
          resolve({ success: false, error: `bird search failed${suffix}` })
          return
        }

        const trimmed = stdout.trim()
        if (!trimmed) {
          resolve({ success: true, tweets: [] })
          return
        }

        try {
          const parsed = JSON.parse(trimmed) as TweetData[]
          if (!Array.isArray(parsed)) {
            resolve({ success: false, error: 'bird search returned invalid JSON (expected array)' })
            return
          }
          resolve({ success: true, tweets: parsed })
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : String(parseError)
          resolve({ success: false, error: `bird search returned invalid JSON: ${message}` })
        }
      }
    )
  })
}
