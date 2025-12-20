import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { Command, CommanderError, Option } from 'commander'
import { countTokens } from 'gpt-tokenizer'
import { createLiveRenderer, render as renderMarkdownAnsi } from 'markdansi'
import { normalizeTokenUsage, tallyCosts } from 'tokentally'
import { loadSummarizeConfig } from './config.js'
import {
  buildAssetPromptMessages,
  classifyUrl,
  loadLocalAsset,
  loadRemoteAsset,
  resolveInputTarget,
} from './content/asset.js'
import { createLinkPreviewClient } from './content/index.js'
import type { LlmCall } from './costs.js'
import { buildRunMetricsReport } from './costs.js'
import { createFirecrawlScraper } from './firecrawl.js'
import {
  parseDurationMs,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parseRenderMode,
  parseStreamMode,
  parseYoutubeMode,
} from './flags.js'
import { generateTextWithModelId, streamTextWithModelId } from './llm/generate-text.js'
import { resolveGoogleModelForUsage } from './llm/google-models.js'
import { createHtmlToMarkdownConverter } from './llm/html-to-markdown.js'
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from './llm/model-id.js'
import {
  loadLiteLlmCatalog,
  resolveLiteLlmMaxInputTokensForModelId,
  resolveLiteLlmMaxOutputTokensForModelId,
  resolveLiteLlmPricingForModelId,
} from './pricing/litellm.js'
import { buildFileSummaryPrompt, buildLinkSummaryPrompt } from './prompts/index.js'
import type { SummaryLength } from './shared/contracts.js'
import { startOscProgress } from './tty/osc-progress.js'
import { startSpinner } from './tty/spinner.js'
import { resolvePackageVersion } from './version.js'

type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

const BIRD_TIP = 'Tip: Install bird🐦 for better Twitter support: https://github.com/steipete/bird'
const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
const SUMMARY_LENGTH_MAX_CHARACTERS: Record<SummaryLength, number> = {
  short: 1200,
  medium: 2500,
  long: 6000,
  xl: 14000,
  xxl: Number.POSITIVE_INFINITY,
}

function resolveTargetCharacters(
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
): number {
  return lengthArg.kind === 'chars'
    ? lengthArg.maxCharacters
    : SUMMARY_LENGTH_MAX_CHARACTERS[lengthArg.preset]
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

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function hasBirdCli(env: Record<string, string | undefined>): boolean {
  const candidates: string[] = []
  const pathEnv = env.PATH ?? process.env.PATH ?? ''
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue
    candidates.push(path.join(entry, 'bird'))
  }
  return candidates.some((candidate) => isExecutable(candidate))
}

type BirdTweetPayload = {
  id?: string
  text: string
  author?: { username?: string; name?: string }
  createdAt?: string
}

async function readTweetWithBird(args: {
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

function withBirdTip(
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

type JsonOutput = {
  input: {
    timeoutMs: number
    length: { kind: 'preset'; preset: string } | { kind: 'chars'; maxCharacters: number }
    maxOutputTokens: number | null
    model: string
  } & (
    | {
        kind: 'url'
        url: string
        youtube: string
        firecrawl: string
        markdown: string
      }
    | {
        kind: 'file'
        filePath: string
      }
    | {
        kind: 'asset-url'
        url: string
      }
  )
  env: {
    hasXaiKey: boolean
    hasOpenAIKey: boolean
    hasApifyToken: boolean
    hasFirecrawlKey: boolean
    hasGoogleKey: boolean
    hasAnthropicKey: boolean
  }
  extracted: unknown
  prompt: string
  llm: {
    provider: 'xai' | 'openai' | 'google' | 'anthropic'
    model: string
    maxCompletionTokens: number | null
    strategy: 'single'
  } | null
  metrics: ReturnType<typeof buildRunMetricsReport> | null
  summary: string | null
}

const MAX_TEXT_BYTES_DEFAULT = 10 * 1024 * 1024

function buildProgram() {
  return new Command()
    .name('summarize')
    .description('Summarize web pages and YouTube links (uses direct provider API keys).')
    .argument('[input]', 'URL or local file path to summarize')
    .option(
      '--youtube <mode>',
      'YouTube transcript source: auto, web (youtubei/captionTracks), yt-dlp (audio+whisper), apify',
      'auto'
    )
    .option(
      '--firecrawl <mode>',
      'Firecrawl usage: off, auto (fallback), always (try Firecrawl first).',
      'auto'
    )
    .option(
      '--markdown <mode>',
      'Website Markdown output: off, auto (use LLM when configured), llm (force LLM). Only affects --extract-only for non-YouTube URLs.',
      'auto'
    )
    .option(
      '--length <length>',
      'Summary length: short|medium|long|xl|xxl or a character limit like 20000, 20k',
      'medium'
    )
    .option(
      '--max-output-tokens <count>',
      'Hard cap for LLM output tokens (e.g. 2000, 2k). Overrides provider defaults.',
      undefined
    )
    .option(
      '--timeout <duration>',
      'Timeout for content fetching and LLM request: 30 (seconds), 30s, 2m, 5000ms',
      '2m'
    )
    .option(
      '--model <model>',
      'LLM model id (gateway-style): xai/..., openai/..., google/... (default: google/gemini-3-flash-preview)',
      undefined
    )
    .option('--extract-only', 'Print extracted content and exit (no LLM summary)', false)
    .option('--json', 'Output structured JSON (includes prompt + metrics)', false)
    .option(
      '--stream <mode>',
      'Stream LLM output: auto (TTY only), on, off. Note: streaming is disabled in --json mode.',
      'auto'
    )
    .option(
      '--render <mode>',
      'Render Markdown output: auto (TTY only), md-live, md, plain. Note: auto selects md-live when streaming to a TTY.',
      'auto'
    )
    .option('--verbose', 'Print detailed progress info to stderr', false)
    .addOption(
      new Option('--metrics <mode>', 'Metrics output: off, on, detailed')
        .choices(['off', 'on', 'detailed'])
        .default('on')
    )
    .option('-V, --version', 'Print version and exit', false)
    .allowExcessArguments(false)
}

function isRichTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as unknown as { isTTY?: boolean }).isTTY)
}

function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>
): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true
  if (!isRichTty(stream)) return false
  const term = env.TERM?.toLowerCase()
  if (!term || term === 'dumb') return false
  return true
}

function terminalWidth(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>
): number {
  const cols = (stream as unknown as { columns?: unknown }).columns
  if (typeof cols === 'number' && Number.isFinite(cols) && cols > 0) {
    return Math.floor(cols)
  }
  const fromEnv = env.COLUMNS ? Number(env.COLUMNS) : NaN
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv)
  }
  return 80
}

function markdownRenderWidth(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>
): number {
  // Avoid “phantom blank lines” from terminal auto-wrap when the rendered line hits the exact width.
  // Wrap 1 column earlier so explicit newlines don't combine with terminal soft-wrap.
  const w = terminalWidth(stream, env)
  return Math.max(20, w - 1)
}

function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input
  return `\u001b[${code}m${input}\u001b[0m`
}

function isUnsupportedAttachmentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { name?: unknown; message?: unknown }
  const name = typeof err.name === 'string' ? err.name : ''
  const message = typeof err.message === 'string' ? err.message : ''
  if (name.toLowerCase().includes('unsupportedfunctionality')) return true
  if (message.toLowerCase().includes('functionality not supported')) return true
  return false
}

function isTextLikeMediaType(mediaType: string): boolean {
  const mt = mediaType.toLowerCase()
  if (mt.startsWith('text/')) return true
  // Common “text but not text/*” types we want to inline instead of attaching as a file part.
  return (
    mt === 'application/json' ||
    mt === 'application/xml' ||
    mt === 'application/x-yaml' ||
    mt === 'application/yaml' ||
    mt === 'application/toml' ||
    mt === 'application/rtf' ||
    mt === 'application/javascript'
  )
}

function isArchiveMediaType(mediaType: string): boolean {
  const mt = mediaType.toLowerCase()
  return (
    mt === 'application/zip' ||
    mt === 'application/x-zip-compressed' ||
    mt === 'application/x-7z-compressed' ||
    mt === 'application/x-rar-compressed' ||
    mt === 'application/x-tar' ||
    mt === 'application/gzip'
  )
}

function attachmentByteLength(
  attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
) {
  if (attachment.part.type === 'image') {
    const image = attachment.part.image
    if (image instanceof Uint8Array) return image.byteLength
    if (typeof image === 'string') return image.length
    return null
  }

  const data = (attachment.part as { data?: unknown }).data
  if (data instanceof Uint8Array) return data.byteLength
  if (typeof data === 'string') return data.length
  return null
}

