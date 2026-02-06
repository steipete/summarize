import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CommanderError } from 'commander'
import {
  type CacheState,
  clearCacheFiles,
  DEFAULT_CACHE_MAX_MB,
  resolveCachePath,
} from '../cache.js'
import { loadSummarizeConfig } from '../config.js'
import type { InputTarget } from '../content/asset.js'
import {
  parseExtractFormat,
  parseMaxExtractCharactersArg,
  parseMetricsMode,
  parseStreamMode,
} from '../flags.js'
import type { ExecFileFn } from '../markitdown.js'
import type { FixedModelSpec } from '../model-spec.js'
import { resolveSlideSettings } from '../slides/index.js'
import { createThemeRenderer, resolveThemeNameFromSources, resolveTrueColor } from '../tty/theme.js'
import { formatVersionLine } from '../version.js'
import { createCacheStateFromConfig } from './cache-state.js'
import {
  handleDaemonCliRequest,
  handleHelpRequest,
  handleRefreshFreeRequest,
} from './cli-preflight.js'
import { parseCliProviderArg } from './env.js'
import { extractAssetContent } from './flows/asset/extract.js'
import { handleFileInput, withUrlAsset } from './flows/asset/input.js'
import { summarizeMediaFile as summarizeMediaFileImpl } from './flows/asset/media.js'
import { outputExtractedAsset } from './flows/asset/output.js'
import { summarizeAsset as summarizeAssetFlow } from './flows/asset/summary.js'
import { runUrlFlow } from './flows/url/flow.js'
import { attachRichHelp, buildProgram } from './help.js'
import { createMediaCacheFromConfig } from './media-cache-state.js'
import { createProgressGate } from './progress.js'
import { resolveRunContextState } from './run-context.js'
import { resolveRunInput } from './run-input.js'
import { createRunMetrics } from './run-metrics.js'
import { resolveModelSelection } from './run-models.js'
import { resolveDesiredOutputTokens } from './run-output.js'
import { resolveCliRunSettings } from './run-settings.js'
import { resolveStreamSettings } from './run-stream.js'
import { handleSlidesCliRequest } from './slides-cli.js'
import { createSummaryEngine } from './summary-engine.js'
import { isRichTty, supportsColor } from './terminal.js'
import { handleTranscriberCliRequest } from './transcriber-cli.js'

