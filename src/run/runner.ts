import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { CommanderError } from 'commander'
import { countTokens } from 'gpt-tokenizer'
import { createLiveRenderer, render as renderMarkdownAnsi } from 'markdansi'
import { normalizeTokenUsage, tallyCosts } from 'tokentally'
import { loadSummarizeConfig, type CliProvider, type ModelConfig } from '../config.js'
import {
  classifyUrl,
  loadLocalAsset,
  loadRemoteAsset,
  resolveInputTarget,
} from '../content/asset.js'
import { createLinkPreviewClient } from '../content/index.js'
import type { LlmCall } from '../costs.js'
import { buildRunMetricsReport } from '../costs.js'
import { createFirecrawlScraper } from '../firecrawl.js'
import {
  parseDurationMs,
  parseExtractFormat,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parsePreprocessMode,
  parseRenderMode,
  parseRetriesArg,
  parseStreamMode,
  parseVideoMode,
  parseYoutubeMode,
} from '../flags.js'
import {
  formatOutputLanguageForJson,
  type OutputLanguage,
  parseOutputLanguage,
} from '../language.js'
import { isCliDisabled, runCliModel } from '../llm/cli.js'
import { generateTextWithModelId, streamTextWithModelId } from '../llm/generate-text.js'
import { resolveGoogleModelForUsage } from '../llm/google-models.js'
import { createHtmlToMarkdownConverter } from '../llm/html-to-markdown.js'
import { parseGatewayStyleModelId } from '../llm/model-id.js'
import { convertToMarkdownWithMarkitdown, type ExecFileFn } from '../markitdown.js'
import { buildAutoModelAttempts } from '../model-auto.js'
import { type FixedModelSpec, parseRequestedModelId, type RequestedModel } from '../model-spec.js'
import {
  loadLiteLlmCatalog,
  resolveLiteLlmMaxInputTokensForModelId,
  resolveLiteLlmMaxOutputTokensForModelId,
  resolveLiteLlmPricingForModelId,
} from '../pricing/litellm.js'
import {
  buildFileSummaryPrompt,
  buildFileTextSummaryPrompt,
  buildLinkSummaryPrompt,
  buildPathSummaryPrompt,
} from '../prompts/index.js'
import { refreshFree } from '../refresh-free.js'
import { formatBytes, formatCompactCount } from '../tty/format.js'
import { createOscProgressController, startOscProgress } from '../tty/osc-progress.js'
import { startSpinner } from '../tty/spinner.js'
import { createWebsiteProgress } from '../tty/website-progress.js'
import { formatVersionLine } from '../version.js'
import { readTweetWithBird, withBirdTip } from './bird.js'
import {
  assertAssetMediaTypeSupported,
  assertProviderSupportsAttachment,
  buildAssetPromptPayload,
  ensureCliAttachmentPath,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  isTextLikeMediaType,
  isUnsupportedAttachmentError,
  shouldMarkitdownConvertMediaType,
} from './attachments.js'
import { BUILTIN_MODELS, MAX_TEXT_BYTES_DEFAULT, SUMMARY_LENGTH_MAX_CHARACTERS, UVX_TIP } from './constants.js'
import {
  hasBirdCli,
  hasUvxCli,
  parseBooleanEnv,
  parseCliProviderArg,
  parseCliUserModelId,
  resolveCliAvailability,
  resolveExecutableInPath,
} from './env.js'
import {
  buildExtractFinishLabel,
  buildLengthPartsForFinishLine,
  buildSummaryFinishLabel,
  writeFinishLine,
} from './finish-line.js'
import {
  estimateWhisperTranscriptionCostUsd,
  formatOptionalNumber,
  formatOptionalString,
  formatUSD,
  resolveTargetCharacters,
} from './format.js'
import { attachRichHelp, buildConciseHelp, buildProgram, buildRefreshFreeHelp } from './help.js'
import { createRetryLogger, writeVerbose } from './logging.js'
import { prepareMarkdownForTerminal } from './markdown.js'
import { runModelAttempts } from './model-attempts.js'
import { buildOpenRouterNoAllowedProvidersMessage } from './openrouter.js'
import { mergeStreamingChunk, isGoogleStreamingUnsupportedError, isStreamingTimeoutError } from './streaming.js'
import { ansi, isRichTty, markdownRenderWidth, supportsColor, terminalHeight } from './terminal.js'
import { withUvxTip } from './tips.js'
import type { MarkdownModel, ModelAttempt, ModelMeta } from './types.js'

type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  execFile?: ExecFileFn
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

