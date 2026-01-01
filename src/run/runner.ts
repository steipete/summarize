import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { CommanderError } from 'commander'
import {
  type CacheState,
  clearCacheFiles,
  DEFAULT_CACHE_MAX_MB,
  resolveCachePath,
} from '../cache.js'
import { loadSummarizeConfig } from '../config.js'
import { parseExtractFormat, parseMetricsMode, parseStreamMode } from '../flags.js'
import type { ExecFileFn } from '../markitdown.js'
import type { FixedModelSpec } from '../model-spec.js'
import { formatVersionLine } from '../version.js'
import { createCacheStateFromConfig } from './cache-state.js'
import {
  handleDaemonCliRequest,
  handleHelpRequest,
  handleRefreshFreeRequest,
} from './cli-preflight.js'
import { parseCliProviderArg } from './env.js'
import { handleFileInput, handleUrlAsset } from './flows/asset/input.js'
import { summarizeAsset as summarizeAssetFlow } from './flows/asset/summary.js'
import { runUrlFlow } from './flows/url/flow.js'
import { attachRichHelp, buildProgram } from './help.js'
import { createProgressGate } from './progress.js'
import { resolveRunContextState } from './run-context.js'
import { resolveRunInput } from './run-input.js'
import { createRunMetrics } from './run-metrics.js'
import { resolveModelSelection } from './run-models.js'
import { resolveDesiredOutputTokens } from './run-output.js'
import { resolveCliRunSettings } from './run-settings.js'
import { resolveStreamSettings } from './run-stream.js'
import { createSummaryEngine } from './summary-engine.js'
import { ansi, isRichTty, supportsColor } from './terminal.js'

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
      text = await readFile(promptFileArg, 'utf8')
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
  const extractMode = Boolean(program.opts().extract) || Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const transcriptTimestamps = Boolean(program.opts().timestamps)
  const streamMode = parseStreamMode(program.opts().stream as string)
  const plain = Boolean(program.opts().plain)
  const debug = Boolean(program.opts().debug)
  const verbose = Boolean(program.opts().verbose) || debug

  const normalizeTranscriber = (value: unknown): 'whisper' | 'parakeet' | 'canary' | null => {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (normalized === 'whisper' || normalized === 'parakeet' || normalized === 'canary')
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
    'whisper'
  ;(envForRun as Record<string, string | undefined>).SUMMARIZE_TRANSCRIBER = transcriber

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
  if (!promptOverride && typeof config?.prompt === 'string' && config.prompt.trim().length > 0) {
    promptOverride = config.prompt.trim()
  }
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
    noCacheFlag,
    transcriptNamespace,
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
    const { clearProgressForStdout, setClearProgressBeforeStdout, clearProgressIfCurrent } =
      progressGate

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
      stderr.write(`${ansi('2', `via ${filtered.join(', ')}`, verboseColor)}\n`)
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
      lengthArg,
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
      getLiteLlmCatalog,
      buildReport,
      estimateCostUsd,
      llmCalls,
      cache: cacheState,
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

    const assetInputContext = {
      env,
      envForRun,
      stdout,
      stderr,
      progressEnabled,
      timeoutMs,
      trackedFetch,
      execFileImpl,
      preprocessMode,
      format,
      extractMode,
      plain,
      json,
      metricsEnabled,
      metricsDetailed,
      shouldComputeReport,
      runStartedAtMs,
      verboseColor,
      buildReport,
      estimateCostUsd,
      apiStatus: {
        xaiApiKey,
        apiKey,
        openrouterApiKey,
        apifyToken,
        firecrawlConfigured,
        googleConfigured,
        anthropicConfigured,
      },
      summarizeAsset,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    }

    if (await handleFileInput(assetInputContext, inputTarget)) {
      return
    }
    if (url && (await handleUrlAsset(assetInputContext, url, isYoutubeUrl))) {
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
        maxExtractCharacters: null,
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
        promptOverride,
        lengthInstruction,
        languageInstruction,
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
        streamingEnabled,
        plain,
        configPath,
        configModelLabel,
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
          falApiKey,
          openaiTranscriptionKey,
        },
        summaryEngine,
        getLiteLlmCatalog,
        llmCalls,
      },
      cache: cacheState,
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        setTranscriptionCost,
        summarizeAsset,
        writeViaFooter,
        clearProgressForStdout,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
        buildReport,
        estimateCostUsd,
      },
    }

    await runUrlFlow({ ctx: urlFlowContext, url, isYoutubeUrl })
  } finally {
    cacheState.store?.close()
  }
}
