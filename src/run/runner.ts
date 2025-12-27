import { execFile } from 'node:child_process'
import { CommanderError } from 'commander'
import {
  parseDurationMs,
  parseExtractFormat,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parsePreprocessMode,
  parseRetriesArg,
  parseStreamMode,
  parseYoutubeMode,
} from '../flags.js'
import type { ExecFileFn } from '../markitdown.js'
import type { FixedModelSpec } from '../model-spec.js'
import { formatVersionLine } from '../version.js'
import { handleHelpRequest, handleRefreshFreeRequest } from './cli-preflight.js'
import { parseCliProviderArg } from './env.js'
import { handleFileInput, handleUrlAsset } from './flows/asset/input.js'
import { summarizeAsset as summarizeAssetFlow } from './flows/asset/summary.js'
import { runUrlFlow } from './flows/url/flow.js'
import { attachRichHelp, buildProgram } from './help.js'
import { createProgressGate } from './progress.js'
import { resolveConfigState } from './run-config.js'
import { resolveEnvState } from './run-env.js'
import { resolveRunInput } from './run-input.js'
import { createRunMetrics } from './run-metrics.js'
import { resolveModelSelection } from './run-models.js'
import { resolveDesiredOutputTokens } from './run-output.js'
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
  const plain = Boolean(program.opts().plain)
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
  } = resolveConfigState({
    envForRun,
    programOpts: program.opts() as Record<string, unknown>,
    languageExplicitlySet,
    videoModeExplicitlySet,
    cliFlagPresent,
    cliProviderArg,
  })
  const {
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    apifyToken,
    ytDlpPath,
    falApiKey,
    cliAvailability,
    envForAuto,
    providerBaseUrls,
  } = resolveEnvState({ env, envForRun, configForCli })
  if (markdownModeExplicitlySet && format !== 'markdown') {
    throw new Error('--markdown-mode is only supported with --format md')
  }
  if (markdownModeExplicitlySet && inputTarget.kind !== 'url') {
    throw new Error('--markdown-mode is only supported for website URLs')
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
    apiStatus: {
      xaiApiKey,
      apiKey,
      openrouterApiKey,
      apifyToken,
      firecrawlConfigured,
      googleConfigured,
      anthropicConfigured,
      zaiApiKey,
      zaiBaseUrl,
    },
  }

  const summarizeAsset = (args: Parameters<typeof summarizeAssetFlow>[1]) =>
    summarizeAssetFlow(assetSummaryContext, args)

  const assetInputContext = {
    env,
    stderr,
    progressEnabled,
    timeoutMs,
    trackedFetch,
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
    env,
    envForRun,
    stdout,
    stderr,
    execFileImpl,
    timeoutMs,
    retries,
    format,
    markdownMode,
    preprocessMode,
    youtubeMode,
    firecrawlMode: requestedFirecrawlMode,
    videoMode,
    outputLanguage,
    lengthArg,
    maxOutputTokensArg,
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
    openaiUseChatCompletions,
    configPath,
    configModelLabel,
    openaiWhisperUsdPerMinute,
    setTranscriptionCost,
    apiStatus: {
      xaiApiKey,
      apiKey,
      openrouterApiKey,
      openrouterConfigured,
      googleApiKey,
      googleConfigured,
      anthropicApiKey,
      anthropicConfigured,
      zaiApiKey,
      zaiBaseUrl,
      firecrawlConfigured,
      firecrawlApiKey,
      apifyToken,
      ytDlpPath,
      falApiKey,
      openaiTranscriptionKey,
      providerBaseUrls,
    },
    trackedFetch,
    summaryEngine,
    summarizeAsset,
    writeViaFooter,
    clearProgressForStdout,
    setClearProgressBeforeStdout,
    clearProgressIfCurrent,
    getLiteLlmCatalog,
    buildReport,
    estimateCostUsd,
    llmCalls,
  }

  await runUrlFlow({ ctx: urlFlowContext, url, isYoutubeUrl })
}
