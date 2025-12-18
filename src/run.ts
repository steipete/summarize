import { Command, CommanderError } from 'commander'
import { loadSummarizeConfig } from './config.js'
import { createLinkPreviewClient } from './content/index.js'
import { createFirecrawlScraper } from './firecrawl.js'
import {
  parseDurationMs,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseYoutubeMode,
} from './flags.js'
import { generateTextWithModelId } from './llm/generate-text.js'
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
  }
  extracted: unknown
  prompt: string
  llm: {
    provider: 'xai' | 'openai' | 'google' | 'prompt-only'
    model: string
    maxCompletionTokens: number
    strategy: 'single' | 'map-reduce'
    chunkCount: number
  } | null
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
      'Optional config file path (JSON). Default: ~/.config/summarize/config.json'
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
    .option('--prompt', 'Print the prompt and exit', false)
    .option('--extract-only', 'Print extracted content and exit', false)
    .option('--json', 'Output structured JSON', false)
    .option('--verbose', 'Print detailed progress info to stderr', false)
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
  apiKeys: { xaiApiKey: string | null; openaiApiKey: string | null; googleApiKey: string | null }
}): Promise<{ text: string; provider: 'xai' | 'openai' | 'google'; canonicalModelId: string }> {
  const result = await generateTextWithModelId({
    modelId,
    apiKeys,
    prompt,
    temperature: 0,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
  })
  return { text: result.text, provider: result.provider, canonicalModelId: result.canonicalModelId }
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

  const url = program.args[0]
  if (!url) {
    throw new Error(
      'Usage: summarize <url> [--youtube auto|web|apify] [--length 20k] [--timeout 2m] [--json]'
    )
  }

  const youtubeMode = parseYoutubeMode(program.opts().youtube as string)
  const lengthArg = parseLengthArg(program.opts().length as string)
  const timeoutMs = parseDurationMs(program.opts().timeout as string)
  const printPrompt = Boolean(program.opts().prompt)
  const extractOnly = Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const verbose = Boolean(program.opts().verbose)
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

  if (printPrompt && extractOnly) {
    throw new Error('--prompt and --extract-only are mutually exclusive')
  }

  const modelArg =
    typeof program.opts().model === 'string' ? (program.opts().model as string) : null

  const configPathArg =
    typeof program.opts().config === 'string' ? (program.opts().config as string) : null
  const { config, path: configPath } = loadSummarizeConfig({ env, configPathArg })

  const xaiKeyRaw = typeof env.XAI_API_KEY === 'string' ? env.XAI_API_KEY : null
  const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : null
  const apifyToken = typeof env.APIFY_API_TOKEN === 'string' ? env.APIFY_API_TOKEN : null
  const firecrawlKey = typeof env.FIRECRAWL_API_KEY === 'string' ? env.FIRECRAWL_API_KEY : null
  const googleKeyRaw =
    typeof env.GOOGLE_GENERATIVE_AI_API_KEY === 'string' ? env.GOOGLE_GENERATIVE_AI_API_KEY : null

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null
  const firecrawlConfigured = firecrawlApiKey !== null
  const xaiApiKey = xaiKeyRaw?.trim() ?? null
  const googleApiKey = googleKeyRaw?.trim() ?? null
  const googleConfigured = typeof googleApiKey === 'string' && googleApiKey.length > 0
  const xaiConfigured = typeof xaiApiKey === 'string' && xaiApiKey.length > 0

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
        : Boolean(apiKey)
  const markdownProvider = hasKeyForModel ? parsedModelForLlm.provider : 'none'

  if (markdownRequested && effectiveMarkdownMode === 'llm' && !hasKeyForModel) {
    const required =
      parsedModelForLlm.provider === 'xai'
        ? 'XAI_API_KEY'
        : parsedModelForLlm.provider === 'google'
          ? 'GOOGLE_GENERATIVE_AI_API_KEY'
          : 'OPENAI_API_KEY'
    throw new Error(`--markdown llm requires ${required} for model ${parsedModelForLlm.canonical}`)
  }

  writeVerbose(
    stderr,
    verbose,
    `config url=${url} timeoutMs=${timeoutMs} youtube=${youtubeMode} firecrawl=${firecrawlMode} length=${
      lengthArg.kind === 'preset' ? lengthArg.preset : `${lengthArg.maxCharacters} chars`
    } json=${json} extractOnly=${extractOnly} prompt=${printPrompt} markdown=${effectiveMarkdownMode} model=${model} raw=${raw}`,
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
    `env xaiKey=${xaiConfigured} openaiKey=${Boolean(apiKey)} googleKey=${googleConfigured} apifyToken=${Boolean(apifyToken)} firecrawlKey=${firecrawlConfigured}`,
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
      ? createFirecrawlScraper({ apiKey: firecrawlApiKey, fetchImpl: fetch })
      : null

  const convertHtmlToMarkdown =
    markdownRequested && (effectiveMarkdownMode === 'llm' || markdownProvider !== 'none')
      ? createHtmlToMarkdownConverter({
          modelId: model,
          xaiApiKey: xaiConfigured ? xaiApiKey : null,
          googleApiKey: googleConfigured ? googleApiKey : null,
          openaiApiKey: apiKey,
          fetchImpl: fetch,
        })
      : null

  const client = createLinkPreviewClient({
    apifyApiToken: apifyToken,
    scrapeWithFirecrawl,
    convertHtmlToMarkdown,
    fetch,
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
        },
        extracted,
        prompt,
        llm: null,
        summary: null,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }

    stdout.write(`${extracted.content}\n`)
    return
  }

  if (printPrompt) {
    writeVerbose(stderr, verbose, 'mode prompt-only', verboseColor)

    if (json) {
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
        },
        extracted,
        prompt,
        llm: null,
        summary: null,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }

    stdout.write(`${prompt}\n`)
    return
  }

  const parsedModel = parseGatewayStyleModelId(model)
  const apiKeysForLlm = {
    xaiApiKey,
    openaiApiKey: apiKey,
    googleApiKey: googleConfigured ? googleApiKey : null,
  }

  const requiredKeyEnv =
    parsedModel.provider === 'xai'
      ? 'XAI_API_KEY'
      : parsedModel.provider === 'google'
        ? 'GOOGLE_GENERATIVE_AI_API_KEY'
        : 'OPENAI_API_KEY'
  const hasRequiredKey =
    parsedModel.provider === 'xai'
      ? Boolean(xaiApiKey)
      : parsedModel.provider === 'google'
        ? googleConfigured
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

  let summary: string
  if (!isLargeContent) {
    writeVerbose(stderr, verbose, 'summarize strategy=single', verboseColor)
    const result = await summarizeWithModelId({
      modelId: parsedModel.canonical,
      prompt,
      maxOutputTokens: maxCompletionTokens,
      timeoutMs,
      fetchImpl: fetch,
      apiKeys: apiKeysForLlm,
    })
    summary = result.text
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
        fetchImpl: fetch,
        apiKeys: apiKeysForLlm,
      })
      const notes = notesResult.text

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

    const mergedResult = await summarizeWithModelId({
      modelId: parsedModel.canonical,
      prompt: mergedPrompt,
      maxOutputTokens: maxCompletionTokens,
      timeoutMs,
      fetchImpl: fetch,
      apiKeys: apiKeysForLlm,
    })
    summary = mergedResult.text
  }

  summary = summary.trim()
  if (summary.length === 0) {
    throw new Error('LLM returned an empty summary')
  }

  if (json) {
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
      summary,
    }

    stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  stdout.write(`${summary}\n`)
}