function assertAssetMediaTypeSupported({
  attachment,
  sizeLabel,
}: {
  attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
  sizeLabel: string | null
}) {
  if (!isArchiveMediaType(attachment.mediaType)) return

  const name = attachment.filename ?? 'file'
  const bytes = attachmentByteLength(attachment)
  const size = sizeLabel ?? (typeof bytes === 'number' ? formatBytes(bytes) : null)
  const details = size ? `${attachment.mediaType}, ${size}` : attachment.mediaType

  throw new Error(
    `Unsupported file type: ${name} (${details})\n` +
      `Archive formats (zip/tar/7z/rar) can’t be sent to the model.\n` +
      `Unzip and summarize a specific file instead (e.g. README.md).`
  )
}

function buildAssetPromptPayload({
  promptText,
  attachment,
  textContent,
}: {
  promptText: string
  attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
  textContent: { content: string; bytes: number } | null
}): string | Array<ModelMessage> {
  if (textContent && attachment.part.type === 'file' && isTextLikeMediaType(attachment.mediaType)) {
    const header = `File: ${attachment.filename ?? 'unknown'} (${attachment.mediaType})`
    return `${promptText}\n\n---\n${header}\n\n${textContent.content}`.trim()
  }

  return buildAssetPromptMessages({ promptText, attachment })
}

function getTextContentFromAttachment(
  attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
): { content: string; bytes: number } | null {
  if (attachment.part.type !== 'file' || !isTextLikeMediaType(attachment.mediaType)) {
    return null
  }
  const data = (attachment.part as { data?: unknown }).data
  if (typeof data === 'string') {
    return { content: data, bytes: Buffer.byteLength(data, 'utf8') }
  }
  if (data instanceof Uint8Array) {
    return { content: new TextDecoder().decode(data), bytes: data.byteLength }
  }
  return { content: '', bytes: 0 }
}

function assertProviderSupportsAttachment({
  provider,
  modelId,
  attachment,
}: {
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  modelId: string
  attachment: { part: { type: string }; mediaType: string }
}) {
  // xAI via AI SDK currently supports image parts, but not generic file parts (e.g. PDFs).
  if (
    provider === 'xai' &&
    attachment.part.type === 'file' &&
    !isTextLikeMediaType(attachment.mediaType)
  ) {
    throw new Error(
      `Model ${modelId} does not support attaching files of type ${attachment.mediaType}. Try a different --model (e.g. google/gemini-3-flash-preview).`
    )
  }
}

async function resolveModelIdForLlmCall({
  parsedModel,
  apiKeys,
  fetchImpl,
  timeoutMs,
}: {
  parsedModel: ReturnType<typeof parseGatewayStyleModelId>
  apiKeys: {
    googleApiKey: string | null
  }
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<{ modelId: string; note: string | null; forceStreamOff: boolean }> {
  if (parsedModel.provider !== 'google') {
    return { modelId: parsedModel.canonical, note: null, forceStreamOff: false }
  }

  const key = apiKeys.googleApiKey
  if (!key) {
    return { modelId: parsedModel.canonical, note: null, forceStreamOff: false }
  }

  const resolved = await resolveGoogleModelForUsage({
    requestedModelId: parsedModel.model,
    apiKey: key,
    fetchImpl,
    timeoutMs,
  })

  return {
    modelId: `google/${resolved.resolvedModelId}`,
    note: resolved.note,
    forceStreamOff: false,
  }
}

function isGoogleStreamingUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const maybe = error as Record<string, unknown>
  const message = typeof maybe.message === 'string' ? maybe.message : ''
  const url = typeof maybe.url === 'string' ? maybe.url : ''
  const responseBody = typeof maybe.responseBody === 'string' ? maybe.responseBody : ''
  const errorText = `${message}\n${responseBody}`

  const isStreamEndpoint =
    url.includes(':streamGenerateContent') || errorText.includes('streamGenerateContent')
  if (!isStreamEndpoint) return false

  return (
    /does not support/i.test(errorText) ||
    /not supported/i.test(errorText) ||
    /Call ListModels/i.test(errorText) ||
    /supported methods/i.test(errorText)
  )
}

function isStreamingTimeoutError(error: unknown): boolean {
  if (!error) return false
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message?: unknown }).message)
          : ''
  return /timed out/i.test(message)
}

function attachRichHelp(
  program: Command,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream
) {
  const color = supportsColor(stdout, env)
  const heading = (text: string) => ansi('1;36', text, color)
  const cmd = (text: string) => ansi('1', text, color)
  const dim = (text: string) => ansi('2', text, color)

  program.addHelpText(
    'after',
    () => `
${heading('Examples')}
  ${cmd('summarize "https://example.com"')}
  ${cmd('summarize "https://example.com" --extract-only')} ${dim('# website markdown (LLM if configured)')}
  ${cmd('summarize "https://example.com" --extract-only --markdown llm')} ${dim('# website markdown via LLM')}
  ${cmd('summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --extract-only --youtube web')}
  ${cmd('summarize "https://example.com" --length 20k --max-output-tokens 2k --timeout 2m --model openai/gpt-5.2')}
  ${cmd('OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENROUTER_API_KEY=... summarize "https://example.com" --model openai/xiaomi/mimo-v2-flash:free')}
  ${cmd('summarize "https://example.com" --json --verbose')}

${heading('Env Vars')}
  XAI_API_KEY           optional (required for xai/... models)
  OPENAI_API_KEY        optional (required for openai/... models)
  OPENAI_BASE_URL       optional (OpenAI-compatible API endpoint; e.g. OpenRouter)
  OPENROUTER_API_KEY    optional (used when OPENAI_BASE_URL points to OpenRouter)
  GEMINI_API_KEY        optional (required for google/... models)
  ANTHROPIC_API_KEY     optional (required for anthropic/... models)
  SUMMARIZE_MODEL       optional (overrides default model selection)
  FIRECRAWL_API_KEY     optional website extraction fallback (Markdown)
  APIFY_API_TOKEN       optional YouTube transcript fallback
  YT_DLP_PATH           optional path to yt-dlp binary for audio extraction
  FAL_KEY               optional FAL AI API key for audio transcription
`
  )
}

async function summarizeWithModelId({
  modelId,
  prompt,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  apiKeys,
}: {
  modelId: string
  prompt: string | ModelMessage[]
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  apiKeys: {
    xaiApiKey: string | null
    openaiApiKey: string | null
    googleApiKey: string | null
    anthropicApiKey: string | null
  }
}): Promise<{
  text: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  canonicalModelId: string
  usage: Awaited<ReturnType<typeof generateTextWithModelId>>['usage']
}> {
  const result = await generateTextWithModelId({
    modelId,
    apiKeys,
    prompt,
    temperature: 0,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
  })
  return {
    text: result.text,
    provider: result.provider,
    canonicalModelId: result.canonicalModelId,
    usage: result.usage,
  }
}

const VERBOSE_PREFIX = '[summarize]'

function writeVerbose(
  stderr: NodeJS.WritableStream,
  verbose: boolean,
  message: string,
  color: boolean
): void {
  if (!verbose) {
    return
  }
  const prefix = ansi('36', VERBOSE_PREFIX, color)
  stderr.write(`${prefix} ${message}\n`)
}

function formatOptionalString(value: string | null | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return 'none'
}

function formatOptionalNumber(value: number | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return 'none'
}

function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  return value.toLocaleString('en-US')
}

function sumNumbersOrNull(values: Array<number | null>): number | null {
  let sum = 0
  let any = false
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value
      any = true
    }
  }
  return any ? sum : null
}

function formatUSD(value: number): string {
  if (!Number.isFinite(value)) return 'n/a'
  return `$${value.toFixed(4)}`
}

function mergeStreamingChunk(previous: string, chunk: string): { next: string; appended: string } {
  if (!chunk) return { next: previous, appended: '' }
  if (chunk.startsWith(previous)) {
    return { next: chunk, appended: chunk.slice(previous.length) }
  }
  return { next: previous + chunk, appended: chunk }
}

function writeFinishLine({
  stderr,
  elapsedMs,
  model,
  report,
  costUsd,
  color,
}: {
  stderr: NodeJS.WritableStream
  elapsedMs: number
  model: string
  report: ReturnType<typeof buildRunMetricsReport>
  costUsd: number | null
  color: boolean
}): void {
  const promptTokens = sumNumbersOrNull(report.llm.map((row) => row.promptTokens))
  const completionTokens = sumNumbersOrNull(report.llm.map((row) => row.completionTokens))
  const totalTokens = sumNumbersOrNull(report.llm.map((row) => row.totalTokens))

  const tokPart =
    promptTokens !== null || completionTokens !== null || totalTokens !== null
      ? `tok(i/o/t)=${promptTokens?.toLocaleString() ?? 'unknown'}/${completionTokens?.toLocaleString() ?? 'unknown'}/${totalTokens?.toLocaleString() ?? 'unknown'}`
      : 'tok(i/o/t)=unknown'

  const parts: string[] = [
    model,
    costUsd != null ? `cost=${formatUSD(costUsd)}` : 'cost=N/A',
    tokPart,
  ]

  if (report.services.firecrawl.requests > 0) {
    parts.push(`firecrawl=${report.services.firecrawl.requests}`)
  }
  if (report.services.apify.requests > 0) {
    parts.push(`apify=${report.services.apify.requests}`)
  }

  const line = `Finished in ${formatElapsedMs(elapsedMs)} (${parts.join(' | ')})`
  stderr.write('\n')
  stderr.write(`${ansi('1;32', line, color)}\n`)
}