type JsonOutput = {
  input: {
    timeoutMs: number
    length: { kind: 'preset'; preset: string } | { kind: 'chars'; maxCharacters: number }
    maxOutputTokens: number | null
    model: string
    language: ReturnType<typeof formatOutputLanguageForJson>
  } & (
    | {
        kind: 'url'
        url: string
        youtube: string
        firecrawl: string
        format: string
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
    hasOpenRouterKey: boolean
    hasApifyToken: boolean
    hasFirecrawlKey: boolean
    hasGoogleKey: boolean
    hasAnthropicKey: boolean
  }
  extracted: unknown
  prompt: string
  llm: {
    provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai' | 'cli'
    model: string
    maxCompletionTokens: number | null
    strategy: 'single'
  } | null
  metrics: ReturnType<typeof buildRunMetricsReport> | null
  summary: string | null
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

async function summarizeWithModelId({
  modelId,
  prompt,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
  retries,
  onRetry,
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
    openrouterApiKey: string | null
  }
  forceOpenRouter?: boolean
  openaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
  retries: number
  onRetry?: (notice: {
    attempt: number
    maxRetries: number
    delayMs: number
    error: unknown
  }) => void
}): Promise<{
  text: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  canonicalModelId: string
  usage: Awaited<ReturnType<typeof generateTextWithModelId>>['usage']
}> {
  const result = await generateTextWithModelId({
    modelId,
    apiKeys,
    forceOpenRouter,
    openaiBaseUrlOverride,
    forceChatCompletions,
    prompt,
    temperature: 0,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
    retries,
    onRetry,
  })
  return {
    text: result.text,
    provider: result.provider,
    canonicalModelId: result.canonicalModelId,
    usage: result.usage,
  }
}

export async function runCli(
  argv: string[],
  { env, fetch, execFile: execFileOverride, stdout, stderr }: RunEnv
): Promise<void> {
  ;(globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

  const normalizedArgv = argv.filter((arg) => arg !== '--')
  const noColorFlag = normalizedArgv.includes('--no-color')
  const envForRun = noColorFlag ? { ...env, NO_COLOR: '1' } : env

  if (normalizedArgv[0]?.toLowerCase() === 'help') {
    const topic = normalizedArgv[1]?.toLowerCase()
    if (topic === 'refresh-free') {
      stdout.write(`${buildRefreshFreeHelp()}
`)
      return
    }

    const program = buildProgram()
    program.configureOutput({
      writeOut(str) {
        stdout.write(str)
      },
      writeErr(str) {
        stderr.write(str)
      },
    })
    attachRichHelp(program, envForRun, stdout)
    program.outputHelp()
    return
  }
  if (normalizedArgv[0]?.toLowerCase() === 'refresh-free') {
    const verbose = normalizedArgv.includes('--verbose') || normalizedArgv.includes('--debug')
    const setDefault = normalizedArgv.includes('--set-default')
    const help =
      normalizedArgv.includes('--help') ||
      normalizedArgv.includes('-h') ||
      normalizedArgv.includes('help')

    const readArgValue = (name: string): string | null => {
      const eq = normalizedArgv.find((a) => a.startsWith(`${name}=`))
      if (eq) return eq.slice(`${name}=`.length).trim() || null
      const index = normalizedArgv.indexOf(name)
      if (index === -1) return null
      const next = normalizedArgv[index + 1]
      if (!next || next.startsWith('-')) return null
      return next.trim() || null
    }

    const runsRaw = readArgValue('--runs')
    const smartRaw = readArgValue('--smart')
    const minParamsRaw = readArgValue('--min-params')
    const maxAgeDaysRaw = readArgValue('--max-age-days')
    const runs = runsRaw ? Number(runsRaw) : 2
    const smart = smartRaw ? Number(smartRaw) : 3
    const minParams = (() => {
      if (!minParamsRaw) return 27
      const raw = minParamsRaw.trim().toLowerCase()
      const normalized = raw.endsWith('b') ? raw.slice(0, -1).trim() : raw
      const value = Number(normalized)
      return value
    })()
    const maxAgeDays = (() => {
      if (!maxAgeDaysRaw) return 180
      const value = Number(maxAgeDaysRaw.trim())
      return value
    })()

    if (help) {
      stdout.write(`${buildRefreshFreeHelp()}\n`)
      return
    }

    if (!Number.isFinite(runs) || runs < 0) throw new Error('--runs must be >= 0')
    if (!Number.isFinite(smart) || smart < 0) throw new Error('--smart must be >= 0')
    if (!Number.isFinite(minParams) || minParams < 0)
      throw new Error('--min-params must be >= 0 (e.g. 27b)')
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)
      throw new Error('--max-age-days must be >= 0')

    await refreshFree({
      env: envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
      verbose,
      options: {
        runs,
        smart,
        minParamB: minParams,
        maxAgeDays,
        setDefault,
        maxCandidates: 10,
        concurrency: 4,
        timeoutMs: 10_000,
      },
    })
    return
  }
  const execFileImpl = execFileOverride ?? execFile
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
  attachRichHelp(program, envForRun, stdout)

  try {
    program.parse(normalizedArgv, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return
    }
    throw error
  }

  if (program.opts().version) {
    stdout.write(`${formatVersionLine()}\n`)
    return
  }

  const cliFlagPresent = normalizedArgv.some((arg) => arg === '--cli' || arg.startsWith('--cli='))
  let cliProviderArgRaw = typeof program.opts().cli === 'string' ? program.opts().cli : null
  let rawInput = program.args[0]
  if (!rawInput && cliFlagPresent && cliProviderArgRaw) {
    try {
      resolveInputTarget(cliProviderArgRaw)
      rawInput = cliProviderArgRaw
      cliProviderArgRaw = null
    } catch {
      // keep rawInput as-is
    }
  }
  if (!rawInput) {
    const help = buildConciseHelp()
    stdout.write(`${help}\n`)
    throw new Error(help)
  }

  const inputTarget = resolveInputTarget(rawInput)
  const url = inputTarget.kind === 'url' ? inputTarget.url : null

  const runStartedAtMs = Date.now()

  const youtubeMode = parseYoutubeMode(program.opts().youtube as string)
  const videoModeExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--video-mode' || arg.startsWith('--video-mode=')
  )
  const lengthExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--length' || arg.startsWith('--length=')
  )
  const lengthArg = parseLengthArg(program.opts().length as string)
  const maxOutputTokensArg = parseMaxOutputTokensArg(
    program.opts().maxOutputTokens as string | undefined
  )
  const timeoutMs = parseDurationMs(program.opts().timeout as string)
  const languageExplicitlySet = normalizedArgv.some(
    (arg) =>
      arg === '--language' ||
      arg.startsWith('--language=') ||
      arg === '--lang' ||
      arg.startsWith('--lang=')
  )
  const retries = parseRetriesArg(program.opts().retries as string)
  const extractMode = Boolean(program.opts().extract) || Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const streamMode = parseStreamMode(program.opts().stream as string)
  const renderMode = parseRenderMode(program.opts().render as string)
  const debug = Boolean(program.opts().debug)
  const verbose = Boolean(program.opts().verbose) || debug

  if (extractMode && lengthExplicitlySet && !json && isRichTty(stderr)) {
    stderr.write('Warning: --length is ignored with --extract (no summary is generated).\n')
  }

  const metricsExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--metrics' || arg.startsWith('--metrics=')
  )
  const metricsMode = parseMetricsMode(
    debug && !metricsExplicitlySet ? 'detailed' : (program.opts().metrics as string)
  )
  const metricsEnabled = metricsMode !== 'off'
  const metricsDetailed = metricsMode === 'detailed'
  const preprocessMode = parsePreprocessMode(program.opts().preprocess as string)
  const shouldComputeReport = metricsEnabled

  const isYoutubeUrl = typeof url === 'string' ? /youtube\.com|youtu\.be/i.test(url) : false
  const formatExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--format' || arg.startsWith('--format=')
  )
  const rawFormatOpt =
    typeof program.opts().format === 'string' ? (program.opts().format as string) : null
  const format = parseExtractFormat(
    formatExplicitlySet
      ? (rawFormatOpt ?? 'text')
      : extractMode && inputTarget.kind === 'url' && !isYoutubeUrl
        ? 'md'
        : 'text'
  )
  const _firecrawlExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--firecrawl' || arg.startsWith('--firecrawl=')
  )
  const markdownModeExplicitlySet = normalizedArgv.some(
    (arg) =>
      arg === '--markdown-mode' ||
      arg.startsWith('--markdown-mode=') ||
      arg === '--markdown' ||
      arg.startsWith('--markdown=')
  )
  const markdownMode =
    format === 'markdown'
      ? parseMarkdownMode(
          (program.opts().markdownMode as string | undefined) ??
            (program.opts().markdown as string | undefined) ??
            'readability'
        )
      : 'off'
  const requestedFirecrawlMode = parseFirecrawlMode(program.opts().firecrawl as string)
  const modelArg =
    typeof program.opts().model === 'string' ? (program.opts().model as string) : null
  const cliProviderArg =
    typeof cliProviderArgRaw === 'string' && cliProviderArgRaw.trim().length > 0
      ? parseCliProviderArg(cliProviderArgRaw)
      : null
  if (cliFlagPresent && modelArg) {
    throw new Error('Use either --model or --cli (not both).')
  }
  const explicitModelArg = cliProviderArg
    ? `cli/${cliProviderArg}`
    : cliFlagPresent
      ? 'auto'
      : modelArg

  const { config, path: configPath } = loadSummarizeConfig({ env: envForRun })
  const cliLanguageRaw =
    typeof (program.opts() as { language?: unknown; lang?: unknown }).language === 'string'
      ? ((program.opts() as { language?: string }).language as string)
      : typeof (program.opts() as { lang?: unknown }).lang === 'string'
        ? ((program.opts() as { lang?: string }).lang as string)
        : null
  const defaultLanguageRaw = (config?.output?.language ?? config?.language ?? 'auto') as string
  const outputLanguage: OutputLanguage = parseOutputLanguage(
    languageExplicitlySet && typeof cliLanguageRaw === 'string' && cliLanguageRaw.trim().length > 0
      ? cliLanguageRaw
      : defaultLanguageRaw
  )
  const openaiWhisperUsdPerMinute = (() => {
    const value = config?.openai?.whisperUsdPerMinute
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0.006
  })()
  const videoMode = parseVideoMode(
    videoModeExplicitlySet
      ? (program.opts().videoMode as string)
      : (config?.media?.videoMode ?? (program.opts().videoMode as string))
  )

  const cliEnabledOverride: CliProvider[] | null = (() => {
    if (!cliFlagPresent || cliProviderArg) return null
    if (Array.isArray(config?.cli?.enabled)) return config.cli.enabled
    return ['gemini', 'claude', 'codex']
  })()
  const cliConfigForRun = cliEnabledOverride
    ? { ...(config?.cli ?? {}), enabled: cliEnabledOverride }
    : config?.cli
  const configForCli: typeof config =
    cliEnabledOverride !== null
      ? { ...(config ?? {}), ...(cliConfigForRun ? { cli: cliConfigForRun } : {}) }
      : config

  const openaiUseChatCompletions = (() => {
    const envValue = parseBooleanEnv(
      typeof envForRun.OPENAI_USE_CHAT_COMPLETIONS === 'string'
        ? envForRun.OPENAI_USE_CHAT_COMPLETIONS
        : null
    )
    if (envValue !== null) return envValue
    const configValue = config?.openai?.useChatCompletions
    return typeof configValue === 'boolean' ? configValue : false
  })()

  const xaiKeyRaw = typeof envForRun.XAI_API_KEY === 'string' ? envForRun.XAI_API_KEY : null
  const openaiBaseUrl =
    typeof envForRun.OPENAI_BASE_URL === 'string' ? envForRun.OPENAI_BASE_URL : null
  const zaiKeyRaw =
    typeof envForRun.Z_AI_API_KEY === 'string'
      ? envForRun.Z_AI_API_KEY
      : typeof envForRun.ZAI_API_KEY === 'string'
        ? envForRun.ZAI_API_KEY
        : null
  const zaiBaseUrlRaw =
    typeof envForRun.Z_AI_BASE_URL === 'string'
      ? envForRun.Z_AI_BASE_URL
      : typeof envForRun.ZAI_BASE_URL === 'string'
        ? envForRun.ZAI_BASE_URL
        : null
  const openRouterKeyRaw =
    typeof envForRun.OPENROUTER_API_KEY === 'string' ? envForRun.OPENROUTER_API_KEY : null
  const openaiKeyRaw =
    typeof envForRun.OPENAI_API_KEY === 'string' ? envForRun.OPENAI_API_KEY : null
  const apiKey =
    typeof openaiBaseUrl === 'string' && /openrouter\.ai/i.test(openaiBaseUrl)
      ? (openRouterKeyRaw ?? openaiKeyRaw)
      : openaiKeyRaw
  const apifyToken =
    typeof envForRun.APIFY_API_TOKEN === 'string' ? envForRun.APIFY_API_TOKEN : null
  const ytDlpPath = (() => {
    const explicit = typeof envForRun.YT_DLP_PATH === 'string' ? envForRun.YT_DLP_PATH.trim() : ''
    if (explicit.length > 0) return explicit
    return resolveExecutableInPath('yt-dlp', envForRun)
  })()
  const falApiKey = typeof envForRun.FAL_KEY === 'string' ? envForRun.FAL_KEY : null
  const firecrawlKey =
    typeof envForRun.FIRECRAWL_API_KEY === 'string' ? envForRun.FIRECRAWL_API_KEY : null
  const anthropicKeyRaw =
    typeof envForRun.ANTHROPIC_API_KEY === 'string' ? envForRun.ANTHROPIC_API_KEY : null
  const googleKeyRaw =
    typeof envForRun.GEMINI_API_KEY === 'string'
      ? envForRun.GEMINI_API_KEY
      : typeof envForRun.GOOGLE_GENERATIVE_AI_API_KEY === 'string'
        ? envForRun.GOOGLE_GENERATIVE_AI_API_KEY
        : typeof envForRun.GOOGLE_API_KEY === 'string'
          ? envForRun.GOOGLE_API_KEY
          : null

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null
  const firecrawlConfigured = firecrawlApiKey !== null
  const xaiApiKey = xaiKeyRaw?.trim() ?? null
  const zaiApiKey = zaiKeyRaw?.trim() ?? null
  const zaiBaseUrl = (zaiBaseUrlRaw?.trim() ?? '') || 'https://api.z.ai/api/paas/v4'
  const googleApiKey = googleKeyRaw?.trim() ?? null
  const anthropicApiKey = anthropicKeyRaw?.trim() ?? null
  const openrouterApiKey = (() => {
    const explicit = openRouterKeyRaw?.trim() ?? ''
    if (explicit.length > 0) return explicit
    const baseUrl = openaiBaseUrl?.trim() ?? ''
    const openaiKey = openaiKeyRaw?.trim() ?? ''
    if (baseUrl.length > 0 && /openrouter\.ai/i.test(baseUrl) && openaiKey.length > 0) {
      return openaiKey
    }
    return null
  })()
  const openaiTranscriptionKey = openaiKeyRaw?.trim() ?? null
  const googleConfigured = typeof googleApiKey === 'string' && googleApiKey.length > 0
  const xaiConfigured = typeof xaiApiKey === 'string' && xaiApiKey.length > 0
  const anthropicConfigured = typeof anthropicApiKey === 'string' && anthropicApiKey.length > 0
  const openrouterConfigured = typeof openrouterApiKey === 'string' && openrouterApiKey.length > 0
  const cliAvailability = resolveCliAvailability({ env, config: configForCli })
  const envForAuto = openrouterApiKey ? { ...env, OPENROUTER_API_KEY: openrouterApiKey } : env

  if (markdownModeExplicitlySet && format !== 'markdown') {
    throw new Error('--markdown-mode is only supported with --format md')
  }
  if (markdownModeExplicitlySet && inputTarget.kind !== 'url') {
    throw new Error('--markdown-mode is only supported for website URLs')
  }

  const llmCalls: LlmCall[] = []
  let firecrawlRequests = 0
  let apifyRequests = 0
  let transcriptionCostUsd: number | null = null
  let transcriptionCostLabel: string | null = null

  const pickModelForFinishLine = (fallback: string | null = null): string | null => {
    const findLastModel = (purpose: LlmCall['purpose']): string | null => {
      for (let i = llmCalls.length - 1; i >= 0; i -= 1) {
        const call = llmCalls[i]
        if (call && call.purpose === purpose) return call.model
      }
      return null
    }

    return (
      findLastModel('summary') ??
      findLastModel('markdown') ??
      (llmCalls.length > 0 ? (llmCalls[llmCalls.length - 1]?.model ?? null) : null) ??
      fallback
    )
  }

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
    const extraCosts = [
      typeof transcriptionCostUsd === 'number' && Number.isFinite(transcriptionCostUsd)
        ? transcriptionCostUsd
        : null,
    ].filter((value): value is number => typeof value === 'number')
    const extraTotal = extraCosts.length > 0 ? extraCosts.reduce((sum, value) => sum + value, 0) : 0
    const hasExtra = extraCosts.length > 0

    const explicitCosts = llmCalls
      .map((call) =>
        typeof call.costUsd === 'number' && Number.isFinite(call.costUsd) ? call.costUsd : null
      )
      .filter((value): value is number => typeof value === 'number')
    const explicitTotal =
      explicitCosts.length > 0 ? explicitCosts.reduce((sum, value) => sum + value, 0) : 0

    const calls = llmCalls
      .filter((call) => !(typeof call.costUsd === 'number' && Number.isFinite(call.costUsd)))
      .map((call) => {
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
    if (calls.length === 0) {
      if (explicitCosts.length > 0 || hasExtra) return explicitTotal + extraTotal
      return null
    }

    const catalog = await getLiteLlmCatalog()
    if (!catalog) {
      if (explicitCosts.length > 0 || hasExtra) return explicitTotal + extraTotal
      return null
    }
    const result = await tallyCosts({
      calls,
      resolvePricing: (modelId) => resolveLiteLlmPricingForModelId(catalog, modelId),
    })
    const catalogTotal = result.total?.totalUsd ?? null
    if (catalogTotal === null && explicitCosts.length === 0 && !hasExtra) return null
    return (catalogTotal ?? 0) + explicitTotal + extraTotal
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

  const modelMap = (() => {
    const out = new Map<string, { name: string; model: ModelConfig }>()

    for (const [name, model] of Object.entries(BUILTIN_MODELS)) {
      out.set(name.toLowerCase(), { name, model })
    }

    const raw = config?.models
    if (!raw) return out
    for (const [name, model] of Object.entries(raw)) {
      out.set(name.toLowerCase(), { name, model })
    }
    return out
  })()

  const resolvedDefaultModel = (() => {
    if (
      typeof envForRun.SUMMARIZE_MODEL === 'string' &&
      envForRun.SUMMARIZE_MODEL.trim().length > 0
    ) {
      return envForRun.SUMMARIZE_MODEL.trim()
    }
    const modelFromConfig = config?.model
    if (modelFromConfig) {
      if ('id' in modelFromConfig && typeof modelFromConfig.id === 'string') {
        const id = modelFromConfig.id.trim()
        if (id.length > 0) return id
      }
      if ('name' in modelFromConfig && typeof modelFromConfig.name === 'string') {
        const name = modelFromConfig.name.trim()
        if (name.length > 0) return name
      }
      if ('mode' in modelFromConfig && modelFromConfig.mode === 'auto') return 'auto'
    }
    return 'auto'
  })()

  const requestedModelInput = ((explicitModelArg?.trim() ?? '') || resolvedDefaultModel).trim()
  const requestedModelInputLower = requestedModelInput.toLowerCase()
  const wantsFreeNamedModel = requestedModelInputLower === 'free'

  const namedModelMatch =
    requestedModelInputLower !== 'auto' ? (modelMap.get(requestedModelInputLower) ?? null) : null
  const namedModelConfig = namedModelMatch?.model ?? null
  const isNamedModelSelection = Boolean(namedModelMatch)

  const configForModelSelection =
    isNamedModelSelection && namedModelConfig
      ? ({ ...(configForCli ?? {}), model: namedModelConfig } as const)
      : configForCli

  const requestedModel: RequestedModel = (() => {
    if (isNamedModelSelection && namedModelConfig) {
      if ('id' in namedModelConfig) return parseRequestedModelId(namedModelConfig.id)
      if ('mode' in namedModelConfig && namedModelConfig.mode === 'auto') return { kind: 'auto' }
      throw new Error(
        `Invalid model "${namedModelMatch?.name ?? requestedModelInput}": unsupported model config`
      )
    }

    if (requestedModelInputLower !== 'auto' && !requestedModelInput.includes('/')) {
      throw new Error(
        `Unknown model "${requestedModelInput}". Define it in ${configPath ?? '~/.summarize/config.json'} under "models", or use a provider-prefixed id like openai/...`
      )
    }

    return parseRequestedModelId(requestedModelInput)
  })()

  const requestedModelLabel = isNamedModelSelection
    ? requestedModelInput
    : requestedModel.kind === 'auto'
      ? 'auto'
      : requestedModel.userModelId

  const isFallbackModel = requestedModel.kind === 'auto'

  const verboseColor = supportsColor(stderr, envForRun)
  const effectiveStreamMode = (() => {
    if (streamMode !== 'auto') return streamMode
    return isRichTty(stdout) ? 'on' : 'off'
  })()
  const streamingEnabled = effectiveStreamMode === 'on' && !json && !extractMode
  const effectiveRenderMode = (() => {
    if (renderMode !== 'auto') return renderMode
    if (!isRichTty(stdout)) return 'plain'
    return streamingEnabled ? 'md-live' : 'md'
  })()

  if (extractMode && inputTarget.kind !== 'url') {
    throw new Error('--extract is only supported for website/YouTube URLs')
  }

  const progressEnabled = isRichTty(stderr) && !verbose && !json
  let clearProgressBeforeStdout: (() => void) | null = null
  const clearProgressForStdout = () => {
    const fn = clearProgressBeforeStdout
    clearProgressBeforeStdout = null
    fn?.()
  }

  const fixedModelSpec: FixedModelSpec | null =
    requestedModel.kind === 'fixed' ? requestedModel : null

  const desiredOutputTokens = (() => {
    if (typeof maxOutputTokensArg === 'number') return maxOutputTokensArg
    const targetChars = resolveTargetCharacters(lengthArg, SUMMARY_LENGTH_MAX_CHARACTERS)
    if (
      !Number.isFinite(targetChars) ||
      targetChars <= 0 ||
      targetChars === Number.POSITIVE_INFINITY
    ) {
      return null
    }
    // Rough heuristic (chars → tokens). Used for auto selection + cost estimation.
    return Math.max(16, Math.ceil(targetChars / 4))
  })()

  type ModelAttempt = {
    transport: 'native' | 'openrouter' | 'cli'
    userModelId: string
    llmModelId: string | null
    openrouterProviders: string[] | null
    forceOpenRouter: boolean
    requiredEnv:
      | 'XAI_API_KEY'
      | 'OPENAI_API_KEY'
      | 'GEMINI_API_KEY'
      | 'ANTHROPIC_API_KEY'
      | 'OPENROUTER_API_KEY'
      | 'Z_AI_API_KEY'
      | 'CLI_CLAUDE'
      | 'CLI_CODEX'
      | 'CLI_GEMINI'
    openaiBaseUrlOverride?: string | null
    openaiApiKeyOverride?: string | null
    forceChatCompletions?: boolean
    cliProvider?: CliProvider
    cliModel?: string | null
  }

  type ModelMeta = {
    provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai' | 'cli'
    canonical: string
  }

  const applyZaiOverrides = (attempt: ModelAttempt): ModelAttempt => {
    if (!attempt.userModelId.toLowerCase().startsWith('zai/')) return attempt
    return {
      ...attempt,
      openaiApiKeyOverride: zaiApiKey,
      openaiBaseUrlOverride: zaiBaseUrl,
      forceChatCompletions: true,
    }
  }

  const envHasKeyFor = (requiredEnv: ModelAttempt['requiredEnv']) => {
    if (requiredEnv === 'CLI_CLAUDE') {
      return Boolean(cliAvailability.claude)
    }
    if (requiredEnv === 'CLI_CODEX') {
      return Boolean(cliAvailability.codex)
    }
    if (requiredEnv === 'CLI_GEMINI') {
      return Boolean(cliAvailability.gemini)
    }
    if (requiredEnv === 'GEMINI_API_KEY') {
      return googleConfigured
    }
    if (requiredEnv === 'OPENROUTER_API_KEY') {
      return openrouterConfigured
    }
    if (requiredEnv === 'OPENAI_API_KEY') {
      return Boolean(apiKey)
    }
    if (requiredEnv === 'Z_AI_API_KEY') {
      return Boolean(zaiApiKey)
    }
    if (requiredEnv === 'XAI_API_KEY') {
      return Boolean(xaiApiKey)
    }
    return Boolean(anthropicApiKey)
  }

  const formatMissingModelError = (attempt: ModelAttempt): string => {
    if (attempt.requiredEnv === 'CLI_CLAUDE') {
      return `Claude CLI not found for model ${attempt.userModelId}. Install Claude CLI or set CLAUDE_PATH.`
    }
    if (attempt.requiredEnv === 'CLI_CODEX') {
      return `Codex CLI not found for model ${attempt.userModelId}. Install Codex CLI or set CODEX_PATH.`
    }
    if (attempt.requiredEnv === 'CLI_GEMINI') {
      return `Gemini CLI not found for model ${attempt.userModelId}. Install Gemini CLI or set GEMINI_PATH.`
    }
    return `Missing ${attempt.requiredEnv} for model ${attempt.userModelId}. Set the env var or choose a different --model.`
  }

  const runSummaryAttempt = async ({
    attempt,
    prompt,
    allowStreaming,
    onModelChosen,
    cli,
  }: {
    attempt: ModelAttempt
    prompt: string | ModelMessage[]
    allowStreaming: boolean
    onModelChosen?: ((modelId: string) => void) | null
    cli?: {
      promptOverride?: string
      allowTools?: boolean
      cwd?: string
      extraArgsByProvider?: Partial<Record<CliProvider, string[]>>
    } | null
  }): Promise<{
    summary: string
    summaryAlreadyPrinted: boolean
    modelMeta: ModelMeta
    maxOutputTokensForCall: number | null
  }> => {
    onModelChosen?.(attempt.userModelId)

    if (attempt.transport === 'cli') {
      const cliPrompt = typeof prompt === 'string' ? prompt : (cli?.promptOverride ?? null)
      if (!cliPrompt) {
        throw new Error('CLI models require a text prompt (no binary attachments).')
      }
      if (!attempt.cliProvider) {
        throw new Error(`Missing CLI provider for model ${attempt.userModelId}.`)
      }
      if (isCliDisabled(attempt.cliProvider, cliConfigForRun)) {
        throw new Error(
          `CLI provider ${attempt.cliProvider} is disabled by cli.enabled. Update your config to enable it.`
        )
      }
      const result = await runCliModel({
        provider: attempt.cliProvider,
        prompt: cliPrompt,
        model: attempt.cliModel ?? null,
        allowTools: Boolean(cli?.allowTools),
        timeoutMs,
        env,
        execFileImpl,
        config: cliConfigForRun ?? null,
        cwd: cli?.cwd,
        extraArgs: cli?.extraArgsByProvider?.[attempt.cliProvider],
      })
      const summary = result.text.trim()
      if (!summary) throw new Error('CLI returned an empty summary')
      if (result.usage || typeof result.costUsd === 'number') {
        llmCalls.push({
          provider: 'cli',
          model: attempt.userModelId,
          usage: result.usage ?? null,
          costUsd: result.costUsd ?? null,
          purpose: 'summary',
        })
      }
      return {
        summary,
        summaryAlreadyPrinted: false,
        modelMeta: { provider: 'cli', canonical: attempt.userModelId },
        maxOutputTokensForCall: null,
      }
    }

    if (!attempt.llmModelId) {
      throw new Error(`Missing model id for ${attempt.userModelId}.`)
    }
    const parsedModel = parseGatewayStyleModelId(attempt.llmModelId)
    const apiKeysForLlm = {
      xaiApiKey,
      openaiApiKey: attempt.openaiApiKeyOverride ?? apiKey,
      googleApiKey: googleConfigured ? googleApiKey : null,
      anthropicApiKey: anthropicConfigured ? anthropicApiKey : null,
      openrouterApiKey: openrouterConfigured ? openrouterApiKey : null,
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
    const streamingEnabledForCall =
      allowStreaming && streamingEnabled && !modelResolution.forceStreamOff
    const forceChatCompletions =
      Boolean(attempt.forceChatCompletions) ||
      (openaiUseChatCompletions && parsedModelEffective.provider === 'openai')

    const maxOutputTokensForCall = await resolveMaxOutputTokensForCall(
      parsedModelEffective.canonical
    )
    const maxInputTokensForCall = await resolveMaxInputTokensForCall(parsedModelEffective.canonical)
    if (
      typeof maxInputTokensForCall === 'number' &&
      Number.isFinite(maxInputTokensForCall) &&
      maxInputTokensForCall > 0 &&
      typeof prompt === 'string'
    ) {
      const tokenCount = countTokens(prompt)
      if (tokenCount > maxInputTokensForCall) {
        throw new Error(
          `Input token count (${formatCompactCount(tokenCount)}) exceeds model input limit (${formatCompactCount(maxInputTokensForCall)}). Tokenized with GPT tokenizer; prompt included.`
        )
      }
    }

    if (!streamingEnabledForCall) {
      const result = await summarizeWithModelId({
        modelId: parsedModelEffective.canonical,
        prompt,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs,
        fetchImpl: trackedFetch,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? null,
        forceChatCompletions,
        retries,
        onRetry: createRetryLogger({
          stderr,
          verbose,
          color: verboseColor,
          modelId: parsedModelEffective.canonical,
        }),
      })
      llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: 'summary',
      })
      const summary = result.text.trim()
      if (!summary) throw new Error('LLM returned an empty summary')
      const displayCanonical = attempt.userModelId.toLowerCase().startsWith('openrouter/')
        ? attempt.userModelId
        : parsedModelEffective.canonical
      return {
        summary,
        summaryAlreadyPrinted: false,
        modelMeta: {
          provider: parsedModelEffective.provider,
          canonical: displayCanonical,
        },
        maxOutputTokensForCall: maxOutputTokensForCall ?? null,
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

    let streamResult: Awaited<ReturnType<typeof streamTextWithModelId>> | null = null
    try {
      streamResult = await streamTextWithModelId({
        modelId: parsedModelEffective.canonical,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? null,
        forceChatCompletions,
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
          forceOpenRouter: attempt.forceOpenRouter,
          openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? null,
          forceChatCompletions,
          retries,
          onRetry: createRetryLogger({
            stderr,
            verbose,
            color: verboseColor,
            modelId: parsedModelEffective.canonical,
          }),
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
          forceOpenRouter: attempt.forceOpenRouter,
          retries,
          onRetry: createRetryLogger({
            stderr,
            verbose,
            color: verboseColor,
            modelId: parsedModelEffective.canonical,
          }),
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
      let liveOverflowed = false
      const liveRows = terminalHeight(stdout, env)
      const liveMaxRows = Math.max(1, liveRows - 1)
      const liveTailRows = Math.min(
        liveMaxRows,
        Math.max(8, Math.min(24, Math.floor(liveRows / 2)))
      )
      const liveRenderer = shouldLiveRenderSummary
        ? createLiveRenderer(
            {
              write: (chunk) => {
                clearProgressForStdout()
                stdout.write(chunk)
              },
              width: markdownRenderWidth(stdout, env),
              renderFrame: (markdown) =>
                renderMarkdownAnsi(prepareMarkdownForTerminal(markdown), {
                  width: markdownRenderWidth(stdout, env),
                  wrap: true,
                color: supportsColor(stdout, envForRun),
                hyperlinks: true,
              }),
              // markdansi supports tailRows/maxRows at runtime; typings lag behind.
              tailRows: liveTailRows,
              maxRows: liveMaxRows,
              clearOnOverflow: true,
              clearScrollbackOnOverflow: false,
              onOverflow: () => {
                liveOverflowed = true
              },
            } as Parameters<typeof createLiveRenderer>[0]
          )
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

          if (liveRenderer && !liveOverflowed) {
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
        if (liveRenderer && !liveOverflowed) {
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

    summary = summary.trim()
    if (summary.length === 0) {
      const last = getLastStreamError?.()
      if (last instanceof Error) {
        throw new Error(last.message, { cause: last })
      }
      throw new Error('LLM returned an empty summary')
    }

    return {
      summary,
      summaryAlreadyPrinted,
      modelMeta: {
        provider: parsedModelEffective.provider,
        canonical: attempt.userModelId.toLowerCase().startsWith('openrouter/')
          ? attempt.userModelId
          : parsedModelEffective.canonical,
      },
      maxOutputTokensForCall: maxOutputTokensForCall ?? null,
    }
  }

  const writeViaFooter = (parts: string[]) => {
    if (json) return
    if (extractMode) return
    const filtered = parts.map((p) => p.trim()).filter(Boolean)
    if (filtered.length === 0) return
    clearProgressForStdout()
    stderr.write(`${ansi('2', `via ${filtered.join(', ')}`, verboseColor)}\n`)
  }

  const summarizeAsset = async ({
    sourceKind,
    sourceLabel,
    attachment,
    onModelChosen,
  }: {
    sourceKind: 'file' | 'asset-url'
    sourceLabel: string
    attachment: Awaited<ReturnType<typeof loadLocalAsset>>['attachment']
    onModelChosen?: ((modelId: string) => void) | null
  }) => {
    const textContent = getTextContentFromAttachment(attachment)
    if (textContent && textContent.bytes > MAX_TEXT_BYTES_DEFAULT) {
      throw new Error(
        `Text file too large (${formatBytes(textContent.bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
      )
    }

    const fileBytes = getFileBytesFromAttachment(attachment)
    const canPreprocessWithMarkitdown =
      format === 'markdown' &&
      preprocessMode !== 'off' &&
      hasUvxCli(env) &&
      attachment.part.type === 'file' &&
      fileBytes !== null &&
      shouldMarkitdownConvertMediaType(attachment.mediaType)

    const summaryLengthTarget =
      lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters }

    let promptText = ''
    const assetFooterParts: string[] = []

    const buildAttachmentPromptPayload = () => {
      promptText = buildFileSummaryPrompt({
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        summaryLength: summaryLengthTarget,
        contentLength: textContent?.content.length ?? null,
        outputLanguage,
      })
      return buildAssetPromptPayload({ promptText, attachment, textContent })
    }

    const buildMarkitdownPromptPayload = (markdown: string) => {
      promptText = buildFileTextSummaryPrompt({
        filename: attachment.filename,
        originalMediaType: attachment.mediaType,
        contentMediaType: 'text/markdown',
        summaryLength: summaryLengthTarget,
        contentLength: markdown.length,
        outputLanguage,
      })
      return `${promptText}\n\n---\n\n${markdown}`.trim()
    }

    let preprocessedMarkdown: string | null = null
    let usingPreprocessedMarkdown = false

    if (preprocessMode === 'always' && canPreprocessWithMarkitdown) {
      if (!fileBytes) {
        throw new Error('Internal error: missing file bytes for markitdown preprocessing')
      }
      try {
        preprocessedMarkdown = await convertToMarkdownWithMarkitdown({
          bytes: fileBytes,
          filenameHint: attachment.filename,
          mediaTypeHint: attachment.mediaType,
          uvxCommand: envForRun.UVX_PATH,
          timeoutMs,
          env,
          execFileImpl,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Failed to preprocess ${attachment.mediaType} with markitdown: ${message} (disable with --preprocess off).`
        )
      }
      if (Buffer.byteLength(preprocessedMarkdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
        throw new Error(
          `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(preprocessedMarkdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
        )
      }
      usingPreprocessedMarkdown = true
      assetFooterParts.push(`markitdown(${attachment.mediaType})`)
    }

    let promptPayload: string | Array<ModelMessage> = buildAttachmentPromptPayload()
    if (usingPreprocessedMarkdown) {
      if (!preprocessedMarkdown) {
        throw new Error('Internal error: missing markitdown content for preprocessing')
      }
      promptPayload = buildMarkitdownPromptPayload(preprocessedMarkdown)
    }

    if (
      !usingPreprocessedMarkdown &&
      fixedModelSpec &&
      fixedModelSpec.transport !== 'cli' &&
      preprocessMode !== 'off'
    ) {
      const fixedParsed = parseGatewayStyleModelId(fixedModelSpec.llmModelId)
      try {
        assertProviderSupportsAttachment({
          provider: fixedParsed.provider,
          modelId: fixedModelSpec.userModelId,
          attachment: { part: attachment.part, mediaType: attachment.mediaType },
        })
      } catch (error) {
        if (!canPreprocessWithMarkitdown) {
          if (
            format === 'markdown' &&
            attachment.part.type === 'file' &&
            shouldMarkitdownConvertMediaType(attachment.mediaType) &&
            !hasUvxCli(env)
          ) {
            throw withUvxTip(error, env)
          }
          throw error
        }
        if (!fileBytes) {
          throw new Error('Internal error: missing file bytes for markitdown preprocessing')
        }
        try {
          preprocessedMarkdown = await convertToMarkdownWithMarkitdown({
            bytes: fileBytes,
            filenameHint: attachment.filename,
            mediaTypeHint: attachment.mediaType,
            uvxCommand: envForRun.UVX_PATH,
            timeoutMs,
            env,
            execFileImpl,
          })
        } catch (markitdownError) {
          if (preprocessMode === 'auto') {
            throw error
          }
          const message =
            markitdownError instanceof Error ? markitdownError.message : String(markitdownError)
          throw new Error(
            `Failed to preprocess ${attachment.mediaType} with markitdown: ${message} (disable with --preprocess off).`
          )
        }
        if (Buffer.byteLength(preprocessedMarkdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
          throw new Error(
            `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(preprocessedMarkdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
          )
        }
        usingPreprocessedMarkdown = true
        assetFooterParts.push(`markitdown(${attachment.mediaType})`)
        promptPayload = buildMarkitdownPromptPayload(preprocessedMarkdown)
      }
    }

    const promptTokensForAuto =
      typeof promptPayload === 'string' ? countTokens(promptPayload) : null
    const lowerMediaType = attachment.mediaType.toLowerCase()
    const kind = lowerMediaType.startsWith('video/')
      ? ('video' as const)
      : lowerMediaType.startsWith('image/')
        ? ('image' as const)
        : textContent
          ? ('text' as const)
          : ('file' as const)
    const requiresVideoUnderstanding = kind === 'video' && videoMode !== 'transcript'
    const attempts: ModelAttempt[] = await (async () => {
      if (isFallbackModel) {
        const catalog = await getLiteLlmCatalog()
        const all = buildAutoModelAttempts({
          kind,
          promptTokens: promptTokensForAuto,
          desiredOutputTokens,
          requiresVideoUnderstanding,
          env: envForAuto,
          config: configForModelSelection,
          catalog,
          openrouterProvidersFromEnv: null,
          cliAvailability,
        })
        const mapped: ModelAttempt[] = all.map((attempt) => {
          if (attempt.transport !== 'cli') return applyZaiOverrides(attempt as ModelAttempt)
          const parsed = parseCliUserModelId(attempt.userModelId)
          return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
        })
        const filtered = mapped.filter((a) => {
          if (a.transport === 'cli') return true
          if (!a.llmModelId) return false
          const parsed = parseGatewayStyleModelId(a.llmModelId)
          if (
            parsed.provider === 'xai' &&
            attachment.part.type === 'file' &&
            !isTextLikeMediaType(attachment.mediaType)
          ) {
            return false
          }
          return true
        })
        return filtered
      }
      /* v8 ignore next */
      if (!fixedModelSpec) {
        throw new Error('Internal error: missing fixed model spec')
      }
      if (fixedModelSpec.transport === 'cli') {
        return [
          {
            transport: 'cli',
            userModelId: fixedModelSpec.userModelId,
            llmModelId: null,
            cliProvider: fixedModelSpec.cliProvider,
            cliModel: fixedModelSpec.cliModel,
            openrouterProviders: null,
            forceOpenRouter: false,
            requiredEnv: fixedModelSpec.requiredEnv,
          },
        ]
      }
      const openaiOverrides =
        fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
          ? {
              openaiApiKeyOverride: zaiApiKey,
              openaiBaseUrlOverride: zaiBaseUrl,
              forceChatCompletions: true,
            }
          : {}
      return [
        {
          transport: fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
          userModelId: fixedModelSpec.userModelId,
          llmModelId: fixedModelSpec.llmModelId,
          openrouterProviders: fixedModelSpec.openrouterProviders,
          forceOpenRouter: fixedModelSpec.forceOpenRouter,
          requiredEnv: fixedModelSpec.requiredEnv,
          ...openaiOverrides,
        },
      ]
    })()

    const cliContext = await (async () => {
      if (!attempts.some((a) => a.transport === 'cli')) return null
      if (typeof promptPayload === 'string') return null
      const needsPathPrompt = attachment.part.type === 'image' || attachment.part.type === 'file'
      if (!needsPathPrompt) return null
      const filePath = await ensureCliAttachmentPath({ sourceKind, sourceLabel, attachment })
      const dir = path.dirname(filePath)
      const extraArgsByProvider: Partial<Record<CliProvider, string[]>> = {
        gemini: ['--include-directories', dir],
        codex: attachment.part.type === 'image' ? ['-i', filePath] : undefined,
      }
      return {
        promptOverride: buildPathSummaryPrompt({
          kindLabel: attachment.part.type === 'image' ? 'image' : 'file',
          filePath,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          summaryLength: summaryLengthTarget,
          outputLanguage,
        }),
        allowTools: true,
        cwd: dir,
        extraArgsByProvider,
      }
    })()

    const attemptOutcome = await runModelAttempts({
      attempts,
      isFallbackModel,
      isNamedModelSelection,
      envHasKeyFor,
      formatMissingModelError,
      onAutoSkip: (attempt) => {
        writeVerbose(
          stderr,
          verbose,
          `auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`,
          verboseColor
        )
      },
      onAutoFailure: (attempt, error) => {
        writeVerbose(
          stderr,
          verbose,
          `auto failed ${attempt.userModelId}: ${error instanceof Error ? error.message : String(error)}`,
          verboseColor
        )
      },
      onFixedModelError: (attempt, error) => {
        if (isUnsupportedAttachmentError(error)) {
          throw new Error(
            `Model ${attempt.userModelId} does not support attaching files of type ${attachment.mediaType}. Try a different --model.`,
            { cause: error }
          )
        }
        throw error
      },
      runAttempt: (attempt) =>
        runSummaryAttempt({
          attempt,
          prompt: promptPayload,
          allowStreaming: streamingEnabled,
          onModelChosen: onModelChosen ?? null,
          cli: cliContext,
        }),
    })
    const summaryResult = attemptOutcome.result
    const usedAttempt = attemptOutcome.usedAttempt
    const { lastError, missingRequiredEnvs, sawOpenRouterNoAllowedProviders } = attemptOutcome

    if (!summaryResult || !usedAttempt) {
      const withFreeTip = (message: string) => {
        if (!isNamedModelSelection || !wantsFreeNamedModel) return message
        return (
          `${message}\n` +
          `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
        )
      }

      if (isNamedModelSelection) {
        if (lastError === null && missingRequiredEnvs.size > 0) {
          throw new Error(
            withFreeTip(
              `Missing ${Array.from(missingRequiredEnvs).sort().join(', ')} for --model ${requestedModelInput}.`
            )
          )
        }
        if (lastError instanceof Error) {
          if (sawOpenRouterNoAllowedProviders) {
            const message = await buildOpenRouterNoAllowedProvidersMessage({
              attempts,
              fetchImpl: trackedFetch,
              timeoutMs,
            })
            throw new Error(withFreeTip(message), { cause: lastError })
          }
          throw new Error(withFreeTip(lastError.message), { cause: lastError })
        }
        throw new Error(withFreeTip(`No model available for --model ${requestedModelInput}`))
      }
      if (textContent) {
        clearProgressForStdout()
        stdout.write(`${textContent.content.trim()}\n`)
        if (assetFooterParts.length > 0) {
          writeViaFooter([...assetFooterParts, 'no model'])
        }
        return
      }
      if (lastError instanceof Error) throw lastError
      throw new Error('No model available for this input')
    }

    const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

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
              model: requestedModelLabel,
              language: formatOutputLanguageForJson(outputLanguage),
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
              model: requestedModelLabel,
              language: formatOutputLanguageForJson(outputLanguage),
            }
      const payload: JsonOutput = {
        input,
        env: {
          hasXaiKey: Boolean(xaiApiKey),
          hasOpenAIKey: Boolean(apiKey),
          hasOpenRouterKey: Boolean(openrouterApiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
          hasGoogleKey: googleConfigured,
          hasAnthropicKey: anthropicConfigured,
        },
        extracted,
        prompt: promptText,
        llm: {
          provider: modelMeta.provider,
          model: usedAttempt.userModelId,
          maxCompletionTokens: maxOutputTokensForCall,
          strategy: 'single',
        },
        metrics: metricsEnabled ? finishReport : null,
        summary,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (metricsEnabled && finishReport) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          model: usedAttempt.userModelId,
          report: finishReport,
          costUsd,
          detailed: metricsDetailed,
          extraParts: null,
          color: verboseColor,
        })
      }
      return
    }

    if (!summaryAlreadyPrinted) {
      clearProgressForStdout()
      const rendered =
        (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') && isRichTty(stdout)
          ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
              width: markdownRenderWidth(stdout, env),
              wrap: true,
              color: supportsColor(stdout, envForRun),
              hyperlinks: true,
            })
          : summary

      stdout.write(rendered)
      if (!rendered.endsWith('\n')) {
        stdout.write('\n')
      }
    }

    writeViaFooter([...assetFooterParts, `model ${usedAttempt.userModelId}`])

    const report = shouldComputeReport ? await buildReport() : null
    if (metricsEnabled && report) {
      const costUsd = await estimateCostUsd()
      writeFinishLine({
        stderr,
        elapsedMs: Date.now() - runStartedAtMs,
        model: usedAttempt.userModelId,
        report,
        costUsd,
        detailed: metricsDetailed,
        extraParts: null,
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
        onModelChosen: (modelId) => {
          if (!progressEnabled) return
          const mt = loaded.attachment.mediaType
          const name = loaded.attachment.filename
          const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
          spinner.setText(
            name
              ? `Summarizing ${name} (${details}, model: ${modelId})…`
              : `Summarizing ${details} (model: ${modelId})…`
          )
        },
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
          onModelChosen: (modelId) => {
            if (!progressEnabled) return
            spinner.setText(`Summarizing (model: ${modelId})…`)
          },
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

  const wantsMarkdown = format === 'markdown' && !isYoutubeUrl
  if (wantsMarkdown && markdownMode === 'off') {
    throw new Error('--format md conflicts with --markdown-mode off (use --format text)')
  }

  const firecrawlMode = requestedFirecrawlMode
  if (firecrawlMode === 'always' && !firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  const markdownRequested = wantsMarkdown
  const effectiveMarkdownMode = markdownRequested ? markdownMode : 'off'

  type MarkdownModel = {
    llmModelId: string
    forceOpenRouter: boolean
    openaiApiKeyOverride?: string | null
    openaiBaseUrlOverride?: string | null
    forceChatCompletions?: boolean
    requiredEnv?: ModelAttempt['requiredEnv']
  }

  const markdownModel: MarkdownModel | null = (() => {
    if (!markdownRequested) return null

    // Prefer the explicitly chosen model when it is a native provider (keeps behavior stable).
    if (requestedModel.kind === 'fixed' && requestedModel.transport === 'native') {
      if (fixedModelSpec?.requiredEnv === 'Z_AI_API_KEY') {
        return {
          llmModelId: requestedModel.llmModelId,
          forceOpenRouter: false,
          requiredEnv: fixedModelSpec.requiredEnv,
          openaiApiKeyOverride: zaiApiKey,
          openaiBaseUrlOverride: zaiBaseUrl,
          forceChatCompletions: true,
        }
      }
      return {
        llmModelId: requestedModel.llmModelId,
        forceOpenRouter: false,
        requiredEnv: fixedModelSpec?.requiredEnv,
        forceChatCompletions: openaiUseChatCompletions,
      }
    }

    // Otherwise pick a safe, broadly-capable default for HTML→Markdown conversion.
    if (googleConfigured) {
      return {
        llmModelId: 'google/gemini-3-flash-preview',
        forceOpenRouter: false,
        requiredEnv: 'GEMINI_API_KEY',
      }
    }
    if (apiKey) {
      return {
        llmModelId: 'openai/gpt-5-mini',
        forceOpenRouter: false,
        requiredEnv: 'OPENAI_API_KEY',
        forceChatCompletions: openaiUseChatCompletions,
      }
    }
    if (openrouterConfigured) {
      return {
        llmModelId: 'openai/openai/gpt-5-mini',
        forceOpenRouter: true,
        requiredEnv: 'OPENROUTER_API_KEY',
      }
    }
    if (anthropicConfigured) {
      return {
        llmModelId: 'anthropic/claude-sonnet-4-5',
        forceOpenRouter: false,
        requiredEnv: 'ANTHROPIC_API_KEY',
      }
    }
    if (xaiConfigured) {
      return {
        llmModelId: 'xai/grok-4-fast-non-reasoning',
        forceOpenRouter: false,
        requiredEnv: 'XAI_API_KEY',
      }
    }

    return null
  })()

  const markdownProvider = (() => {
    if (!markdownModel) return 'none' as const
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
    return parsed.provider
  })()

  const hasKeyForMarkdownModel = (() => {
    if (!markdownModel) return false
    if (markdownModel.forceOpenRouter) return openrouterConfigured
    if (markdownModel.requiredEnv === 'Z_AI_API_KEY') return Boolean(zaiApiKey)
    if (markdownModel.openaiApiKeyOverride) return true
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
    return parsed.provider === 'xai'
      ? xaiConfigured
      : parsed.provider === 'google'
        ? googleConfigured
        : parsed.provider === 'anthropic'
          ? anthropicConfigured
          : parsed.provider === 'zai'
            ? Boolean(zaiApiKey)
            : Boolean(apiKey)
  })()

  if (markdownRequested && effectiveMarkdownMode === 'llm' && !hasKeyForMarkdownModel) {
    const required = (() => {
      if (markdownModel?.forceOpenRouter) return 'OPENROUTER_API_KEY'
      if (markdownModel?.requiredEnv === 'Z_AI_API_KEY') return 'Z_AI_API_KEY'
      if (markdownModel) {
        const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
        return parsed.provider === 'xai'
          ? 'XAI_API_KEY'
          : parsed.provider === 'google'
            ? 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
            : parsed.provider === 'anthropic'
              ? 'ANTHROPIC_API_KEY'
              : parsed.provider === 'zai'
                ? 'Z_AI_API_KEY'
                : 'OPENAI_API_KEY'
      }
      return 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
    })()
    throw new Error(`--markdown-mode llm requires ${required}`)
  }

  writeVerbose(
    stderr,
    verbose,
    `config url=${url} timeoutMs=${timeoutMs} youtube=${youtubeMode} firecrawl=${firecrawlMode} length=${
      lengthArg.kind === 'preset' ? lengthArg.preset : `${lengthArg.maxCharacters} chars`
    } maxOutputTokens=${formatOptionalNumber(maxOutputTokensArg)} retries=${retries} json=${json} extract=${extractMode} format=${format} preprocess=${preprocessMode} markdownMode=${markdownMode} model=${requestedModelLabel} videoMode=${videoMode} stream=${effectiveStreamMode} render=${effectiveRenderMode}`,
    verboseColor
  )
  writeVerbose(
    stderr,
    verbose,
    `configFile path=${formatOptionalString(configPath)} model=${formatOptionalString(
      (() => {
        const model = config?.model
        if (!model) return null
        if ('id' in model) return model.id
        if ('name' in model) return model.name
        if ('mode' in model && model.mode === 'auto') return 'auto'
        return null
      })()
    )}`,
    verboseColor
  )
  writeVerbose(
    stderr,
    verbose,
    `env xaiKey=${xaiConfigured} openaiKey=${Boolean(apiKey)} zaiKey=${Boolean(zaiApiKey)} googleKey=${googleConfigured} anthropicKey=${anthropicConfigured} openrouterKey=${openrouterConfigured} apifyToken=${Boolean(apifyToken)} firecrawlKey=${firecrawlConfigured}`,
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

  const llmHtmlToMarkdown =
    markdownRequested &&
    markdownModel !== null &&
    (effectiveMarkdownMode === 'llm' || markdownProvider !== 'none')
      ? createHtmlToMarkdownConverter({
          modelId: markdownModel.llmModelId,
          forceOpenRouter: markdownModel.forceOpenRouter,
          xaiApiKey: xaiConfigured ? xaiApiKey : null,
          googleApiKey: googleConfigured ? googleApiKey : null,
          openaiApiKey: markdownModel.openaiApiKeyOverride ?? apiKey,
          anthropicApiKey: anthropicConfigured ? anthropicApiKey : null,
          openrouterApiKey: openrouterConfigured ? openrouterApiKey : null,
          openaiBaseUrlOverride: markdownModel.openaiBaseUrlOverride ?? null,
          forceChatCompletions:
            markdownModel.forceChatCompletions ??
            (openaiUseChatCompletions && markdownProvider === 'openai'),
          fetchImpl: trackedFetch,
          retries,
          onRetry: createRetryLogger({
            stderr,
            verbose,
            color: verboseColor,
            modelId: markdownModel.llmModelId,
          }),
          onUsage: ({ model: usedModel, provider, usage }) => {
            llmCalls.push({ provider, model: usedModel, usage, purpose: 'markdown' })
          },
        })
      : null

  const markitdownHtmlToMarkdown =
    markdownRequested && preprocessMode !== 'off' && hasUvxCli(env)
      ? async (args: {
          url: string
          html: string
          title: string | null
          siteName: string | null
          timeoutMs: number
        }) => {
          void args.url
          void args.title
          void args.siteName
          return convertToMarkdownWithMarkitdown({
            bytes: new TextEncoder().encode(args.html),
            filenameHint: 'page.html',
            mediaTypeHint: 'text/html',
            uvxCommand: envForRun.UVX_PATH,
            timeoutMs: args.timeoutMs,
            env,
            execFileImpl,
          })
        }
      : null

  const convertHtmlToMarkdown = markdownRequested
    ? async (args: {
        url: string
        html: string
        title: string | null
        siteName: string | null
        timeoutMs: number
      }) => {
        if (effectiveMarkdownMode === 'llm') {
          if (!llmHtmlToMarkdown) {
            throw new Error('No HTML→Markdown converter configured')
          }
          return llmHtmlToMarkdown(args)
        }

        if (extractMode) {
          if (markitdownHtmlToMarkdown) {
            return await markitdownHtmlToMarkdown(args)
          }
          throw new Error(
            'No HTML→Markdown converter configured (install uvx/markitdown or use --markdown-mode llm)'
          )
        }

        if (llmHtmlToMarkdown) {
          try {
            return await llmHtmlToMarkdown(args)
          } catch (error) {
            if (!markitdownHtmlToMarkdown) throw error
            return await markitdownHtmlToMarkdown(args)
          }
        }

        if (markitdownHtmlToMarkdown) {
          return await markitdownHtmlToMarkdown(args)
        }

        throw new Error('No HTML→Markdown converter configured')
      }
    : null
  const readTweetWithBirdClient = hasBirdCli(env)
    ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
        readTweetWithBird({ url, timeoutMs, env })
    : null

  writeVerbose(stderr, verbose, 'extract start', verboseColor)
  const oscProgress = createOscProgressController({
    label: 'Fetching website',
    env,
    isTty: progressEnabled,
    write: (data: string) => stderr.write(data),
  })
  oscProgress.setIndeterminate('Fetching website')
  const spinner = startSpinner({
    text: 'Fetching website (connecting)…',
    enabled: progressEnabled,
    stream: stderr,
  })
  const websiteProgress = createWebsiteProgress({
    enabled: progressEnabled,
    spinner,
    oscProgress,
  })

  const client = createLinkPreviewClient({
    apifyApiToken: apifyToken,
    ytDlpPath,
    falApiKey,
    openaiApiKey: openaiTranscriptionKey,
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
    oscProgress.clear()
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
        markdownMode: markdownRequested ? effectiveMarkdownMode : undefined,
      })
    } catch (error) {
      throw withBirdTip(error, url, env)
    }
    let extractedContentSize = 'unknown'
    let viaSourceLabel = ''
    let footerBaseParts: string[] = []
    let finishSourceLabel: string | null = null

    const recomputeExtractionUi = () => {
      const extractedContentBytes = Buffer.byteLength(extracted.content, 'utf8')
      extractedContentSize = formatBytes(extractedContentBytes)

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
      viaSourceLabel = viaSources.length > 0 ? `, ${viaSources.join('+')}` : ''

      footerBaseParts = []
      if (extracted.diagnostics.strategy === 'html') footerBaseParts.push('html')
      if (extracted.diagnostics.strategy === 'bird') footerBaseParts.push('bird')
      if (extracted.diagnostics.strategy === 'nitter') footerBaseParts.push('nitter')
      if (extracted.diagnostics.firecrawl.used) footerBaseParts.push('firecrawl')
      if (extracted.diagnostics.markdown.used) {
        footerBaseParts.push(
          extracted.diagnostics.markdown.provider === 'llm' ? 'html→md llm' : 'markdown'
        )
      }
      if (extracted.diagnostics.transcript.textProvided) {
        footerBaseParts.push(`transcript ${extracted.diagnostics.transcript.provider ?? 'unknown'}`)
      }
      if (extracted.isVideoOnly && extracted.video) {
        footerBaseParts.push(extracted.video.kind === 'youtube' ? 'video youtube' : 'video url')
      }

      finishSourceLabel = buildSummaryFinishLabel({
        extracted: { diagnostics: extracted.diagnostics, wordCount: extracted.wordCount },
      })
    }

    recomputeExtractionUi()
    if (progressEnabled) {
      websiteProgress?.stop?.()
      if (!extractMode) {
        oscProgress.setIndeterminate('Summarizing')
      }
      spinner.setText(
        extractMode
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

    if (
      extractMode &&
      markdownRequested &&
      preprocessMode !== 'off' &&
      effectiveMarkdownMode === 'auto' &&
      !extracted.diagnostics.markdown.used &&
      !hasUvxCli(env)
    ) {
      stderr.write(`${UVX_TIP}\n`)
    }

    if (!isYoutubeUrl && extracted.isVideoOnly && extracted.video) {
      if (extracted.video.kind === 'youtube') {
        writeVerbose(
          stderr,
          verbose,
          `video-only page detected; switching to YouTube URL ${extracted.video.url}`,
          verboseColor
        )
        if (progressEnabled) {
          spinner.setText('Video-only page: fetching YouTube transcript…')
        }
        extracted = await client.fetchLinkContent(extracted.video.url, {
          timeoutMs,
          youtubeTranscript: youtubeMode,
          firecrawl: firecrawlMode,
          format: markdownRequested ? 'markdown' : 'text',
          markdownMode: markdownRequested ? effectiveMarkdownMode : undefined,
        })
        recomputeExtractionUi()
        if (progressEnabled) {
          spinner.setText(
            extractMode
              ? `Extracted (${extractedContentSize}${viaSourceLabel})`
              : `Summarizing (sent ${extractedContentSize}${viaSourceLabel})…`
          )
        }
      } else if (extracted.video.kind === 'direct') {
        const wantsVideoUnderstanding = videoMode === 'understand' || videoMode === 'auto'
        const canVideoUnderstand =
          wantsVideoUnderstanding &&
          googleConfigured &&
          (requestedModel.kind === 'auto' ||
            (fixedModelSpec?.transport === 'native' && fixedModelSpec.provider === 'google'))

        if (canVideoUnderstand) {
          if (progressEnabled) spinner.setText('Downloading video…')
          const loadedVideo = await loadRemoteAsset({
            url: extracted.video.url,
            fetchImpl: trackedFetch,
            timeoutMs,
          })
          assertAssetMediaTypeSupported({ attachment: loadedVideo.attachment, sizeLabel: null })

          let chosenModel: string | null = null
          if (progressEnabled) spinner.setText('Summarizing video…')
          await summarizeAsset({
            sourceKind: 'asset-url',
            sourceLabel: loadedVideo.sourceLabel,
            attachment: loadedVideo.attachment,
            onModelChosen: (modelId) => {
              chosenModel = modelId
              if (progressEnabled) spinner.setText(`Summarizing video (model: ${modelId})…`)
            },
          })
          writeViaFooter([...footerBaseParts, ...(chosenModel ? [`model ${chosenModel}`] : [])])
          return
        }
      }
    }

    // Whisper transcription cost (OpenAI only): estimate from duration (RSS hints or ffprobe) and
    // include it in the finish-line total.
    transcriptionCostUsd = estimateWhisperTranscriptionCostUsd({
      transcriptionProvider: extracted.transcriptionProvider,
      transcriptSource: extracted.transcriptSource,
      mediaDurationSeconds: extracted.mediaDurationSeconds,
      openaiWhisperUsdPerMinute,
    })
    transcriptionCostLabel =
      typeof transcriptionCostUsd === 'number' ? `txcost=${formatUSD(transcriptionCostUsd)}` : null

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
      outputLanguage,
      shares: [],
    })

    if (extractMode) {
      clearProgressForStdout()
      const finishLabel = buildExtractFinishLabel({
        extracted: { diagnostics: extracted.diagnostics },
        format,
        markdownMode: effectiveMarkdownMode,
        hasMarkdownLlmCall: llmCalls.some((call) => call.purpose === 'markdown'),
      })
      const finishModel = pickModelForFinishLine(null)
      if (json) {
        const finishReport = shouldComputeReport ? await buildReport() : null
        const payload: JsonOutput = {
          input: {
            kind: 'url',
            url,
            timeoutMs,
            youtube: youtubeMode,
            firecrawl: firecrawlMode,
            format,
            markdown: effectiveMarkdownMode,
            length:
              lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: lengthArg.preset }
                : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
            maxOutputTokens: maxOutputTokensArg,
            model: requestedModelLabel,
            language: formatOutputLanguageForJson(outputLanguage),
          },
          env: {
            hasXaiKey: Boolean(xaiApiKey),
            hasOpenAIKey: Boolean(apiKey),
            hasOpenRouterKey: Boolean(openrouterApiKey),
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
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        if (metricsEnabled && finishReport) {
          const costUsd = await estimateCostUsd()
          writeFinishLine({
            stderr,
            elapsedMs: Date.now() - runStartedAtMs,
            label: finishLabel,
            model: finishModel,
            report: finishReport,
            costUsd,
            detailed: metricsDetailed,
            extraParts: (() => {
              const parts = [
                ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
                ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
              ]
              return parts.length > 0 ? parts : null
            })(),
            color: verboseColor,
          })
        }
        return
      }

      const renderedExtract =
        format === 'markdown' &&
        (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') &&
        isRichTty(stdout)
          ? renderMarkdownAnsi(prepareMarkdownForTerminal(extracted.content), {
              width: markdownRenderWidth(stdout, env),
              wrap: true,
              color: supportsColor(stdout, envForRun),
              hyperlinks: true,
            })
          : extracted.content

      stdout.write(renderedExtract)
      if (!renderedExtract.endsWith('\n')) {
        stdout.write('\n')
      }
      writeViaFooter(footerBaseParts)
      const report = shouldComputeReport ? await buildReport() : null
      if (metricsEnabled && report) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          label: finishLabel,
          model: finishModel,
          report,
          costUsd,
          detailed: metricsDetailed,
          extraParts: (() => {
            const parts = [
              ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
              ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
            ]
            return parts.length > 0 ? parts : null
          })(),
          color: verboseColor,
        })
      }
      return
    }

    const promptTokens = countTokens(prompt)

    const kindForAuto = isYouTube ? ('youtube' as const) : ('website' as const)
    const attempts: ModelAttempt[] = await (async () => {
      if (isFallbackModel) {
        const catalog = await getLiteLlmCatalog()
        const list = buildAutoModelAttempts({
          kind: kindForAuto,
          promptTokens,
          desiredOutputTokens,
          requiresVideoUnderstanding: false,
          env: envForAuto,
          config: configForModelSelection,
          catalog,
          openrouterProvidersFromEnv: null,
          cliAvailability,
        })
        if (verbose) {
          for (const a of list.slice(0, 8)) {
            writeVerbose(stderr, verbose, `auto candidate ${a.debug}`, verboseColor)
          }
        }
        return list.map((attempt) => {
          if (attempt.transport !== 'cli') return applyZaiOverrides(attempt as ModelAttempt)
          const parsed = parseCliUserModelId(attempt.userModelId)
          return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
        })
      }
      /* v8 ignore next */
      if (!fixedModelSpec) {
        throw new Error('Internal error: missing fixed model spec')
      }
      if (fixedModelSpec.transport === 'cli') {
        return [
          {
            transport: 'cli',
            userModelId: fixedModelSpec.userModelId,
            llmModelId: null,
            cliProvider: fixedModelSpec.cliProvider,
            cliModel: fixedModelSpec.cliModel,
            openrouterProviders: null,
            forceOpenRouter: false,
            requiredEnv: fixedModelSpec.requiredEnv,
          },
        ]
      }
      const openaiOverrides =
        fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
          ? {
              openaiApiKeyOverride: zaiApiKey,
              openaiBaseUrlOverride: zaiBaseUrl,
              forceChatCompletions: true,
            }
          : {}
      return [
        {
          transport: fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
          userModelId: fixedModelSpec.userModelId,
          llmModelId: fixedModelSpec.llmModelId,
          openrouterProviders: fixedModelSpec.openrouterProviders,
          forceOpenRouter: fixedModelSpec.forceOpenRouter,
          requiredEnv: fixedModelSpec.requiredEnv,
          ...openaiOverrides,
        },
      ]
    })()

    const onModelChosen = (modelId: string) => {
      if (!progressEnabled) return
      spinner.setText(
        `Summarizing (sent ${extractedContentSize}${viaSourceLabel}, model: ${modelId})…`
      )
    }

    const attemptOutcome = await runModelAttempts({
      attempts,
      isFallbackModel,
      isNamedModelSelection,
      envHasKeyFor,
      formatMissingModelError,
      onAutoSkip: (attempt) => {
        writeVerbose(
          stderr,
          verbose,
          `auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`,
          verboseColor
        )
      },
      onAutoFailure: (attempt, error) => {
        writeVerbose(
          stderr,
          verbose,
          `auto failed ${attempt.userModelId}: ${error instanceof Error ? error.message : String(error)}`,
          verboseColor
        )
      },
      onFixedModelError: (_attempt, error) => {
        throw error
      },
      runAttempt: (attempt) =>
        runSummaryAttempt({
          attempt,
          prompt,
          allowStreaming: streamingEnabled,
          onModelChosen,
        }),
    })
    const summaryResult = attemptOutcome.result
    const usedAttempt = attemptOutcome.usedAttempt
    const { lastError, missingRequiredEnvs, sawOpenRouterNoAllowedProviders } = attemptOutcome

    if (!summaryResult || !usedAttempt) {
      const withFreeTip = (message: string) => {
        if (!isNamedModelSelection || !wantsFreeNamedModel) return message
        return (
          `${message}\n` +
          `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
        )
      }

      if (isNamedModelSelection) {
        if (lastError === null && missingRequiredEnvs.size > 0) {
          throw new Error(
            withFreeTip(
              `Missing ${Array.from(missingRequiredEnvs).sort().join(', ')} for --model ${requestedModelInput}.`
            )
          )
        }
        if (lastError instanceof Error) {
          if (sawOpenRouterNoAllowedProviders) {
            const message = await buildOpenRouterNoAllowedProvidersMessage({
              attempts,
              fetchImpl: trackedFetch,
              timeoutMs,
            })
            throw new Error(withFreeTip(message), { cause: lastError })
          }
          throw new Error(withFreeTip(lastError.message), { cause: lastError })
        }
        throw new Error(withFreeTip(`No model available for --model ${requestedModelInput}`))
      }
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
            format,
            markdown: effectiveMarkdownMode,
            length:
              lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: lengthArg.preset }
                : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
            maxOutputTokens: maxOutputTokensArg,
            model: requestedModelLabel,
            language: formatOutputLanguageForJson(outputLanguage),
          },
          env: {
            hasXaiKey: Boolean(xaiApiKey),
            hasOpenAIKey: Boolean(apiKey),
            hasOpenRouterKey: Boolean(openrouterApiKey),
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
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        return
      }
      stdout.write(`${extracted.content}\n`)
      if (footerBaseParts.length > 0) {
        writeViaFooter([...footerBaseParts, 'no model'])
      }
      if (lastError instanceof Error && verbose) {
        writeVerbose(stderr, verbose, `auto failed all models: ${lastError.message}`, verboseColor)
      }
      return
    }

    const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

    if (json) {
      const finishReport = shouldComputeReport ? await buildReport() : null
      const payload: JsonOutput = {
        input: {
          kind: 'url',
          url,
          timeoutMs,
          youtube: youtubeMode,
          firecrawl: firecrawlMode,
          format,
          markdown: effectiveMarkdownMode,
          length:
            lengthArg.kind === 'preset'
              ? { kind: 'preset', preset: lengthArg.preset }
              : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
          maxOutputTokens: maxOutputTokensArg,
          model: requestedModelLabel,
          language: formatOutputLanguageForJson(outputLanguage),
        },
        env: {
          hasXaiKey: Boolean(xaiApiKey),
          hasOpenAIKey: Boolean(apiKey),
          hasOpenRouterKey: Boolean(openrouterApiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
          hasGoogleKey: googleConfigured,
          hasAnthropicKey: anthropicConfigured,
        },
        extracted,
        prompt,
        llm: {
          provider: modelMeta.provider,
          model: usedAttempt.userModelId,
          maxCompletionTokens: maxOutputTokensForCall,
          strategy: 'single',
        },
        metrics: metricsEnabled ? finishReport : null,
        summary,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (metricsEnabled && finishReport) {
        const costUsd = await estimateCostUsd()
        writeFinishLine({
          stderr,
          elapsedMs: Date.now() - runStartedAtMs,
          label: finishSourceLabel,
          model: usedAttempt.userModelId,
          report: finishReport,
          costUsd,
          detailed: metricsDetailed,
          extraParts: (() => {
            const parts = [
              ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
              ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
            ]
            return parts.length > 0 ? parts : null
          })(),
          color: verboseColor,
        })
      }
      return
    }

    if (!summaryAlreadyPrinted) {
      clearProgressForStdout()
      const rendered =
        (effectiveRenderMode === 'md' || effectiveRenderMode === 'md-live') && isRichTty(stdout)
          ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
              width: markdownRenderWidth(stdout, env),
              wrap: true,
              color: supportsColor(stdout, envForRun),
              hyperlinks: true,
            })
          : summary

      stdout.write(rendered)
      if (!rendered.endsWith('\n')) {
        stdout.write('\n')
      }
    }

    const report = shouldComputeReport ? await buildReport() : null
    if (metricsEnabled && report) {
      const costUsd = await estimateCostUsd()
      writeFinishLine({
        stderr,
        elapsedMs: Date.now() - runStartedAtMs,
        label: finishSourceLabel,
        model: modelMeta.canonical,
        report,
        costUsd,
        detailed: metricsDetailed,
        extraParts: (() => {
          const parts = [
            ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
            ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
          ]
          return parts.length > 0 ? parts : null
        })(),
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
