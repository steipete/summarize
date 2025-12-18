import { Command, CommanderError } from 'commander'
import { createLiveRenderer, render as renderMarkdownAnsi } from 'markdansi'
import { loadSummarizeConfig } from './config.js'
import { createLinkPreviewClient } from './content/index.js'
import { buildRunCostReport } from './costs.js'
import type { LlmCall } from './costs.js'
import { createFirecrawlScraper } from './firecrawl.js'
import { loadLiteLlmCatalog, resolveLiteLlmPricingForModelId } from './pricing/litellm.js'
import {
  parseDurationMs,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseRenderMode,
  parseStreamMode,
  parseYoutubeMode,
} from './flags.js'
import { generateTextWithModelId, streamTextWithModelId } from './llm/generate-text.js'
import { createHtmlToMarkdownConverter } from './llm/html-to-markdown.js'
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from './llm/model-id.js'
import {
  buildLinkSummaryPrompt,
  estimateMaxCompletionTokensForCharacters,
  SUMMARY_LENGTH_TO_TOKENS,
} from './prompts/index.js'

type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

type JsonOutput = {
  input: {
    url: string
    timeoutMs: number
    youtube: string
    firecrawl: string
    markdown: string
    length: { kind: 'preset'; preset: string } | { kind: 'chars'; maxCharacters: number }
    model: string
  }
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
    maxCompletionTokens: number
    strategy: 'single' | 'map-reduce'
    chunkCount: number
  } | null
  cost?: ReturnType<typeof buildRunCostReport> | null
  summary: string | null
}

const MAP_REDUCE_TRIGGER_CHARACTERS = 120_000
const MAP_REDUCE_CHUNK_CHARACTERS = 60_000