export async function runCli(
  argv: string[],
  { env, fetch, stdout, stderr }: RunEnv
): Promise<void> {
  ;(globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

  const normalizedArgv = argv.filter((arg) => arg !== '--')
  const version = resolvePackageVersion()
  const program = buildProgram()
  program.configureOutput({
    writeOut(str) {
      stdout.write(str)
    },
    writeErr(str) {
      stderr.write(str)
    },
  })
  program.exitOverride()
  attachRichHelp(program, env, stdout)

  try {
    program.parse(normalizedArgv, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return
    }
    throw error
  }

  if (program.opts().version) {
    stdout.write(`${version}\n`)
    return
  }

  const rawInput = program.args[0]
  if (!rawInput) {
    throw new Error(
      'Usage: summarize <url-or-file> [--youtube auto|web|apify] [--length 20k] [--max-output-tokens 2k] [--timeout 2m] [--json]'
    )
  }

  const inputTarget = resolveInputTarget(rawInput)
  const url = inputTarget.kind === 'url' ? inputTarget.url : null

  const runStartedAtMs = Date.now()

  const youtubeMode = parseYoutubeMode(program.opts().youtube as string)
  const lengthArg = parseLengthArg(program.opts().length as string)
  const maxOutputTokensArg = parseMaxOutputTokensArg(
    program.opts().maxOutputTokens as string | undefined
  )
  const timeoutMs = parseDurationMs(program.opts().timeout as string)
  const extractOnly = Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const streamMode = parseStreamMode(program.opts().stream as string)
  const renderMode = parseRenderMode(program.opts().render as string)
  const verbose = Boolean(program.opts().verbose)
  const metricsMode = parseMetricsMode(program.opts().metrics as string)
  const metricsEnabled = metricsMode !== 'off'
  const metricsDetailed = metricsMode === 'detailed'
  const markdownMode = parseMarkdownMode(program.opts().markdown as string)

  const shouldComputeReport = metricsEnabled

  const isYoutubeUrl = typeof url === 'string' ? /youtube\.com|youtu\.be/i.test(url) : false
  const requestedFirecrawlMode = parseFirecrawlMode(program.opts().firecrawl as string)
  const modelArg =
    typeof program.opts().model === 'string' ? (program.opts().model as string) : null

  const { config, path: configPath } = loadSummarizeConfig({ env })

  const xaiKeyRaw = typeof env.XAI_API_KEY === 'string' ? env.XAI_API_KEY : null
  const openaiBaseUrl = typeof env.OPENAI_BASE_URL === 'string' ? env.OPENAI_BASE_URL : null
  const openRouterKeyRaw =
    typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY : null
  const openaiKeyRaw = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : null
  const apiKey =
    typeof openaiBaseUrl === 'string' && /openrouter\.ai/i.test(openaiBaseUrl)
      ? (openRouterKeyRaw ?? openaiKeyRaw)
      : openaiKeyRaw
  const apifyToken = typeof env.APIFY_API_TOKEN === 'string' ? env.APIFY_API_TOKEN : null
  const ytDlpPath = typeof env.YT_DLP_PATH === 'string' ? env.YT_DLP_PATH : null
  const falApiKey = typeof env.FAL_KEY === 'string' ? env.FAL_KEY : null
  const firecrawlKey = typeof env.FIRECRAWL_API_KEY === 'string' ? env.FIRECRAWL_API_KEY : null
  const anthropicKeyRaw = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : null
  const googleKeyRaw =
    typeof env.GEMINI_API_KEY === 'string'
      ? env.GEMINI_API_KEY
      : typeof env.GOOGLE_GENERATIVE_AI_API_KEY === 'string'
        ? env.GOOGLE_GENERATIVE_AI_API_KEY
        : typeof env.GOOGLE_API_KEY === 'string'
          ? env.GOOGLE_API_KEY
          : null

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null
  const firecrawlConfigured = firecrawlApiKey !== null
  const xaiApiKey = xaiKeyRaw?.trim() ?? null
  const googleApiKey = googleKeyRaw?.trim() ?? null
  const anthropicApiKey = anthropicKeyRaw?.trim() ?? null
  const googleConfigured = typeof googleApiKey === 'string' && googleApiKey.length > 0
  const xaiConfigured = typeof xaiApiKey === 'string' && xaiApiKey.length > 0
  const anthropicConfigured = typeof anthropicApiKey === 'string' && anthropicApiKey.length > 0

  const llmCalls: LlmCall[] = []
  let firecrawlRequests = 0
  let apifyRequests = 0

  let liteLlmCatalogPromise: ReturnType<typeof loadLiteLlmCatalog> | null = null
  const getLiteLlmCatalog = async () => {
    if (!liteLlmCatalogPromise) {
      liteLlmCatalogPromise = loadLiteLlmCatalog({
        env,
        fetchImpl: globalThis.fetch.bind(globalThis),
      })
    }
    const result = await liteLlmCatalogPromise
    return result.catalog
  }

  const capMaxOutputTokensForModel = async ({
    modelId,
    requested,
  }: {
    modelId: string
    requested: number
  }): Promise<number> => {
    const catalog = await getLiteLlmCatalog()
    if (!catalog) return requested
    const limit = resolveLiteLlmMaxOutputTokensForModelId(catalog, modelId)
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return Math.min(requested, limit)
    }
    return requested
  }
  const resolveMaxOutputTokensForCall = async (modelId: string): Promise<number | null> => {
    if (typeof maxOutputTokensArg !== 'number') return null
    return capMaxOutputTokensForModel({ modelId, requested: maxOutputTokensArg })
  }
  const resolveMaxInputTokensForCall = async (modelId: string): Promise<number | null> => {
    const catalog = await getLiteLlmCatalog()
    if (!catalog) return null
    const limit = resolveLiteLlmMaxInputTokensForModelId(catalog, modelId)
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return limit
    }
    return null
  }

  const estimateCostUsd = async (): Promise<number | null> => {
    const catalog = await getLiteLlmCatalog()
    if (!catalog) return null
    const calls = llmCalls.map((call) => {
      const promptTokens = call.usage?.promptTokens ?? null
      const completionTokens = call.usage?.completionTokens ?? null
      const hasTokens =
        typeof promptTokens === 'number' &&
        Number.isFinite(promptTokens) &&
        typeof completionTokens === 'number' &&
        Number.isFinite(completionTokens)
      const usage = hasTokens
        ? normalizeTokenUsage({
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            totalTokens: call.usage?.totalTokens ?? undefined,
          })
        : null
      return { model: call.model, usage }
    })

    const result = await tallyCosts({
      calls,
      resolvePricing: (modelId) => resolveLiteLlmPricingForModelId(catalog, modelId),
    })
    return result.total?.totalUsd ?? null
  }
  const buildReport = async () => {
    return buildRunMetricsReport({ llmCalls, firecrawlRequests, apifyRequests })
  }

  const trackedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let hostname: string | null = null
    try {
      hostname = new URL(url).hostname.toLowerCase()
    } catch {
      hostname = null
    }
    if (hostname === 'api.firecrawl.dev') {
      firecrawlRequests += 1
    } else if (hostname === 'api.apify.com') {
      apifyRequests += 1
    }
    return fetch(input as RequestInfo, init)
  }

  const resolvedDefaultModel = (() => {
    if (typeof env.SUMMARIZE_MODEL === 'string' && env.SUMMARIZE_MODEL.trim().length > 0) {
      return env.SUMMARIZE_MODEL.trim()
    }
    if (typeof config?.model === 'string' && config.model.trim().length > 0) {
      return config.model.trim()
    }
    return 'google/gemini-3-flash-preview'
  })()

  const model = normalizeGatewayStyleModelId((modelArg?.trim() ?? '') || resolvedDefaultModel)
  const parsedModelForLlm = parseGatewayStyleModelId(model)

  const verboseColor = supportsColor(stderr, env)
  const effectiveStreamMode = (() => {
    if (streamMode !== 'auto') return streamMode
    return isRichTty(stdout) ? 'on' : 'off'
  })()
  const streamingEnabled = effectiveStreamMode === 'on' && !json && !extractOnly
  const effectiveRenderMode = (() => {
    if (renderMode !== 'auto') return renderMode
    if (!isRichTty(stdout)) return 'plain'
    return streamingEnabled ? 'md-live' : 'md'
  })()
  const writeMetricsReport = (report: ReturnType<typeof buildRunMetricsReport>) => {
    const promptTokens = sumNumbersOrNull(report.llm.map((row) => row.promptTokens))
    const completionTokens = sumNumbersOrNull(report.llm.map((row) => row.completionTokens))
    const totalTokens = sumNumbersOrNull(report.llm.map((row) => row.totalTokens))
    for (const row of report.llm) {
      stderr.write(
        `metrics llm provider=${row.provider} model=${row.model} calls=${row.calls} promptTokens=${
          row.promptTokens ?? 'unknown'
        } completionTokens=${row.completionTokens ?? 'unknown'} totalTokens=${
          row.totalTokens ?? 'unknown'
        }\n`
      )
    }
    stderr.write(`metrics firecrawl requests=${report.services.firecrawl.requests}\n`)
    stderr.write(`metrics apify requests=${report.services.apify.requests}\n`)
    stderr.write(
      `metrics total tok(i/o/t)=${promptTokens ?? 'unknown'}/${completionTokens ?? 'unknown'}/${totalTokens ?? 'unknown'}\n`
    )
  }

  if (extractOnly && inputTarget.kind !== 'url') {
    throw new Error('--extract-only is only supported for website/YouTube URLs')
  }

  const progressEnabled = isRichTty(stderr) && !verbose && !json
  let clearProgressBeforeStdout: (() => void) | null = null
  const clearProgressForStdout = () => {
    const fn = clearProgressBeforeStdout
    clearProgressBeforeStdout = null
    fn?.()
  }

  const summarizeAsset = async ({
    sourceKind,
    sourceLabel,
    attachment,
  }: {
    sourceKind: 'file' | 'asset-url'
    sourceLabel: string
    attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
  }) => {
    const parsedModel = parseGatewayStyleModelId(model)
    const apiKeysForLlm = {
      xaiApiKey,
      openaiApiKey: apiKey,
      googleApiKey: googleConfigured ? googleApiKey : null,
      anthropicApiKey: anthropicConfigured ? anthropicApiKey : null,
    }

    const requiredKeyEnv =
      parsedModel.provider === 'xai'
        ? 'XAI_API_KEY'
        : parsedModel.provider === 'google'
          ? 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
          : parsedModel.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
    const hasRequiredKey =
      parsedModel.provider === 'xai'
        ? Boolean(xaiApiKey)
        : parsedModel.provider === 'google'
          ? googleConfigured
          : parsedModel.provider === 'anthropic'
            ? anthropicConfigured
            : Boolean(apiKey)
    if (!hasRequiredKey) {
      throw new Error(
        `Missing ${requiredKeyEnv} for model ${parsedModel.canonical}. Set the env var or choose a different --model.`
      )
    }

    assertProviderSupportsAttachment({
      provider: parsedModel.provider,
      modelId: parsedModel.canonical,
      attachment: { part: attachment.part, mediaType: attachment.mediaType },
    })

    const modelResolution = await resolveModelIdForLlmCall({
      parsedModel,
      apiKeys: { googleApiKey: apiKeysForLlm.googleApiKey },
      fetchImpl: trackedFetch,
      timeoutMs,
    })
    if (modelResolution.note && verbose) {
      writeVerbose(stderr, verbose, modelResolution.note, verboseColor)
    }
    const effectiveModelId = modelResolution.modelId
    const parsedModelEffective = parseGatewayStyleModelId(effectiveModelId)
    const streamingEnabledForCall = streamingEnabled && !modelResolution.forceStreamOff

    const maxOutputTokensForCall = await resolveMaxOutputTokensForCall(
      parsedModelEffective.canonical
    )
    const textContent = getTextContentFromAttachment(attachment)
    if (textContent && textContent.bytes > MAX_TEXT_BYTES_DEFAULT) {
      throw new Error(
        `Text file too large (${formatBytes(textContent.bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
      )
    }
    const summaryLengthTarget =
      lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters }
    const promptText = buildFileSummaryPrompt({
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      summaryLength: summaryLengthTarget,
      contentLength: textContent?.content.length ?? null,
    })

    const promptPayload = buildAssetPromptPayload({ promptText, attachment, textContent })
    const maxInputTokensForCall = await resolveMaxInputTokensForCall(parsedModelEffective.canonical)
    if (
      typeof maxInputTokensForCall === 'number' &&
      Number.isFinite(maxInputTokensForCall) &&
      maxInputTokensForCall > 0 &&
      typeof promptPayload === 'string'
    ) {
      const tokenCount = countTokens(promptPayload)
      if (tokenCount > maxInputTokensForCall) {
        throw new Error(
          `Input token count (${formatCount(tokenCount)}) exceeds model input limit (${formatCount(maxInputTokensForCall)}). Tokenized with GPT tokenizer; prompt included.`
        )
      }
    }

    const shouldBufferSummaryForRender =
      streamingEnabledForCall && effectiveRenderMode === 'md' && isRichTty(stdout)
    const shouldLiveRenderSummary =
      streamingEnabledForCall && effectiveRenderMode === 'md-live' && isRichTty(stdout)
    const shouldStreamSummaryToStdout =
      streamingEnabledForCall && !shouldBufferSummaryForRender && !shouldLiveRenderSummary

    let summaryAlreadyPrinted = false
    let summary = ''
    let getLastStreamError: (() => unknown) | null = null

    if (streamingEnabledForCall) {
      let streamResult: Awaited<ReturnType<typeof streamTextWithModelId>> | null = null
      try {
        streamResult = await streamTextWithModelId({
          modelId: parsedModelEffective.canonical,
          apiKeys: apiKeysForLlm,
          prompt: promptPayload,
          temperature: 0,
          maxOutputTokens: maxOutputTokensForCall ?? undefined,
          timeoutMs,
          fetchImpl: trackedFetch,
        })
      } catch (error) {
        if (isStreamingTimeoutError(error)) {
          writeVerbose(
            stderr,
            verbose,
            `Streaming timed out for ${parsedModelEffective.canonical}; falling back to non-streaming.`,
            verboseColor
          )
          const result = await summarizeWithModelId({
            modelId: parsedModelEffective.canonical,
            prompt: promptPayload,
            maxOutputTokens: maxOutputTokensForCall ?? undefined,
            timeoutMs,
            fetchImpl: trackedFetch,
            apiKeys: apiKeysForLlm,
          })
          llmCalls.push({
            provider: result.provider,
            model: result.canonicalModelId,
            usage: result.usage,
            purpose: 'summary',
          })
          summary = result.text
          streamResult = null
        } else if (
          parsedModelEffective.provider === 'google' &&
          isGoogleStreamingUnsupportedError(error)
        ) {
          writeVerbose(
            stderr,
            verbose,
            `Google model ${parsedModelEffective.canonical} rejected streamGenerateContent; falling back to non-streaming.`,
            verboseColor
          )
          const result = await summarizeWithModelId({
            modelId: parsedModelEffective.canonical,
            prompt: promptPayload,
            maxOutputTokens: maxOutputTokensForCall ?? undefined,
            timeoutMs,
            fetchImpl: trackedFetch,
            apiKeys: apiKeysForLlm,
          })
          llmCalls.push({
            provider: result.provider,
            model: result.canonicalModelId,
            usage: result.usage,
            purpose: 'summary',
          })
          summary = result.text
          streamResult = null
        } else if (isUnsupportedAttachmentError(error)) {
          throw new Error(
            `Model ${parsedModel.canonical} does not support attaching files of type ${attachment.mediaType}. Try a different --model (e.g. google/gemini-3-flash-preview).`,
            { cause: error }
          )
        } else {
          throw error
        }
      }

      if (streamResult) {
        getLastStreamError = streamResult.lastError
        let streamed = ''
        const liveRenderer = shouldLiveRenderSummary
          ? createLiveRenderer({
              write: (chunk) => {
                clearProgressForStdout()
                stdout.write(chunk)
              },
              width: markdownRenderWidth(stdout, env),
              renderFrame: (markdown) =>
                renderMarkdownAnsi(markdown, {
                  width: markdownRenderWidth(stdout, env),
                  wrap: true,
                  color: supportsColor(stdout, env),
                }),
            })
          : null
        let lastFrameAtMs = 0
        try {
          try {
            let cleared = false
            for await (const delta of streamResult.textStream) {
              if (!cleared) {
                clearProgressForStdout()
                cleared = true
              }
              const merged = mergeStreamingChunk(streamed, delta)
              streamed = merged.next
              if (shouldStreamSummaryToStdout) {
                if (merged.appended) stdout.write(merged.appended)
                continue
              }

              if (liveRenderer) {
                const now = Date.now()
                const due = now - lastFrameAtMs >= 120
                const hasNewline = delta.includes('\n')
                if (hasNewline || due) {
                  liveRenderer.render(streamed)
                  lastFrameAtMs = now
                }
              }
            }
          } catch (error) {
            if (isUnsupportedAttachmentError(error)) {
              throw new Error(
                `Model ${parsedModel.canonical} does not support attaching files of type ${attachment.mediaType}. Try a different --model (e.g. google/gemini-3-flash-preview).`,
                { cause: error }
              )
            }
            throw error
          }

          const trimmed = streamed.trim()
          streamed = trimmed
          if (liveRenderer) {
            liveRenderer.render(trimmed)
            summaryAlreadyPrinted = true
          }
        } finally {
          liveRenderer?.finish()
        }

        const usage = await streamResult.usage
        llmCalls.push({
          provider: streamResult.provider,
          model: streamResult.canonicalModelId,
          usage,
          purpose: 'summary',
        })
        summary = streamed

        if (shouldStreamSummaryToStdout) {
          if (!streamed.endsWith('\n')) {
            stdout.write('\n')
          }
          summaryAlreadyPrinted = true
        }
      }
    } else {
      let result: Awaited<ReturnType<typeof summarizeWithModelId>>
      try {
        result = await summarizeWithModelId({
          modelId: parsedModelEffective.canonical,
          prompt: promptPayload,
          maxOutputTokens: maxOutputTokensForCall ?? undefined,
          timeoutMs,
          fetchImpl: trackedFetch,
          apiKeys: apiKeysForLlm,
        })
      } catch (error) {
        if (isUnsupportedAttachmentError(error)) {
          throw new Error(
            `Model ${parsedModel.canonical} does not support attaching files of type ${attachment.mediaType}. Try a different --model (e.g. google/gemini-3-flash-preview).`,
            { cause: error }
          )
        }
        throw error
      }
      llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: 'summary',
      })
      summary = result.text
    }

    summary = summary.trim()
    if (summary.length === 0) {
      const last = getLastStreamError?.()
      if (last instanceof Error) {
        throw new Error(last.message, { cause: last })
      }
      throw new Error('LLM returned an empty summary')
    }

    const extracted = {
      kind: 'asset' as const,
      source: sourceLabel,
      mediaType: attachment.mediaType,
      filename: attachment.filename,
    }

    if (json) {
      clearProgressForStdout()
      const finishReport = shouldComputeReport ? await buildReport() : null
      const input: JsonOutput['input'] =
        sourceKind === 'file'
          ? {
              kind: 'file',
              filePath: sourceLabel,
              timeoutMs,
              length:
                lengthArg.kind === 'preset'
                  ? { kind: 'preset', preset: lengthArg.preset }
                  : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
              maxOutputTokens: maxOutputTokensArg,
              model,
            }
          : {
              kind: 'asset-url',
              url: sourceLabel,
              timeoutMs,
              length:
                lengthArg.kind === 'preset'
                  ? { kind: 'preset', preset: lengthArg.preset }
                  : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
              maxOutputTokens: maxOutputTokensArg,
              model,
            }
      const payload: JsonOutput = {
        input,
        env: {
          hasXaiKey: Boolean(xaiApiKey),
          hasOpenAIKey: Boolean(apiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
          hasGoogleKey: googleConfigured,
          hasAnthropicKey: anthropicConfigured,
        },
        extracted,
        prompt: promptText,
        llm: {
          provider: parsedModelEffective.provider,
          model: parsedModelEffective.canonical,
          maxCompletionTokens: maxOutputTokensForCall,
          strategy: 'single',
        },
        metrics: metricsEnabled ? finishReport : null,
        summary,
      }

      if (metricsDetailed && finishReport) {
        writeMetricsReport(finishReport)
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (metricsEnabled && finishReport) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          model: parsedModelEffective.canonical,
          report: finishReport,
          costUsd,
          color: verboseColor,
        })
      }
      return
    }

    if (!summaryAlreadyPrinted) {
      clearProgressForStdout()
      const rendered =
        (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') && isRichTty(stdout)
          ? renderMarkdownAnsi(summary, {
              width: markdownRenderWidth(stdout, env),
              wrap: true,
              color: supportsColor(stdout, env),
            })
          : summary

      stdout.write(rendered)
      if (!rendered.endsWith('\n')) {
        stdout.write('\n')
      }
    }

    const report = shouldComputeReport ? await buildReport() : null
    if (metricsDetailed && report) writeMetricsReport(report)
    if (metricsEnabled && report) {
      const costUsd = await estimateCostUsd()
      writeFinishLine({
        stderr,
        elapsedMs: Date.now() - runStartedAtMs,
        model: parsedModelEffective.canonical,
        report,
        costUsd,
        color: verboseColor,
      })
    }
  }

  if (inputTarget.kind === 'file') {
    let sizeLabel: string | null = null
    try {
      const stat = await fs.stat(inputTarget.filePath)
      if (stat.isFile()) {
        sizeLabel = formatBytes(stat.size)
      }
    } catch {
      // Ignore size preflight; loadLocalAsset will throw a user-friendly error if needed.
    }

    const stopOscProgress = startOscProgress({
      label: 'Loading file',
      indeterminate: true,
      env,
      isTty: progressEnabled,
      write: (data: string) => stderr.write(data),
    })
    const spinner = startSpinner({
      text: sizeLabel ? `Loading file (${sizeLabel})…` : 'Loading file…',
      enabled: progressEnabled,
      stream: stderr,
    })
    let stopped = false
    const stopProgress = () => {
      if (stopped) return
      stopped = true
      spinner.stopAndClear()
      stopOscProgress()
    }
    clearProgressBeforeStdout = stopProgress
    try {
      const loaded = await loadLocalAsset({ filePath: inputTarget.filePath })
      assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel })
      if (progressEnabled) {
        const mt = loaded.attachment.mediaType
        const name = loaded.attachment.filename
        const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
        spinner.setText(name ? `Summarizing ${name} (${details})…` : `Summarizing ${details}…`)
      }
      await summarizeAsset({
        sourceKind: 'file',
        sourceLabel: loaded.sourceLabel,
        attachment: loaded.attachment,
      })
      return
    } finally {
      if (clearProgressBeforeStdout === stopProgress) {
        clearProgressBeforeStdout = null
      }
      stopProgress()
    }
  }

  if (url && !isYoutubeUrl) {
    const kind = await classifyUrl({ url, fetchImpl: trackedFetch, timeoutMs })
    if (kind.kind === 'asset') {
      const stopOscProgress = startOscProgress({
        label: 'Downloading file',
        indeterminate: true,
        env,
        isTty: progressEnabled,
        write: (data: string) => stderr.write(data),
      })
      const spinner = startSpinner({
        text: 'Downloading file…',
        enabled: progressEnabled,
        stream: stderr,
      })
      let stopped = false
      const stopProgress = () => {
        if (stopped) return
        stopped = true
        spinner.stopAndClear()
        stopOscProgress()
      }
      clearProgressBeforeStdout = stopProgress
      try {
        const loaded = await (async () => {
          try {
            return await loadRemoteAsset({ url, fetchImpl: trackedFetch, timeoutMs })
          } catch (error) {
            if (error instanceof Error && /HTML/i.test(error.message)) {
              return null
            }
            throw error
          }
        })()

        if (!loaded) return
        assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel: null })
        if (progressEnabled) spinner.setText('Summarizing…')
        await summarizeAsset({
          sourceKind: 'asset-url',
          sourceLabel: loaded.sourceLabel,
          attachment: loaded.attachment,
        })
        return
      } finally {
        if (clearProgressBeforeStdout === stopProgress) {
          clearProgressBeforeStdout = null
        }
        stopProgress()
      }
    }
  }

  if (!url) {
    throw new Error('Only HTTP and HTTPS URLs can be summarized')
  }

  const firecrawlMode = requestedFirecrawlMode
  if (firecrawlMode === 'always' && !firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  const effectiveMarkdownMode = markdownMode
  const markdownRequested = extractOnly && !isYoutubeUrl && effectiveMarkdownMode !== 'off'
  const hasKeyForModel =
    parsedModelForLlm.provider === 'xai'
      ? xaiConfigured
      : parsedModelForLlm.provider === 'google'
        ? googleConfigured
        : parsedModelForLlm.provider === 'anthropic'
          ? anthropicConfigured
          : Boolean(apiKey)
  const markdownProvider = hasKeyForModel ? parsedModelForLlm.provider : 'none'

  if (markdownRequested && effectiveMarkdownMode === 'llm' && !hasKeyForModel) {
    const required =
      parsedModelForLlm.provider === 'xai'
        ? 'XAI_API_KEY'
        : parsedModelForLlm.provider === 'google'
          ? 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
          : parsedModelForLlm.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
    throw new Error(`--markdown llm requires ${required} for model ${parsedModelForLlm.canonical}`)
  }

  writeVerbose(
    stderr,
    verbose,
    `config url=${url} timeoutMs=${timeoutMs} youtube=${youtubeMode} firecrawl=${firecrawlMode} length=${
      lengthArg.kind === 'preset' ? lengthArg.preset : `${lengthArg.maxCharacters} chars`
    } maxOutputTokens=${formatOptionalNumber(maxOutputTokensArg)} json=${json} extractOnly=${extractOnly} markdown=${effectiveMarkdownMode} model=${model} stream=${effectiveStreamMode} render=${effectiveRenderMode}`,
    verboseColor
  )
  writeVerbose(
    stderr,
    verbose,
    `configFile path=${formatOptionalString(configPath)} model=${formatOptionalString(
      config?.model ?? null
    )}`,
    verboseColor
  )
  writeVerbose(
    stderr,
    verbose,
    `env xaiKey=${xaiConfigured} openaiKey=${Boolean(apiKey)} googleKey=${googleConfigured} anthropicKey=${anthropicConfigured} apifyToken=${Boolean(apifyToken)} firecrawlKey=${firecrawlConfigured}`,
    verboseColor
  )
  writeVerbose(
    stderr,
    verbose,
    `markdown requested=${markdownRequested} provider=${markdownProvider}`,
    verboseColor
  )

  const scrapeWithFirecrawl =
    firecrawlConfigured && firecrawlMode !== 'off'
      ? createFirecrawlScraper({ apiKey: firecrawlApiKey, fetchImpl: trackedFetch })
      : null

  const convertHtmlToMarkdown =
    markdownRequested && (effectiveMarkdownMode === 'llm' || markdownProvider !== 'none')
      ? createHtmlToMarkdownConverter({
          modelId: model,
          xaiApiKey: xaiConfigured ? xaiApiKey : null,
          googleApiKey: googleConfigured ? googleApiKey : null,
          openaiApiKey: apiKey,
          anthropicApiKey: anthropicConfigured ? anthropicApiKey : null,
          fetchImpl: trackedFetch,
          onUsage: ({ model: usedModel, provider, usage }) => {
            llmCalls.push({ provider, model: usedModel, usage, purpose: 'markdown' })
          },
        })
      : null
  const readTweetWithBirdClient = hasBirdCli(env)
    ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
        readTweetWithBird({ url, timeoutMs, env })
    : null

  writeVerbose(stderr, verbose, 'extract start', verboseColor)
  const stopOscProgress = startOscProgress({
    label: 'Fetching website',
    indeterminate: true,
    env,
    isTty: progressEnabled,
    write: (data: string) => stderr.write(data),
  })
  const spinner = startSpinner({
    text: 'Fetching website (connecting)…',
    enabled: progressEnabled,
    stream: stderr,
  })

  const websiteProgress = (() => {
    if (!progressEnabled) return null

    const state: {
      phase: 'fetching' | 'firecrawl' | 'bird' | 'nitter' | 'idle'
      htmlDownloadedBytes: number
      htmlTotalBytes: number | null
      fetchStartedAtMs: number | null
      lastSpinnerUpdateAtMs: number
    } = {
      phase: 'idle',
      htmlDownloadedBytes: 0,
      htmlTotalBytes: null,
      fetchStartedAtMs: null,
      lastSpinnerUpdateAtMs: 0,
    }

    let ticker: ReturnType<typeof setInterval> | null = null

    const updateSpinner = (text: string, options?: { force?: boolean }) => {
      const now = Date.now()
      if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return
      state.lastSpinnerUpdateAtMs = now
      spinner.setText(text)
    }

    const formatFirecrawlReason = (reason: string) => {
      const lower = reason.toLowerCase()
      if (lower.includes('forced')) return 'forced'
      if (lower.includes('html fetch failed')) return 'fallback: HTML fetch failed'
      if (lower.includes('blocked') || lower.includes('thin')) return 'fallback: blocked/thin HTML'
      return reason
    }

    const renderFetchLine = () => {
      const downloaded = formatBytes(state.htmlDownloadedBytes)
      const total =
        typeof state.htmlTotalBytes === 'number' ? `/${formatBytes(state.htmlTotalBytes)}` : ''
      const elapsedMs =
        typeof state.fetchStartedAtMs === 'number' ? Date.now() - state.fetchStartedAtMs : 0
      const elapsed = formatElapsedMs(elapsedMs)
      if (state.htmlDownloadedBytes === 0 && !state.htmlTotalBytes) {
        return `Fetching website (connecting, ${elapsed})…`
      }
      const rate =
        elapsedMs > 0 && state.htmlDownloadedBytes > 0
          ? `, ${formatBytes(state.htmlDownloadedBytes / (elapsedMs / 1000))}/s`
          : ''
      return `Fetching website (${downloaded}${total}, ${elapsed}${rate})…`
    }

    const startTicker = () => {
      if (ticker) return
      ticker = setInterval(() => {
        if (state.phase !== 'fetching') return
        updateSpinner(renderFetchLine())
      }, 1000)
    }

    const stopTicker = () => {
      if (!ticker) return
      clearInterval(ticker)
      ticker = null
    }

    return {
      getHtmlDownloadedBytes: () => state.htmlDownloadedBytes,
      stop: stopTicker,
      onProgress: (
        event:
          | { kind: 'fetch-html-start'; url: string }
          | {
              kind: 'fetch-html-progress'
              url: string
              downloadedBytes: number
              totalBytes: number | null
            }
          | {
              kind: 'fetch-html-done'
              url: string
              downloadedBytes: number
              totalBytes: number | null
            }
          | { kind: 'firecrawl-start'; url: string; reason: string }
          | {
              kind: 'firecrawl-done'
              url: string
              ok: boolean
              markdownBytes: number | null
              htmlBytes: number | null
            }
          | { kind: 'bird-start'; url: string }
          | { kind: 'bird-done'; url: string; ok: boolean; textBytes: number | null }
          | { kind: 'nitter-start'; url: string }
          | { kind: 'nitter-done'; url: string; ok: boolean; textBytes: number | null }
      ) => {
        if (event.kind === 'fetch-html-start') {
          state.phase = 'fetching'
          state.htmlDownloadedBytes = 0
          state.htmlTotalBytes = null
          state.fetchStartedAtMs = Date.now()
          startTicker()
          updateSpinner('Fetching website (connecting)…')
          return
        }

        if (event.kind === 'fetch-html-progress' || event.kind === 'fetch-html-done') {
          state.phase = 'fetching'
          state.htmlDownloadedBytes = event.downloadedBytes
          state.htmlTotalBytes = event.totalBytes
          updateSpinner(renderFetchLine())
          return
        }

        if (event.kind === 'bird-start') {
          state.phase = 'bird'
          stopTicker()
          updateSpinner('Bird: reading tweet…', { force: true })
          return
        }

        if (event.kind === 'bird-done') {
          state.phase = 'bird'
          stopTicker()
          if (event.ok && typeof event.textBytes === 'number') {
            updateSpinner(`Bird: got ${formatBytes(event.textBytes)}…`, { force: true })
            return
          }
          updateSpinner('Bird: failed; fallback…', { force: true })
          return
        }

        if (event.kind === 'nitter-start') {
          state.phase = 'nitter'
          stopTicker()
          updateSpinner('Nitter: fetching…', { force: true })
          return
        }

        if (event.kind === 'nitter-done') {
          state.phase = 'nitter'
          stopTicker()
          if (event.ok && typeof event.textBytes === 'number') {
            updateSpinner(`Nitter: got ${formatBytes(event.textBytes)}…`, { force: true })
            return
          }
          updateSpinner('Nitter: failed; fallback…', { force: true })
          return
        }

        if (event.kind === 'firecrawl-start') {
          state.phase = 'firecrawl'
          stopTicker()
          const reason = event.reason ? formatFirecrawlReason(event.reason) : ''
          const suffix = reason ? ` (${reason})` : ''
          updateSpinner(`Firecrawl: scraping${suffix}…`, { force: true })
          return
        }

        if (event.kind === 'firecrawl-done') {
          state.phase = 'firecrawl'
          stopTicker()
          if (event.ok && typeof event.markdownBytes === 'number') {
            updateSpinner(`Firecrawl: got ${formatBytes(event.markdownBytes)}…`, { force: true })
            return
          }
          updateSpinner('Firecrawl: no content; fallback…', { force: true })
        }
      },
    }
  })()

  const client = createLinkPreviewClient({
    apifyApiToken: apifyToken,
    ytDlpPath,
    falApiKey,
    scrapeWithFirecrawl,
    convertHtmlToMarkdown,
    readTweetWithBird: readTweetWithBirdClient,
    fetch: trackedFetch,
    onProgress: websiteProgress?.onProgress ?? null,
  })
  let stopped = false
  const stopProgress = () => {
    if (stopped) return
    stopped = true
    websiteProgress?.stop?.()
    spinner.stopAndClear()
    stopOscProgress()
  }
  clearProgressBeforeStdout = stopProgress
  try {
    let extracted: Awaited<ReturnType<typeof client.fetchLinkContent>>
    try {
      extracted = await client.fetchLinkContent(url, {
        timeoutMs,
        youtubeTranscript: youtubeMode,
        firecrawl: firecrawlMode,
        format: markdownRequested ? 'markdown' : 'text',
      })
    } catch (error) {
      throw withBirdTip(error, url, env)
    }
    const extractedContentBytes = Buffer.byteLength(extracted.content, 'utf8')
    const extractedContentSize = formatBytes(extractedContentBytes)
    const viaSources: string[] = []
    if (extracted.diagnostics.strategy === 'bird') {
      viaSources.push('bird')
    }
    if (extracted.diagnostics.strategy === 'nitter') {
      viaSources.push('Nitter')
    }
    if (extracted.diagnostics.firecrawl.used) {
      viaSources.push('Firecrawl')
    }
    const viaSourceLabel = viaSources.length > 0 ? `, ${viaSources.join('+')}` : ''
    if (progressEnabled) {
      websiteProgress?.stop?.()
      spinner.setText(
        extractOnly
          ? `Extracted (${extractedContentSize}${viaSourceLabel})`
          : `Summarizing (sent ${extractedContentSize}${viaSourceLabel})…`
      )
    }
    writeVerbose(
      stderr,
      verbose,
      `extract done strategy=${extracted.diagnostics.strategy} siteName=${formatOptionalString(
        extracted.siteName
      )} title=${formatOptionalString(extracted.title)} transcriptSource=${formatOptionalString(
        extracted.transcriptSource
      )}`,
      verboseColor
    )
    writeVerbose(
      stderr,
      verbose,
      `extract stats characters=${extracted.totalCharacters} words=${extracted.wordCount} transcriptCharacters=${formatOptionalNumber(
        extracted.transcriptCharacters
      )} transcriptLines=${formatOptionalNumber(extracted.transcriptLines)}`,
      verboseColor
    )
    writeVerbose(
      stderr,
      verbose,
      `extract firecrawl attempted=${extracted.diagnostics.firecrawl.attempted} used=${extracted.diagnostics.firecrawl.used} notes=${formatOptionalString(
        extracted.diagnostics.firecrawl.notes ?? null
      )}`,
      verboseColor
    )
    writeVerbose(
      stderr,
      verbose,
      `extract markdown requested=${extracted.diagnostics.markdown.requested} used=${extracted.diagnostics.markdown.used} provider=${formatOptionalString(
        extracted.diagnostics.markdown.provider ?? null
      )} notes=${formatOptionalString(extracted.diagnostics.markdown.notes ?? null)}`,
      verboseColor
    )
    writeVerbose(
      stderr,
      verbose,
      `extract transcript textProvided=${extracted.diagnostics.transcript.textProvided} provider=${formatOptionalString(
        extracted.diagnostics.transcript.provider ?? null
      )} attemptedProviders=${
        extracted.diagnostics.transcript.attemptedProviders.length > 0
          ? extracted.diagnostics.transcript.attemptedProviders.join(',')
          : 'none'
      } notes=${formatOptionalString(extracted.diagnostics.transcript.notes ?? null)}`,
      verboseColor
    )

    const isYouTube = extracted.siteName === 'YouTube'
    const prompt = buildLinkSummaryPrompt({
      url: extracted.url,
      title: extracted.title,
      siteName: extracted.siteName,
      description: extracted.description,
      content: extracted.content,
      truncated: false,
      hasTranscript:
        isYouTube ||
        (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
      summaryLength:
        lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
      shares: [],
    })

    if (extractOnly) {
      clearProgressForStdout()
      if (json) {
        const finishReport = shouldComputeReport ? await buildReport() : null
        const payload: JsonOutput = {
          input: {
            kind: 'url',
            url,
            timeoutMs,
            youtube: youtubeMode,
            firecrawl: firecrawlMode,
            markdown: effectiveMarkdownMode,
            length:
              lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: lengthArg.preset }
                : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
            maxOutputTokens: maxOutputTokensArg,
            model,
          },
          env: {
            hasXaiKey: Boolean(xaiApiKey),
            hasOpenAIKey: Boolean(apiKey),
            hasApifyToken: Boolean(apifyToken),
            hasFirecrawlKey: firecrawlConfigured,
            hasGoogleKey: googleConfigured,
            hasAnthropicKey: anthropicConfigured,
          },
          extracted,
          prompt,
          llm: null,
          metrics: metricsEnabled ? finishReport : null,
          summary: null,
        }
        if (metricsDetailed && finishReport) {
          writeMetricsReport(finishReport)
        }
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        if (metricsEnabled && finishReport) {
          const costUsd = await estimateCostUsd()
          writeFinishLine({
            stderr,
            elapsedMs: Date.now() - runStartedAtMs,
            model,
            report: finishReport,
            costUsd,
            color: verboseColor,
          })
        }
        return
      }

      stdout.write(`${extracted.content}\n`)
      const report = shouldComputeReport ? await buildReport() : null
      if (metricsDetailed && report) writeMetricsReport(report)
      if (metricsEnabled && report) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          model,
          report,
          costUsd,
          color: verboseColor,
        })
      }
      return
    }

    const shouldSkipTweetSummary =
      isTwitterStatusUrl(url) &&
      extracted.content.length > 0 &&
      extracted.content.length <= resolveTargetCharacters(lengthArg)
    if (shouldSkipTweetSummary) {
      clearProgressForStdout()
      writeVerbose(
        stderr,
        verbose,
        `skip summary: tweet content length=${extracted.content.length} target=${resolveTargetCharacters(lengthArg)}`,
        verboseColor
      )
      if (json) {
        const finishReport = shouldComputeReport ? await buildReport() : null
        const payload: JsonOutput = {
          input: {
            kind: 'url',
            url,
            timeoutMs,
            youtube: youtubeMode,
            firecrawl: firecrawlMode,
            markdown: effectiveMarkdownMode,
            length:
              lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: lengthArg.preset }
                : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
            maxOutputTokens: maxOutputTokensArg,
            model,
          },
          env: {
            hasXaiKey: Boolean(xaiApiKey),
            hasOpenAIKey: Boolean(apiKey),
            hasApifyToken: Boolean(apifyToken),
            hasFirecrawlKey: firecrawlConfigured,
            hasGoogleKey: googleConfigured,
            hasAnthropicKey: anthropicConfigured,
          },
          extracted,
          prompt,
          llm: null,
          metrics: metricsEnabled ? finishReport : null,
          summary: extracted.content,
        }
        if (metricsDetailed && finishReport) {
          writeMetricsReport(finishReport)
        }
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        if (metricsEnabled && finishReport) {
          const costUsd = await estimateCostUsd()
          writeFinishLine({
            stderr,
            elapsedMs: Date.now() - runStartedAtMs,
            model,
            report: finishReport,
            costUsd,
            color: verboseColor,
          })
        }
        return
      }

      stdout.write(`${extracted.content}\n`)
      const report = shouldComputeReport ? await buildReport() : null
      if (metricsDetailed && report) writeMetricsReport(report)
      if (metricsEnabled && report) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          model,
          report,
          costUsd,
          color: verboseColor,
        })
      }
      return
    }

    const parsedModel = parseGatewayStyleModelId(model)
    const apiKeysForLlm = {
      xaiApiKey,
      openaiApiKey: apiKey,
      googleApiKey: googleConfigured ? googleApiKey : null,
      anthropicApiKey: anthropicConfigured ? anthropicApiKey : null,
    }

    const requiredKeyEnv =
      parsedModel.provider === 'xai'
        ? 'XAI_API_KEY'
        : parsedModel.provider === 'google'
          ? 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
          : parsedModel.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
    const hasRequiredKey =
      parsedModel.provider === 'xai'
        ? Boolean(xaiApiKey)
        : parsedModel.provider === 'google'
          ? googleConfigured
          : parsedModel.provider === 'anthropic'
            ? anthropicConfigured
            : Boolean(apiKey)
    if (!hasRequiredKey) {
      throw new Error(
        `Missing ${requiredKeyEnv} for model ${parsedModel.canonical}. Set the env var or choose a different --model.`
      )
    }

    const modelResolution = await resolveModelIdForLlmCall({
      parsedModel,
      apiKeys: { googleApiKey: apiKeysForLlm.googleApiKey },
      fetchImpl: trackedFetch,
      timeoutMs,
    })
    if (modelResolution.note && verbose) {
      writeVerbose(stderr, verbose, modelResolution.note, verboseColor)
    }
    const parsedModelEffective = parseGatewayStyleModelId(modelResolution.modelId)
    const streamingEnabledForCall = streamingEnabled && !modelResolution.forceStreamOff

    writeVerbose(
      stderr,
      verbose,
      `mode summarize provider=${parsedModelEffective.provider} model=${parsedModelEffective.canonical}`,
      verboseColor
    )
    const maxOutputTokensForCall = await resolveMaxOutputTokensForCall(
      parsedModelEffective.canonical
    )
    const maxInputTokensForCall = await resolveMaxInputTokensForCall(parsedModelEffective.canonical)
    if (
      typeof maxInputTokensForCall === 'number' &&
      Number.isFinite(maxInputTokensForCall) &&
      maxInputTokensForCall > 0
    ) {
      const tokenCount = countTokens(prompt)
      if (tokenCount > maxInputTokensForCall) {
        throw new Error(
          `Input token count (${formatCount(tokenCount)}) exceeds model input limit (${formatCount(maxInputTokensForCall)}). Tokenized with GPT tokenizer; prompt included.`
        )
      }
    }
    const shouldBufferSummaryForRender =
      streamingEnabledForCall && effectiveRenderMode === 'md' && isRichTty(stdout)
    const shouldLiveRenderSummary =
      streamingEnabledForCall && effectiveRenderMode === 'md-live' && isRichTty(stdout)
    const shouldStreamSummaryToStdout =
      streamingEnabledForCall && !shouldBufferSummaryForRender && !shouldLiveRenderSummary
    let summaryAlreadyPrinted = false

    let summary = ''
    let getLastStreamError: (() => unknown) | null = null
    writeVerbose(stderr, verbose, 'summarize strategy=single', verboseColor)
    if (streamingEnabledForCall) {
      writeVerbose(
        stderr,
        verbose,
        `summarize stream=on buffered=${shouldBufferSummaryForRender}`,
        verboseColor
      )
      let streamResult: Awaited<ReturnType<typeof streamTextWithModelId>> | null = null
      try {
        streamResult = await streamTextWithModelId({
          modelId: parsedModelEffective.canonical,
          apiKeys: apiKeysForLlm,
          prompt,
          temperature: 0,
          maxOutputTokens: maxOutputTokensForCall ?? undefined,
          timeoutMs,
          fetchImpl: trackedFetch,
        })
      } catch (error) {
        if (isStreamingTimeoutError(error)) {
          writeVerbose(
            stderr,
            verbose,
            `Streaming timed out for ${parsedModelEffective.canonical}; falling back to non-streaming.`,
            verboseColor
          )
          const result = await summarizeWithModelId({
            modelId: parsedModelEffective.canonical,
            prompt,
            maxOutputTokens: maxOutputTokensForCall ?? undefined,
            timeoutMs,
            fetchImpl: trackedFetch,
            apiKeys: apiKeysForLlm,
          })
          llmCalls.push({
            provider: result.provider,
            model: result.canonicalModelId,
            usage: result.usage,
            purpose: 'summary',
          })
          summary = result.text
          streamResult = null
        } else if (
          parsedModelEffective.provider === 'google' &&
          isGoogleStreamingUnsupportedError(error)
        ) {
          writeVerbose(
            stderr,
            verbose,
            `Google model ${parsedModelEffective.canonical} rejected streamGenerateContent; falling back to non-streaming.`,
            verboseColor
          )
          const result = await summarizeWithModelId({
            modelId: parsedModelEffective.canonical,
            prompt,
            maxOutputTokens: maxOutputTokensForCall ?? undefined,
            timeoutMs,
            fetchImpl: trackedFetch,
            apiKeys: apiKeysForLlm,
          })
          llmCalls.push({
            provider: result.provider,
            model: result.canonicalModelId,
            usage: result.usage,
            purpose: 'summary',
          })
          summary = result.text
          streamResult = null
        } else {
          throw error
        }
      }

      if (streamResult) {
        getLastStreamError = streamResult.lastError
        let streamed = ''
        const liveRenderer = shouldLiveRenderSummary
          ? createLiveRenderer({
              write: (chunk) => {
                clearProgressForStdout()
                stdout.write(chunk)
              },
              width: markdownRenderWidth(stdout, env),
              renderFrame: (markdown) =>
                renderMarkdownAnsi(markdown, {
                  width: markdownRenderWidth(stdout, env),
                  wrap: true,
                  color: supportsColor(stdout, env),
                }),
            })
          : null
        let lastFrameAtMs = 0
        try {
          let cleared = false
          for await (const delta of streamResult.textStream) {
            const merged = mergeStreamingChunk(streamed, delta)
            streamed = merged.next
            if (shouldStreamSummaryToStdout) {
              if (!cleared) {
                clearProgressForStdout()
                cleared = true
              }
              if (merged.appended) stdout.write(merged.appended)
              continue
            }

            if (liveRenderer) {
              const now = Date.now()
              const due = now - lastFrameAtMs >= 120
              const hasNewline = delta.includes('\n')
              if (hasNewline || due) {
                liveRenderer.render(streamed)
                lastFrameAtMs = now
              }
            }
          }

          const trimmed = streamed.trim()
          streamed = trimmed
          if (liveRenderer) {
            liveRenderer.render(trimmed)
            summaryAlreadyPrinted = true
          }
        } finally {
          liveRenderer?.finish()
        }
        const usage = await streamResult.usage
        llmCalls.push({
          provider: streamResult.provider,
          model: streamResult.canonicalModelId,
          usage,
          purpose: 'summary',
        })
        summary = streamed
        if (shouldStreamSummaryToStdout) {
          if (!streamed.endsWith('\n')) {
            stdout.write('\n')
          }
          summaryAlreadyPrinted = true
        }
      }
    } else {
      const result = await summarizeWithModelId({
        modelId: parsedModelEffective.canonical,
        prompt,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs,
        fetchImpl: trackedFetch,
        apiKeys: apiKeysForLlm,
      })
      llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: 'summary',
      })
      summary = result.text
    }

    summary = summary.trim()
    if (summary.length === 0) {
      const last = getLastStreamError?.()
      if (last instanceof Error) {
        throw new Error(last.message, { cause: last })
      }
      throw new Error('LLM returned an empty summary')
    }

    if (json) {
      const finishReport = shouldComputeReport ? await buildReport() : null
      const payload: JsonOutput = {
        input: {
          kind: 'url',
          url,
          timeoutMs,
          youtube: youtubeMode,
          firecrawl: firecrawlMode,
          markdown: effectiveMarkdownMode,
          length:
            lengthArg.kind === 'preset'
              ? { kind: 'preset', preset: lengthArg.preset }
              : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
          maxOutputTokens: maxOutputTokensArg,
          model,
        },
        env: {
          hasXaiKey: Boolean(xaiApiKey),
          hasOpenAIKey: Boolean(apiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
          hasGoogleKey: googleConfigured,
          hasAnthropicKey: anthropicConfigured,
        },
        extracted,
        prompt,
        llm: {
          provider: parsedModelEffective.provider,
          model: parsedModelEffective.canonical,
          maxCompletionTokens: maxOutputTokensForCall,
          strategy: 'single',
        },
        metrics: metricsEnabled ? finishReport : null,
        summary,
      }

      if (metricsDetailed && finishReport) {
        writeMetricsReport(finishReport)
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (metricsEnabled && finishReport) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          model: parsedModelEffective.canonical,
          report: finishReport,
          costUsd,
          color: verboseColor,
        })
      }
      return
    }

    if (!summaryAlreadyPrinted) {
      clearProgressForStdout()
      const rendered =
        (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') && isRichTty(stdout)
          ? renderMarkdownAnsi(summary, {
              width: markdownRenderWidth(stdout, env),
              wrap: true,
              color: supportsColor(stdout, env),
            })
          : summary

      stdout.write(rendered)
      if (!rendered.endsWith('\n')) {
        stdout.write('\n')
      }
    }

    const report = shouldComputeReport ? await buildReport() : null
    if (metricsDetailed && report) writeMetricsReport(report)
    if (metricsEnabled && report) {
      const costUsd = await estimateCostUsd()
      writeFinishLine({
        stderr,
        elapsedMs: Date.now() - runStartedAtMs,
        model: parsedModelEffective.canonical,
        report,
        costUsd,
        color: verboseColor,
      })
    }
  } finally {
    if (clearProgressBeforeStdout === stopProgress) {
      clearProgressBeforeStdout = null
    }
    stopProgress()
  }
}
