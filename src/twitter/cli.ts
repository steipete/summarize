import { generateTextWithModelId } from '../llm/generate-text.js'
import { searchTweetsWithBird, type TweetData } from '../run/bird.js'
import { buildTwitterHelp } from '../run/help.js'

export type TwitterCliContext = {
  normalizedArgv: string[]
  envForRun: Record<string, string | undefined>
  fetchImpl: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

function readArgValue(argv: string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(`${name}=`.length).trim() || null
  const index = argv.indexOf(name)
  if (index === -1) return null
  const next = argv[index + 1]
  if (!next || next.startsWith('-')) return null
  return next.trim() || null
}

function wantHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`))
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function validateDateFormat(value: string, flagName: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${flagName} must be in YYYY-MM-DD format (got: ${value})`)
  }
}

function normalizeUsername(user: string): string {
  return user.startsWith('@') ? user.slice(1) : user
}

function formatDateForDisplay(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatTweetsForContext(tweets: TweetData[], user: string): string {
  if (tweets.length === 0) return ''

  const lines: string[] = []

  // Group tweets by date
  const tweetsByDate = new Map<string, TweetData[]>()
  for (const tweet of tweets) {
    const dateKey = tweet.createdAt ? formatDateForDisplay(tweet.createdAt) : 'Unknown date'
    const existing = tweetsByDate.get(dateKey) || []
    existing.push(tweet)
    tweetsByDate.set(dateKey, existing)
  }

  lines.push(`# Tweets from @${user}`)
  lines.push('')

  for (const [date, dateTweets] of tweetsByDate) {
    lines.push(`## ${date}`)
    lines.push('')
    for (const tweet of dateTweets) {
      lines.push(tweet.text)
      lines.push('')
    }
  }

  return lines.join('\n')
}

function formatTweetsForExtract(tweets: TweetData[], json: boolean): string {
  if (json) {
    return JSON.stringify(tweets, null, 2)
  }

  const lines: string[] = []
  for (const tweet of tweets) {
    const date = tweet.createdAt ? formatDateForDisplay(tweet.createdAt) : ''
    lines.push(`@${tweet.author.username} (${date}):`)
    lines.push(tweet.text)
    lines.push(`https://x.com/${tweet.author.username}/status/${tweet.id}`)
    lines.push('---')
  }
  return lines.join('\n')
}

async function summarizeTweetsWithLLM(args: {
  context: string
  user: string
  tweetCount: number
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
}): Promise<{ success: true; summary: string } | { success: false; error: string }> {
  const { context, user, tweetCount, env, fetchImpl } = args

  // Check for API keys
  const openrouterApiKey = env.OPENROUTER_API_KEY ?? null
  const openaiApiKey = env.OPENAI_API_KEY ?? null
  const anthropicApiKey = env.ANTHROPIC_API_KEY ?? null
  const xaiApiKey = env.XAI_API_KEY ?? null
  const googleApiKey = env.GEMINI_API_KEY ?? null

  if (!openrouterApiKey && !openaiApiKey && !anthropicApiKey && !xaiApiKey && !googleApiKey) {
    return {
      success: false,
      error: 'No LLM API key found. Set OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, or GEMINI_API_KEY.',
    }
  }

  // Select model based on available keys
  // When using OpenRouter, we use openai/ prefix with forceOpenRouter=true
  // OpenRouter routes through the OpenAI-compatible API
  let modelId: string
  const useOpenRouter = Boolean(openrouterApiKey)
  if (useOpenRouter) {
    // Use openai/ prefix for OpenRouter - it routes to any model
    // Using Claude 3.5 Sonnet via OpenRouter (specify as openai/ model)
    modelId = 'openai/anthropic/claude-3.5-sonnet'
  } else if (anthropicApiKey) {
    modelId = 'anthropic/claude-3-5-sonnet-20241022'
  } else if (openaiApiKey) {
    modelId = 'openai/gpt-4o-mini'
  } else if (xaiApiKey) {
    modelId = 'xai/grok-2-latest'
  } else {
    modelId = 'google/gemini-2.0-flash-exp'
  }

  const prompt = `You are analyzing ${tweetCount} tweets from Twitter user @${user}.

Provide a concise summary of what this user has been tweeting about. Include:
1. Main topics and themes
2. Notable announcements or updates
3. Key interactions or discussions
4. Overall tone and sentiment

Here are the tweets:

${context}

Provide a well-structured summary in markdown format.`

  try {
    const result = await generateTextWithModelId({
      modelId,
      apiKeys: {
        xaiApiKey,
        openaiApiKey,
        googleApiKey,
        anthropicApiKey,
        openrouterApiKey,
      },
      forceOpenRouter: useOpenRouter,
      prompt,
      temperature: 0.3,
      maxOutputTokens: 2000,
      timeoutMs: 120_000,
      fetchImpl,
      retries: 1,
    })

    return { success: true, summary: result.text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: `LLM summarization failed: ${message}` }
  }
}

export async function handleTwitterRequest(ctx: TwitterCliContext): Promise<boolean> {
  const { normalizedArgv, envForRun, stdout, stderr } = ctx

  if (normalizedArgv[0]?.toLowerCase() !== 'twitter') {
    return false
  }

  if (wantHelp(normalizedArgv)) {
    stdout.write(`${buildTwitterHelp()}\n`)
    return true
  }

  // Parse arguments
  const userRaw = readArgValue(normalizedArgv, '--user')
  const since = readArgValue(normalizedArgv, '--since')
  const until = readArgValue(normalizedArgv, '--until')
  const countRaw = readArgValue(normalizedArgv, '-n') || readArgValue(normalizedArgv, '--count')
  const extractMode = hasArg(normalizedArgv, '--extract')
  const jsonMode = hasArg(normalizedArgv, '--json')

  // Validate required arguments
  if (!userRaw) {
    throw new Error('--user is required. Example: summarize twitter --user steipete --since 2025-01-01')
  }

  const user = normalizeUsername(userRaw)

  // Validate date formats
  if (since) validateDateFormat(since, '--since')
  if (until) validateDateFormat(until, '--until')

  // Parse count
  const count = countRaw ? parseInt(countRaw, 10) : 20
  if (isNaN(count) || count < 1) {
    throw new Error('--count must be a positive number')
  }
  if (count > 100) {
    throw new Error('--count cannot exceed 100')
  }

  // Fetch tweets using shared bird integration
  const timeoutMs = 60_000 // 1 minute timeout for bird
  const result = await searchTweetsWithBird({
    user,
    since: since ?? undefined,
    until: until ?? undefined,
    count,
    timeoutMs,
    env: envForRun,
  })

  if (!result.success) {
    throw new Error(result.error)
  }

  const tweets = result.tweets
  if (tweets.length === 0) {
    const range = since && until ? ` from ${since} to ${until}` : since ? ` since ${since}` : until ? ` until ${until}` : ''
    throw new Error(`No tweets found for @${user}${range}`)
  }

  // Extract mode: output tweets without summarization
  if (extractMode) {
    const output = formatTweetsForExtract(tweets, jsonMode)
    stdout.write(`${output}\n`)
    return true
  }

  // Summarization mode: format and summarize
  const context = formatTweetsForContext(tweets, user)

  stderr.write(`Found ${tweets.length} tweets from @${user}, summarizing...\n`)

  const summaryResult = await summarizeTweetsWithLLM({
    context,
    user,
    tweetCount: tweets.length,
    env: envForRun,
    fetchImpl: ctx.fetchImpl,
  })

  if (!summaryResult.success) {
    throw new Error(summaryResult.error)
  }

  if (jsonMode) {
    const jsonOutput = {
      user,
      tweetCount: tweets.length,
      since,
      until,
      summary: summaryResult.summary,
      tweets,
    }
    stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`)
  } else {
    stdout.write(summaryResult.summary)
    stdout.write('\n')
  }

  return true
}