async function streamToString(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    totalSize += buffer.length
    if (totalSize > maxBytes) {
      throw new Error(
        `Stdin content exceeds maximum size of ${(maxBytes / 1024 / 1024).toFixed(1)}MB`
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  execFile?: ExecFileFn
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export async function runCli(
  argv: string[],
  { env, fetch, execFile: execFileOverride, stdout, stderr }: RunEnv
): Promise<void> {
  ;(globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

  const normalizedArgv = argv.filter((arg) => arg !== '--')
  const noColorFlag = normalizedArgv.includes('--no-color')
  const envForRun = noColorFlag ? { ...env, NO_COLOR: '1', FORCE_COLOR: '0' } : env

  if (handleHelpRequest({ normalizedArgv, envForRun, stdout, stderr })) {
    return
  }
  if (
    await handleRefreshFreeRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return
  }
  if (
    await handleDaemonCliRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return
  }
  if (
    await handleSlidesCliRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return
  }
  if (
    await handleTranscriberCliRequest({
      normalizedArgv,
      envForRun,
      stdout,
      stderr,
    })
  ) {
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

  const promptArg = typeof program.opts().prompt === 'string' ? program.opts().prompt : null
  const promptFileArg =
    typeof program.opts().promptFile === 'string' ? program.opts().promptFile : null
  if (promptArg && promptFileArg) {
    throw new Error('Use either --prompt or --prompt-file (not both).')
  }
  let promptOverride: string | null = null
  if (promptFileArg) {
    let text: string
    try {
      text = await fs.readFile(promptFileArg, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to read --prompt-file ${promptFileArg}: ${message}`)
    }
    const trimmed = text.trim()
    if (!trimmed) {
      throw new Error(`Prompt file ${promptFileArg} is empty.`)
    }
    promptOverride = trimmed
  } else if (promptArg) {
    const trimmed = promptArg.trim()
    if (!trimmed) {
      throw new Error('Prompt must not be empty.')
    }
    promptOverride = trimmed
  }

  const clearCacheFlag = normalizedArgv.includes('--clear-cache')
  if (clearCacheFlag) {
    const extraArgs = normalizedArgv.filter((arg) => arg !== '--clear-cache')
    if (extraArgs.length > 0) {
      throw new Error('--clear-cache must be used alone.')
    }
    const { config } = loadSummarizeConfig({ env: envForRun })
    const cachePath = resolveCachePath({
      env: envForRun,
      cachePath: config?.cache?.path ?? null,
    })
    if (!cachePath) {
      throw new Error('Unable to resolve cache path (missing HOME).')
    }
    clearCacheFiles(cachePath)
    stdout.write('Cache cleared.\n')
    return
  }

  const cacheStatsFlag = normalizedArgv.includes('--cache-stats')
  if (cacheStatsFlag) {
    const extraArgs = normalizedArgv.filter((arg) => arg !== '--cache-stats')
    if (extraArgs.length > 0) {
      throw new Error('--cache-stats must be used alone.')
    }
    const { config } = loadSummarizeConfig({ env: envForRun })
    const cachePath = resolveCachePath({
      env: envForRun,
      cachePath: config?.cache?.path ?? null,
    })
    if (!cachePath) {
      throw new Error('Unable to resolve cache path (missing HOME).')
    }
    const cacheMaxMb =
      typeof config?.cache?.maxMb === 'number' ? config.cache.maxMb : DEFAULT_CACHE_MAX_MB
    const cacheMaxBytes = Math.max(0, cacheMaxMb) * 1024 * 1024
    const { readCacheStats } = await import('../cache.js')
    const { formatBytes } = await import('../tty/format.js')
    const stats = await readCacheStats(cachePath)
    stdout.write(`Cache path: ${cachePath}\n`)
    if (!stats) {
      stdout.write('Cache is empty.\n')
      return
    }
    const sizeLabel = formatBytes(stats.sizeBytes)
    const maxLabel = cacheMaxBytes > 0 ? formatBytes(cacheMaxBytes) : 'disabled'
    stdout.write(`Size: ${sizeLabel} (max ${maxLabel})\n`)
    stdout.write(
      `Entries: total=${stats.totalEntries} extract=${stats.counts.extract} summary=${stats.counts.summary} transcript=${stats.counts.transcript}\n`
    )
    return
  }

  const cliFlagPresent = normalizedArgv.some((arg) => arg === '--cli' || arg.startsWith('--cli='))
  let cliProviderArgRaw = typeof program.opts().cli === 'string' ? program.opts().cli : null
  const inputResolution = resolveRunInput({
    program,
    cliFlagPresent,
    cliProviderArgRaw,
    stdout,
  })
  cliProviderArgRaw = inputResolution.cliProviderArgRaw
  const inputTarget = inputResolution.inputTarget
  const url = inputResolution.url

  const runStartedAtMs = Date.now()

  const videoModeExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--video-mode' || arg.startsWith('--video-mode=')
  )
  const lengthExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--length' || arg.startsWith('--length=')
  )
  const languageExplicitlySet = normalizedArgv.some(
    (arg) =>
      arg === '--language' ||
      arg.startsWith('--language=') ||
      arg === '--lang' ||
      arg.startsWith('--lang=')
  )
  const noCacheFlag = program.opts().cache === false
  const noMediaCacheFlag = program.opts().mediaCache === false
  const extractMode = Boolean(program.opts().extract) || Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const forceSummary = Boolean(program.opts().forceSummary)
  const slidesDebug = Boolean(program.opts().slidesDebug)
  const streamMode = parseStreamMode(program.opts().stream as string)
  const plain = Boolean(program.opts().plain)
  const debug = Boolean(program.opts().debug)
  const verbose = Boolean(program.opts().verbose) || debug

  const normalizeTranscriber = (
    value: unknown
  ): 'auto' | 'whisper' | 'parakeet' | 'canary' | null => {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (
      normalized === 'auto' ||
      normalized === 'whisper' ||
      normalized === 'parakeet' ||
      normalized === 'canary'
    )
      return normalized
    return null
  }

  const transcriberExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--transcriber' || arg.startsWith('--transcriber=')
  )
  const envTranscriber =
    (envForRun as Record<string, string | undefined>)?.SUMMARIZE_TRANSCRIBER ??
    process.env.SUMMARIZE_TRANSCRIBER ??
    null
  const transcriber =
    normalizeTranscriber(transcriberExplicitlySet ? program.opts().transcriber : envTranscriber) ??
    'auto'
  ;(envForRun as Record<string, string | undefined>).SUMMARIZE_TRANSCRIBER = transcriber

  const maxExtractCharacters = parseMaxExtractCharactersArg(
    typeof program.opts().maxExtractCharacters === 'string'
      ? (program.opts().maxExtractCharacters as string)
      : program.opts().maxExtractCharacters != null
        ? String(program.opts().maxExtractCharacters)
        : undefined
  )

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

  const runSettings = resolveCliRunSettings({
    length: String(program.opts().length),
    firecrawl: String(program.opts().firecrawl),
    markdownMode:
      typeof program.opts().markdownMode === 'string' ? program.opts().markdownMode : undefined,
    markdown: typeof program.opts().markdown === 'string' ? program.opts().markdown : undefined,
    format,
    preprocess: String(program.opts().preprocess),
    youtube: String(program.opts().youtube),
    timeout: String(program.opts().timeout),
    retries: String(program.opts().retries),
    maxOutputTokens:
      typeof program.opts().maxOutputTokens === 'string'
        ? program.opts().maxOutputTokens
        : program.opts().maxOutputTokens != null
          ? String(program.opts().maxOutputTokens)
          : undefined,
  })
  const {
    youtubeMode,
    lengthArg,
    maxOutputTokensArg,
    timeoutMs,
    retries,
    preprocessMode,
    firecrawlMode: requestedFirecrawlMode,
    markdownMode,
  } = runSettings

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
  const shouldComputeReport = metricsEnabled

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

  const {
    config,
    configPath,
    outputLanguage,
    openaiWhisperUsdPerMinute,
    videoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    configModelLabel,
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    providerBaseUrls,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    apifyToken,
    ytDlpPath,
    ytDlpCookiesFromBrowser,
    falApiKey,
    cliAvailability,
    envForAuto,
  } = resolveRunContextState({
    env,
    envForRun,
    programOpts: program.opts() as Record<string, unknown>,
    languageExplicitlySet,
    videoModeExplicitlySet,
    cliFlagPresent,
    cliProviderArg,
  })
  const themeName = resolveThemeNameFromSources({
    cli: (program.opts() as { theme?: unknown }).theme,
    env: envForRun.SUMMARIZE_THEME,
    config: config?.ui?.theme,
  })
  ;(envForRun as Record<string, string | undefined>).SUMMARIZE_THEME = themeName
  if (!promptOverride && typeof config?.prompt === 'string' && config.prompt.trim().length > 0) {
    promptOverride = config.prompt.trim()
  }

  const slidesExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides' || arg === '--no-slides' || arg.startsWith('--slides=')
  )
  const slidesOcrExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides-ocr' || arg === '--no-slides-ocr' || arg.startsWith('--slides-ocr=')
  )
  const slidesDirExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides-dir' || arg.startsWith('--slides-dir=')
  )
  const slidesSceneThresholdExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides-scene-threshold' || arg.startsWith('--slides-scene-threshold=')
  )
  const slidesMaxExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides-max' || arg.startsWith('--slides-max=')
  )
  const slidesMinDurationExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--slides-min-duration' || arg.startsWith('--slides-min-duration=')
  )
  const slidesConfig = config?.slides
  const slidesSettings = resolveSlideSettings({
    slides: slidesExplicitlySet
      ? program.opts().slides
      : (slidesConfig?.enabled ?? program.opts().slides),
    slidesOcr: slidesOcrExplicitlySet
      ? program.opts().slidesOcr
      : (slidesConfig?.ocr ?? program.opts().slidesOcr),
    slidesDir: slidesDirExplicitlySet
      ? program.opts().slidesDir
      : (slidesConfig?.dir ?? program.opts().slidesDir),
    slidesSceneThreshold: slidesSceneThresholdExplicitlySet
      ? program.opts().slidesSceneThreshold
      : (slidesConfig?.sceneThreshold ?? program.opts().slidesSceneThreshold),
    slidesSceneThresholdExplicit:
      slidesSceneThresholdExplicitlySet || typeof slidesConfig?.sceneThreshold === 'number',
    slidesMax: slidesMaxExplicitlySet
      ? program.opts().slidesMax
      : (slidesConfig?.max ?? program.opts().slidesMax),
    slidesMinDuration: slidesMinDurationExplicitlySet
      ? program.opts().slidesMinDuration
      : (slidesConfig?.minDuration ?? program.opts().slidesMinDuration),
    cwd: process.cwd(),
  })
  if (slidesSettings && inputTarget.kind !== 'url') {
    throw new Error('--slides is only supported for URL inputs')
  }
  const transcriptTimestamps = Boolean(program.opts().timestamps) || Boolean(slidesSettings)

  const lengthInstruction =
    promptOverride && lengthExplicitlySet && lengthArg.kind === 'chars'
      ? `Output is ${lengthArg.maxCharacters.toLocaleString()} characters.`
      : null
  const languageInstruction =
    promptOverride && languageExplicitlySet && outputLanguage.kind === 'fixed'
      ? `Output should be ${outputLanguage.label}.`
      : null

  const transcriptNamespace = `yt:${youtubeMode}`
  const cacheState: CacheState = await createCacheStateFromConfig({
    envForRun,
    config,
    noCacheFlag: false,
    transcriptNamespace,
  })
  const mediaCache = await createMediaCacheFromConfig({
    envForRun,
    config,
    noMediaCacheFlag,
  })

  try {
    if (markdownModeExplicitlySet && format !== 'markdown') {
      throw new Error('--markdown-mode is only supported with --format md')
    }
    if (markdownModeExplicitlySet && inputTarget.kind !== 'url') {
      throw new Error('--markdown-mode is only supported for URL inputs')
    }
    const metrics = createRunMetrics({
      env,
      fetchImpl: fetch,
      maxOutputTokensArg,
    })
    const {
      llmCalls,
      trackedFetch,
      buildReport,
      estimateCostUsd,
      getLiteLlmCatalog,
      resolveMaxOutputTokensForCall,
      resolveMaxInputTokensForCall,
      setTranscriptionCost,
    } = metrics

    const {
      requestedModel,
      requestedModelInput,
      requestedModelLabel,
      isNamedModelSelection,
      wantsFreeNamedModel,
      configForModelSelection,
      isFallbackModel,
    } = resolveModelSelection({
      config,
      configForCli,
      configPath,
      envForRun,
      explicitModelArg,
    })

    const verboseColor = supportsColor(stderr, envForRun)
    const themeForStderr = createThemeRenderer({
      themeName,
      enabled: verboseColor,
      trueColor: resolveTrueColor(envForRun),
    })
    const renderSpinnerStatus = (label: string, detail = '…') =>
      `${themeForStderr.label(label)}${themeForStderr.dim(detail)}`
    const renderSpinnerStatusWithModel = (label: string, modelId: string) =>
      `${themeForStderr.label(label)}${themeForStderr.dim(' (model: ')}${themeForStderr.accent(
        modelId
      )}${themeForStderr.dim(')…')}`
    const { streamingEnabled } = resolveStreamSettings({
      streamMode,
      stdout,
      json,
      extractMode,
    })

    if (extractMode && inputTarget.kind !== 'url') {
      throw new Error('--extract is only supported for website/YouTube URLs')
    }

    // Progress UI (spinner + OSC progress) is shown on stderr. Before writing to stdout (including
    // streaming output), we stop + clear progress via the progress gate to keep scrollback clean.
    const progressEnabled = isRichTty(stderr) && !verbose && !json
    const progressGate = createProgressGate()
    const {
      clearProgressForStdout,
      restoreProgressAfterStdout,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    } = progressGate

    const fixedModelSpec: FixedModelSpec | null =
      requestedModel.kind === 'fixed' ? requestedModel : null

    const desiredOutputTokens = resolveDesiredOutputTokens({ lengthArg, maxOutputTokensArg })

    const summaryEngine = createSummaryEngine({
      env,
      envForRun,
      stdout,
      stderr,
      execFileImpl,
      timeoutMs,
      retries,
      streamingEnabled,
      plain,
      verbose,
      verboseColor,
      openaiUseChatCompletions,
      cliConfigForRun: cliConfigForRun ?? null,
      cliAvailability,
      trackedFetch,
      resolveMaxOutputTokensForCall,
      resolveMaxInputTokensForCall,
      llmCalls,
      clearProgressForStdout,
      restoreProgressAfterStdout,
      apiKeys: {
        xaiApiKey,
        openaiApiKey: apiKey,
        googleApiKey,
        anthropicApiKey,
        openrouterApiKey,
      },
      keyFlags: {
        googleConfigured,
        anthropicConfigured,
        openrouterConfigured,
      },
      zai: {
        apiKey: zaiApiKey,
        baseUrl: zaiBaseUrl,
      },
      providerBaseUrls,
    })
    const writeViaFooter = (parts: string[]) => {
      if (json) return
      if (extractMode) return
      const filtered = parts.map((p) => p.trim()).filter(Boolean)
      if (filtered.length === 0) return
      clearProgressForStdout()
      stderr.write(`${themeForStderr.dim(`via ${filtered.join(', ')}`)}\n`)
      restoreProgressAfterStdout?.()
    }
    const assetSummaryContext = {
      env,
      envForRun,
      stdout,
      stderr,
      execFileImpl,
      timeoutMs,
      preprocessMode,
      format,
      extractMode,
      lengthArg,
      forceSummary,
      outputLanguage,
      videoMode,
      fixedModelSpec,
      promptOverride,
      lengthInstruction,
      languageInstruction,
      isFallbackModel,
      desiredOutputTokens,
      envForAuto,
      configForModelSelection,
      cliAvailability,
      requestedModel,
      requestedModelInput,
      requestedModelLabel,
      wantsFreeNamedModel,
      isNamedModelSelection,
      maxOutputTokensArg,
      json,
      metricsEnabled,
      metricsDetailed,
      shouldComputeReport,
      runStartedAtMs,
      verbose,
      verboseColor,
      streamingEnabled,
      plain,
      summaryEngine,
      trackedFetch,
      writeViaFooter,
      clearProgressForStdout,
      restoreProgressAfterStdout,
      getLiteLlmCatalog,
      buildReport,
      estimateCostUsd,
      llmCalls,
      cache: cacheState,
      summaryCacheBypass: noCacheFlag,
      mediaCache,
      apiStatus: {
        xaiApiKey,
        apiKey,
        openrouterApiKey,
        apifyToken,
        firecrawlConfigured,
        googleConfigured,
        anthropicConfigured,
        providerBaseUrls,
        zaiApiKey,
        zaiBaseUrl,
      },
    }

    const summarizeAsset = (args: Parameters<typeof summarizeAssetFlow>[1]) =>
      summarizeAssetFlow(assetSummaryContext, args)

    const summarizeMediaFile = (args: Parameters<typeof summarizeMediaFileImpl>[1]) =>
      summarizeMediaFileImpl(assetSummaryContext, args)

    const assetInputContext = {
      env,
      envForRun,
      stderr,
      progressEnabled,
      timeoutMs,
      trackedFetch,
      summarizeAsset,
      summarizeMediaFile,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    }

    if (inputTarget.kind === 'stdin') {
      const tempPath = path.join(os.tmpdir(), `summarize-stdin-${Date.now()}.txt`)
      const MAX_STDIN_BYTES = 50 * 1024 * 1024 // 50MB limit
      try {
        const stdinContent = await streamToString(process.stdin, MAX_STDIN_BYTES)
        if (!stdinContent.trim()) {
          throw new Error('Stdin is empty')
        }
        await fs.writeFile(tempPath, stdinContent, 'utf8')
        const stdinInputTarget: InputTarget = { kind: 'file', filePath: tempPath }
        if (await handleFileInput(assetInputContext, stdinInputTarget)) {
          return
        }
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => {})
      }
    }

    if (await handleFileInput(assetInputContext, inputTarget)) {
      return
    }
    if (
      url &&
      (await withUrlAsset(assetInputContext, url, isYoutubeUrl, async ({ loaded, spinner }) => {
        if (extractMode) {
          if (progressEnabled) spinner.setText(renderSpinnerStatus('Extracting text'))
          const extracted = await extractAssetContent({
            ctx: {
              env,
              envForRun,
              execFileImpl,
              timeoutMs,
              preprocessMode,
            },
            attachment: loaded.attachment,
          })
          await outputExtractedAsset({
            io: { env, envForRun, stdout, stderr },
            flags: {
              timeoutMs,
              preprocessMode,
              format,
              plain,
              json,
              metricsEnabled,
              metricsDetailed,
              shouldComputeReport,
              runStartedAtMs,
              verboseColor,
            },
            hooks: {
              clearProgressForStdout,
              restoreProgressAfterStdout,
              buildReport,
              estimateCostUsd,
            },
            url,
            sourceLabel: loaded.sourceLabel,
            attachment: loaded.attachment,
            extracted,
            apiStatus: {
              xaiApiKey,
              apiKey,
              openrouterApiKey,
              apifyToken,
              firecrawlConfigured,
              googleConfigured,
              anthropicConfigured,
            },
          })
          return
        }

        if (progressEnabled) spinner.setText(renderSpinnerStatus('Summarizing'))
        await summarizeAsset({
          sourceKind: 'asset-url',
          sourceLabel: loaded.sourceLabel,
          attachment: loaded.attachment,
          onModelChosen: (modelId) => {
            if (!progressEnabled) return
            spinner.setText(renderSpinnerStatusWithModel('Summarizing', modelId))
          },
        })
      }))
    ) {
      return
    }

    if (!url) {
      throw new Error('Only HTTP and HTTPS URLs can be summarized')
    }

    const urlFlowContext = {
      io: {
        env,
        envForRun,
        stdout,
        stderr,
        execFileImpl,
        fetch: trackedFetch,
      },
      flags: {
        timeoutMs,
        maxExtractCharacters: extractMode ? maxExtractCharacters : null,
        retries,
        format,
        markdownMode,
        preprocessMode,
        youtubeMode,
        firecrawlMode: requestedFirecrawlMode,
        videoMode,
        transcriptTimestamps,
        outputLanguage,
        lengthArg,
        forceSummary,
        promptOverride,
        lengthInstruction,
        languageInstruction,
        summaryCacheBypass: noCacheFlag,
        maxOutputTokensArg,
        json,
        extractMode,
        metricsEnabled,
        metricsDetailed,
        shouldComputeReport,
        runStartedAtMs,
        verbose,
        verboseColor,
        progressEnabled,
        streamMode,
        streamingEnabled,
        plain,
        configPath,
        configModelLabel,
        slides: slidesSettings,
        slidesDebug,
        slidesOutput: true,
      },
      model: {
        requestedModel,
        requestedModelInput,
        requestedModelLabel,
        fixedModelSpec,
        isFallbackModel,
        isNamedModelSelection,
        wantsFreeNamedModel,
        desiredOutputTokens,
        configForModelSelection,
        envForAuto,
        cliAvailability,
        openaiUseChatCompletions,
        openaiWhisperUsdPerMinute,
        apiStatus: {
          xaiApiKey,
          apiKey,
          openrouterApiKey,
          openrouterConfigured,
          googleApiKey,
          googleConfigured,
          anthropicApiKey,
          anthropicConfigured,
          providerBaseUrls,
          zaiApiKey,
          zaiBaseUrl,
          firecrawlConfigured,
          firecrawlApiKey,
          apifyToken,
          ytDlpPath,
          ytDlpCookiesFromBrowser,
          falApiKey,
          openaiTranscriptionKey,
        },
        summaryEngine,
        getLiteLlmCatalog,
        llmCalls,
      },
      cache: cacheState,
      mediaCache,
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        setTranscriptionCost,
        summarizeAsset,
        writeViaFooter,
        clearProgressForStdout,
        restoreProgressAfterStdout,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
        buildReport,
        estimateCostUsd,
        onSlideChunk: undefined,
        onSlidesDone: null,
      },
    }

    await runUrlFlow({ ctx: urlFlowContext, url, isYoutubeUrl })
  } finally {
    cacheState.store?.close()
  }
}