function buildProgram() {
  return new Command()
    .name('summarize')
    .description('Summarize web pages and YouTube links (uses direct provider API keys).')
    .argument('[url]', 'URL to summarize')
    .option(
      '--youtube <mode>',
      'YouTube transcript source: auto (web then apify), web (youtubei/captionTracks), apify',
      'auto'
    )
    .option(
      '--firecrawl <mode>',
      'Firecrawl usage: off, auto (fallback), always (try Firecrawl first). Note: in --extract-only website mode, defaults to always when FIRECRAWL_API_KEY is set.',
      'auto'
    )
    .option(
      '--markdown <mode>',
      'Website Markdown output: off, auto (prefer Firecrawl, then LLM when configured), llm (force LLM). Only affects --extract-only for non-YouTube URLs.',
      'auto'
    )
    .option(
      '--length <length>',
      'Summary length: short|medium|long|xl|xxl or a character limit like 20000, 20k',
      'medium'
    )
    .option(
      '--timeout <duration>',
      'Timeout for content fetching and LLM request: 30 (seconds), 30s, 2m, 5000ms',
      '2m'
    )
    .option(
      '--config <path>',
      'Optional config file path (JSON). Default: ~/.summarize/config.json'
    )
    .option(
      '--model <model>',
      'LLM model id (gateway-style): xai/..., openai/..., google/... (default: xai/grok-4-fast-non-reasoning)',
      undefined
    )
    .option(
      '--raw',
      'Raw website extraction (disables Firecrawl + LLM Markdown conversion). Shorthand for --firecrawl off --markdown off.',
      false
    )
    .option('--extract-only', 'Print extracted content and exit', false)
    .option('--json', 'Output structured JSON', false)
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
    .option('--cost', 'Print token usage and estimated costs to stderr', false)
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

function terminalWidth(stream: NodeJS.WritableStream, env: Record<string, string | undefined>): number {
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

function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input
  return `\u001b[${code}m${input}\u001b[0m`
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
  ${cmd('summarize "https://example.com" --extract-only')} ${dim('# website markdown (prefers Firecrawl when configured)')}
  ${cmd('summarize "https://example.com" --extract-only --markdown llm')} ${dim('# website markdown via LLM')}
  ${cmd('summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --extract-only --youtube web')}
  ${cmd('summarize "https://example.com" --length 20k --timeout 2m --model openai/gpt-5.2')}
  ${cmd('summarize "https://example.com" --json --verbose')}

${heading('Env Vars')}
  XAI_API_KEY           optional (required for xai/... models)
  OPENAI_API_KEY        optional (required for openai/... models)
  GOOGLE_GENERATIVE_AI_API_KEY optional (required for google/... models)
  ANTHROPIC_API_KEY     optional (required for anthropic/... models)
  SUMMARIZE_MODEL       optional (overrides default model selection)
  SUMMARIZE_CONFIG      optional (path to config.json)
  FIRECRAWL_API_KEY     optional website extraction fallback (Markdown)
  APIFY_API_TOKEN       optional YouTube transcript fallback
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
  prompt: string
  maxOutputTokens: number
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

function splitTextIntoChunks(input: string, maxCharacters: number): string[] {
  if (maxCharacters <= 0) {
    return [input]
  }

  const text = input.trim()
  if (text.length <= maxCharacters) {
    return [text]
  }

  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    const end = Math.min(offset + maxCharacters, text.length)
    const slice = text.slice(offset, end)

    if (end === text.length) {
      chunks.push(slice.trim())
      break
    }

    const candidateBreaks = [
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('. '),
    ]
    const lastBreak = Math.max(...candidateBreaks)
    const splitAt = lastBreak > Math.floor(maxCharacters * 0.5) ? lastBreak + 1 : slice.length
    const chunk = slice.slice(0, splitAt).trim()
    if (chunk.length > 0) {
      chunks.push(chunk)
    }

    offset += splitAt
  }

  return chunks.filter((chunk) => chunk.length > 0)
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

function writeFinishLine({
  stderr,
  elapsedMs,
  model,
  strategy,
  chunkCount,
  report,
}: {
  stderr: NodeJS.WritableStream
  elapsedMs: number
  model: string
  strategy: 'single' | 'map-reduce' | 'none'
  chunkCount: number | null
  report: ReturnType<typeof buildRunCostReport>
}): void {
  const fmtUsd = (value: number | null) =>
    typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unknown'
  const promptTokens = sumNumbersOrNull(report.llm.map((row) => row.promptTokens))
  const completionTokens = sumNumbersOrNull(report.llm.map((row) => row.completionTokens))
  const totalTokens = sumNumbersOrNull(report.llm.map((row) => row.totalTokens))

  const tokPart =
    promptTokens !== null || completionTokens !== null || totalTokens !== null
      ? `tok(i/o/t)=${promptTokens?.toLocaleString() ?? 'unknown'}/${completionTokens?.toLocaleString() ?? 'unknown'}/${totalTokens?.toLocaleString() ?? 'unknown'}`
      : 'tok(i/o/t)=unknown'

  const parts: string[] = [
    model,
    tokPart,
    `firecrawl=${report.services.firecrawl.requests}`,
    `apify=${report.services.apify.requests}`,
    `cost=${fmtUsd(report.totalEstimatedUsd)}`,
  ]

  if (strategy !== 'none') {
    parts.push(`strategy=${strategy}`)
  }
  if (typeof chunkCount === 'number' && Number.isFinite(chunkCount)) {
    parts.push(`chunks=${chunkCount}`)
  }

  stderr.write(`Finished in ${formatElapsedMs(elapsedMs)} (${parts.join(' | ')})\n`)
}

function buildChunkNotesPrompt({ content }: { content: string }): string {
  return `Return 10 bullet points summarizing the content below (Markdown).

CONTENT:
"""
${content}
"""
`
}

export async function runCli(
  argv: string[],
  { env, fetch, stdout, stderr }: RunEnv
): Promise<void> {
  ;(globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

  const normalizedArgv = argv.filter((arg) => arg !== '--')
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

  const rawUrl = program.args[0]
  if (!rawUrl) {
    throw new Error(
      'Usage: summarize <url> [--youtube auto|web|apify] [--length 20k] [--timeout 2m] [--json]'
    )
  }

  const url = (() => {
    const normalized = rawUrl.trim()
    let parsed: URL
    try {
      parsed = new URL(normalized)
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS URLs can be summarized')
    }
    return normalized
  })()

  const runStartedAtMs = Date.now()

  const youtubeMode = parseYoutubeMode(program.opts().youtube as string)
  const lengthArg = parseLengthArg(program.opts().length as string)
  const timeoutMs = parseDurationMs(program.opts().timeout as string)
  const extractOnly = Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const streamMode = parseStreamMode(program.opts().stream as string)
  const renderMode = parseRenderMode(program.opts().render as string)
  const verbose = Boolean(program.opts().verbose)
  const cost = Boolean(program.opts().cost)
  const markdownMode = parseMarkdownMode(program.opts().markdown as string)
  const raw = Boolean(program.opts().raw)

  const isYoutubeUrl = /youtube\.com|youtu\.be/i.test(url)
  const firecrawlExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--firecrawl' || arg.startsWith('--firecrawl=')
  )
  const requestedFirecrawlMode = parseFirecrawlMode(program.opts().firecrawl as string)
  const markdownExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--markdown' || arg.startsWith('--markdown=')
  )

  const modelArg =
    typeof program.opts().model === 'string' ? (program.opts().model as string) : null

  const configPathArg =
    typeof program.opts().config === 'string' ? (program.opts().config as string) : null
  const { config, path: configPath } = loadSummarizeConfig({ env, configPathArg })

  const xaiKeyRaw = typeof env.XAI_API_KEY === 'string' ? env.XAI_API_KEY : null
  const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : null
  const apifyToken = typeof env.APIFY_API_TOKEN === 'string' ? env.APIFY_API_TOKEN : null
  const firecrawlKey = typeof env.FIRECRAWL_API_KEY === 'string' ? env.FIRECRAWL_API_KEY : null
  const anthropicKeyRaw =
    typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : null
  const googleKeyRaw =
    typeof env.GOOGLE_GENERATIVE_AI_API_KEY === 'string'
      ? env.GOOGLE_GENERATIVE_AI_API_KEY
      : typeof env.GEMINI_API_KEY === 'string'
        ? env.GEMINI_API_KEY
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
  const anthropicConfigured =
    typeof anthropicApiKey === 'string' && anthropicApiKey.length > 0

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
  const buildReport = async () => {
    const catalog = await getLiteLlmCatalog()
    return buildRunCostReport({
      llmCalls,
      firecrawlRequests,
      apifyRequests,
      resolveLlmPricing: (modelId) =>
        catalog ? resolveLiteLlmPricingForModelId(catalog, modelId) : null,
    })
  }

  const trackedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
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
    return 'xai/grok-4-fast-non-reasoning'
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
  const writeCostReport = (report: ReturnType<typeof buildRunCostReport>) => {
    const fmtUsd = (value: number | null) =>
      typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : 'unknown'

    for (const row of report.llm) {
      stderr.write(
        `cost llm provider=${row.provider} model=${row.model} calls=${row.calls} promptTokens=${
          row.promptTokens ?? 'unknown'
        } completionTokens=${row.completionTokens ?? 'unknown'} totalTokens=${
          row.totalTokens ?? 'unknown'
        } estimated=${fmtUsd(row.estimatedUsd)}\n`
      )
    }
    stderr.write(
      `cost firecrawl requests=${report.services.firecrawl.requests} estimated=${fmtUsd(
        report.services.firecrawl.estimatedUsd
      )}\n`
    )
    stderr.write(
      `cost apify requests=${report.services.apify.requests} estimated=${fmtUsd(
        report.services.apify.estimatedUsd
      )}\n`
    )
    stderr.write(`cost total estimated=${fmtUsd(report.totalEstimatedUsd)}\n`)
  }

  const firecrawlMode = (() => {
    if (raw) {
      return 'off'
    }
    if (extractOnly && !isYoutubeUrl && !firecrawlExplicitlySet && firecrawlConfigured) {
      return 'always'
    }
    return requestedFirecrawlMode
  })()
  if (firecrawlMode === 'always' && !firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  if (raw && (firecrawlExplicitlySet || markdownExplicitlySet)) {
    throw new Error('--raw cannot be combined with --firecrawl or --markdown')
  }

  const effectiveMarkdownMode = raw ? 'off' : markdownMode
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
          ? 'GOOGLE_GENERATIVE_AI_API_KEY'
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
    } json=${json} extractOnly=${extractOnly} markdown=${effectiveMarkdownMode} model=${model} raw=${raw} stream=${effectiveStreamMode} render=${effectiveRenderMode}`,
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

  const client = createLinkPreviewClient({
    apifyApiToken: apifyToken,
    scrapeWithFirecrawl,
    convertHtmlToMarkdown,
    fetch: trackedFetch,
  })

  writeVerbose(stderr, verbose, 'extract start', verboseColor)
  const extracted = await client.fetchLinkContent(url, {
    timeoutMs,
    youtubeTranscript: youtubeMode,
    firecrawl: firecrawlMode,
    format: markdownRequested ? 'markdown' : 'text',
  })
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
    if (json) {
      const finishReport = await buildReport()
      const costReport = cost || verbose ? finishReport : null
      const payload: JsonOutput = {
        input: {
          url,
          timeoutMs,
          youtube: youtubeMode,
          firecrawl: firecrawlMode,
          markdown: effectiveMarkdownMode,
          length:
            lengthArg.kind === 'preset'
              ? { kind: 'preset', preset: lengthArg.preset }
              : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
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
        cost: costReport,
        summary: null,
      }
      if (costReport) {
        writeCostReport(costReport)
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      writeFinishLine({
        stderr,
        elapsedMs: Date.now() - runStartedAtMs,
        model,
        strategy: 'none',
        chunkCount: null,
        report: finishReport,
      })
      return
    }

    stdout.write(`${extracted.content}\n`)
    const report = await buildReport()
    if (cost || verbose) writeCostReport(report)
    writeFinishLine({
      stderr,
      elapsedMs: Date.now() - runStartedAtMs,
      model,
      strategy: 'none',
      chunkCount: null,
      report,
    })
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
        ? 'GOOGLE_GENERATIVE_AI_API_KEY'
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

  writeVerbose(
    stderr,
    verbose,
    `mode summarize provider=${parsedModel.provider} model=${parsedModel.canonical}`,
    verboseColor
  )
  const maxCompletionTokens =
    lengthArg.kind === 'preset'
      ? SUMMARY_LENGTH_TO_TOKENS[lengthArg.preset]
      : estimateMaxCompletionTokensForCharacters(lengthArg.maxCharacters)

  const isLargeContent = extracted.content.length >= MAP_REDUCE_TRIGGER_CHARACTERS
  let strategy: 'single' | 'map-reduce' = 'single'
  let chunkCount = 1
  const shouldBufferSummaryForRender =
    streamingEnabled && effectiveRenderMode === 'md' && isRichTty(stdout)
  const shouldLiveRenderSummary =
    streamingEnabled && effectiveRenderMode === 'md-live' && isRichTty(stdout)
  const shouldStreamSummaryToStdout =
    streamingEnabled && !shouldBufferSummaryForRender && !shouldLiveRenderSummary
  let summaryAlreadyPrinted = false

  let summary: string
  if (!isLargeContent) {
    writeVerbose(stderr, verbose, 'summarize strategy=single', verboseColor)
    if (streamingEnabled) {
      writeVerbose(
        stderr,
        verbose,
        `summarize stream=on buffered=${shouldBufferSummaryForRender}`,
        verboseColor
      )
      const streamResult = await streamTextWithModelId({
        modelId: parsedModel.canonical,
        apiKeys: apiKeysForLlm,
        prompt,
        temperature: 0,
        maxOutputTokens: maxCompletionTokens,
        timeoutMs,
        fetchImpl: trackedFetch,
      })
      let streamed = ''
      const liveRenderer = shouldLiveRenderSummary
        ? createLiveRenderer({
            write: (chunk) => stdout.write(chunk),
            renderFrame: (markdown) =>
              renderMarkdownAnsi(markdown, {
                width: terminalWidth(stdout, env),
                wrap: true,
                color: supportsColor(stdout, env),
              }),
          })
        : null
      let lastFrameAtMs = 0
      try {
        for await (const delta of streamResult.textStream) {
          streamed += delta
          if (shouldStreamSummaryToStdout) {
            stdout.write(delta)
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
    } else {
      const result = await summarizeWithModelId({
        modelId: parsedModel.canonical,
        prompt,
        maxOutputTokens: maxCompletionTokens,
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
  } else {
    strategy = 'map-reduce'
    const chunks = splitTextIntoChunks(extracted.content, MAP_REDUCE_CHUNK_CHARACTERS)
    chunkCount = chunks.length

    stderr.write(
      `Large input (${extracted.content.length} chars); summarizing in ${chunks.length} chunks.\n`
    )
    writeVerbose(
      stderr,
      verbose,
      `summarize strategy=map-reduce chunks=${chunks.length}`,
      verboseColor
    )

    const chunkNotes: string[] = []
    for (let i = 0; i < chunks.length; i += 1) {
      writeVerbose(
        stderr,
        verbose,
        `summarize chunk ${i + 1}/${chunks.length} notes start`,
        verboseColor
      )
      const chunkPrompt = buildChunkNotesPrompt({
        content: chunks[i] ?? '',
      })

      const notesResult = await summarizeWithModelId({
        modelId: parsedModel.canonical,
        prompt: chunkPrompt,
        maxOutputTokens: SUMMARY_LENGTH_TO_TOKENS.medium,
        timeoutMs,
        fetchImpl: trackedFetch,
        apiKeys: apiKeysForLlm,
      })
      const notes = notesResult.text

      llmCalls.push({
        provider: notesResult.provider,
        model: notesResult.canonicalModelId,
        usage: notesResult.usage,
        purpose: 'chunk-notes',
      })

      chunkNotes.push(notes.trim())
    }

    writeVerbose(stderr, verbose, 'summarize merge chunk notes', verboseColor)
    const mergedContent = `Chunk notes (generated from the full input):\n\n${chunkNotes
      .filter((value) => value.length > 0)
      .join('\n\n')}`

    const mergedPrompt = buildLinkSummaryPrompt({
      url: extracted.url,
      title: extracted.title,
      siteName: extracted.siteName,
      description: extracted.description,
      content: mergedContent,
      truncated: false,
      hasTranscript:
        isYouTube ||
        (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
      summaryLength:
        lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
      shares: [],
    })

    if (streamingEnabled) {
      writeVerbose(
        stderr,
        verbose,
        `summarize stream=on buffered=${shouldBufferSummaryForRender}`,
        verboseColor
      )
      const streamResult = await streamTextWithModelId({
        modelId: parsedModel.canonical,
        apiKeys: apiKeysForLlm,
        prompt: mergedPrompt,
        temperature: 0,
        maxOutputTokens: maxCompletionTokens,
        timeoutMs,
        fetchImpl: trackedFetch,
      })
      let streamed = ''
      const liveRenderer = shouldLiveRenderSummary
        ? createLiveRenderer({
            write: (chunk) => stdout.write(chunk),
            renderFrame: (markdown) =>
              renderMarkdownAnsi(markdown, {
                width: terminalWidth(stdout, env),
                wrap: true,
                color: supportsColor(stdout, env),
              }),
          })
        : null
      let lastFrameAtMs = 0
      try {
        for await (const delta of streamResult.textStream) {
          streamed += delta
          if (shouldStreamSummaryToStdout) {
            stdout.write(delta)
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
    } else {
      const mergedResult = await summarizeWithModelId({
        modelId: parsedModel.canonical,
        prompt: mergedPrompt,
        maxOutputTokens: maxCompletionTokens,
        timeoutMs,
        fetchImpl: trackedFetch,
        apiKeys: apiKeysForLlm,
      })
      llmCalls.push({
        provider: mergedResult.provider,
        model: mergedResult.canonicalModelId,
        usage: mergedResult.usage,
        purpose: 'summary',
      })
      summary = mergedResult.text
    }
  }

  summary = summary.trim()
  if (summary.length === 0) {
    throw new Error('LLM returned an empty summary')
  }

  if (json) {
    const finishReport = await buildReport()
    const costReport = cost || verbose ? finishReport : null
    const payload: JsonOutput = {
      input: {
        url,
        timeoutMs,
        youtube: youtubeMode,
        firecrawl: firecrawlMode,
        markdown: effectiveMarkdownMode,
        length:
          lengthArg.kind === 'preset'
            ? { kind: 'preset', preset: lengthArg.preset }
            : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
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
        provider: parsedModel.provider,
        model: parsedModel.canonical,
        maxCompletionTokens,
        strategy,
        chunkCount,
      },
      cost: costReport,
      summary,
    }

    if (costReport) {
      writeCostReport(costReport)
    }
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    writeFinishLine({
      stderr,
      elapsedMs: Date.now() - runStartedAtMs,
      model: parsedModel.canonical,
      strategy,
      chunkCount,
      report: finishReport,
    })
    return
  }

  if (!summaryAlreadyPrinted) {
    const rendered =
      (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') && isRichTty(stdout)
        ? renderMarkdownAnsi(summary, {
            width: terminalWidth(stdout, env),
            wrap: true,
            color: supportsColor(stdout, env),
          })
        : summary

    stdout.write(rendered)
    if (!rendered.endsWith('\n')) {
      stdout.write('\n')
    }
  }

  const report = await buildReport()
  if (cost || verbose) writeCostReport(report)
  writeFinishLine({
    stderr,
    elapsedMs: Date.now() - runStartedAtMs,
    model: parsedModel.canonical,
    strategy,
    chunkCount,
    report,
  })
}
