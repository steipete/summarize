import path from 'node:path'
import { countTokens } from 'gpt-tokenizer'
import { render as renderMarkdownAnsi } from 'markdansi'
import {
  buildLanguageKey,
  buildLengthKey,
  buildPromptHash,
  buildSummaryCacheKey,
  type CacheState,
  extractTaggedBlock,
  hashString,
  normalizeContentForHash,
} from '../../../cache.js'
import type { CliProvider, SummarizeConfig } from '../../../config.js'
import type { LlmCall, RunMetricsReport } from '../../../costs.js'
import type { OutputLanguage } from '../../../language.js'
import { formatOutputLanguageForJson } from '../../../language.js'
import { parseGatewayStyleModelId } from '../../../llm/model-id.js'
import type { Prompt } from '../../../llm/prompt.js'
import type { ExecFileFn } from '../../../markitdown.js'
import { buildAutoModelAttempts } from '../../../model-auto.js'
import type { FixedModelSpec, RequestedModel } from '../../../model-spec.js'
import { buildPathSummaryPrompt, SUMMARY_LENGTH_TARGET_CHARACTERS } from '../../../prompts/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import {
  type AssetAttachment,
  ensureCliAttachmentPath,
  isUnsupportedAttachmentError,
} from '../../attachments.js'
import { parseCliUserModelId } from '../../env.js'
import { writeFinishLine } from '../../finish-line.js'
import { resolveTargetCharacters } from '../../format.js'
import { writeVerbose } from '../../logging.js'
import { prepareMarkdownForTerminal } from '../../markdown.js'
import { runModelAttempts } from '../../model-attempts.js'
import { buildOpenRouterNoAllowedProvidersMessage } from '../../openrouter.js'
import type { createSummaryEngine } from '../../summary-engine.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import type { ModelAttempt } from '../../types.js'
import { prepareAssetPrompt } from './preprocess.js'

const buildModelMetaFromAttempt = (attempt: ModelAttempt) => {
  if (attempt.transport === 'cli') {
    return { provider: 'cli' as const, canonical: attempt.userModelId }
  }
  const parsed = parseGatewayStyleModelId(attempt.llmModelId ?? attempt.userModelId)
  const canonical = attempt.userModelId.toLowerCase().startsWith('openrouter/')
    ? attempt.userModelId
    : parsed.canonical
  return { provider: parsed.provider, canonical }
}

function shouldBypassShortContentSummary({
  ctx,
  textContent,
}: {
  ctx: Pick<AssetSummaryContext, 'forceSummary' | 'lengthArg'>
  textContent: { content: string } | null
}): boolean {
  if (ctx.forceSummary) return false
  if (!textContent?.content) return false
  const targetCharacters = resolveTargetCharacters(
    ctx.lengthArg,
    SUMMARY_LENGTH_TARGET_CHARACTERS
  )
  if (!Number.isFinite(targetCharacters) || targetCharacters <= 0) return false
  return textContent.content.length <= targetCharacters
}

async function outputBypassedAssetSummary({
  ctx,
  args,
  promptText,
  summaryText,
  assetFooterParts,
  footerLabel,
}: {
  ctx: AssetSummaryContext
  args: SummarizeAssetArgs
  promptText: string
  summaryText: string
  assetFooterParts: string[]
  footerLabel: string
}) {
  const summary = summaryText.trimEnd()
  const extracted = {
    kind: 'asset' as const,
    source: args.sourceLabel,
    mediaType: args.attachment.mediaType,
    filename: args.attachment.filename,
  }

  if (ctx.json) {
    ctx.clearProgressForStdout()
    const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
    const input =
      args.sourceKind === 'file'
        ? {
            kind: 'file',
            filePath: args.sourceLabel,
            timeoutMs: ctx.timeoutMs,
            length:
              ctx.lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: ctx.lengthArg.preset }
                : { kind: 'chars', maxCharacters: ctx.lengthArg.maxCharacters },
            maxOutputTokens: ctx.maxOutputTokensArg,
            model: ctx.requestedModelLabel,
            language: formatOutputLanguageForJson(ctx.outputLanguage),
          }
        : {
            kind: 'asset-url',
            url: args.sourceLabel,
            timeoutMs: ctx.timeoutMs,
            length:
              ctx.lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: ctx.lengthArg.preset }
                : { kind: 'chars', maxCharacters: ctx.lengthArg.maxCharacters },
            maxOutputTokens: ctx.maxOutputTokensArg,
            model: ctx.requestedModelLabel,
            language: formatOutputLanguageForJson(ctx.outputLanguage),
          }
    const payload = {
      input,
      env: {
        hasXaiKey: Boolean(ctx.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(ctx.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(ctx.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(ctx.apiStatus.apifyToken),
        hasFirecrawlKey: ctx.apiStatus.firecrawlConfigured,
        hasGoogleKey: ctx.apiStatus.googleConfigured,
        hasAnthropicKey: ctx.apiStatus.anthropicConfigured,
      },
      extracted,
      prompt: promptText,
      llm: null,
      metrics: ctx.metricsEnabled ? finishReport : null,
      summary,
    }
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    ctx.restoreProgressAfterStdout?.()
    if (ctx.metricsEnabled && finishReport) {
      const costUsd = await ctx.estimateCostUsd()
      writeFinishLine({
        stderr: ctx.stderr,
        elapsedMs: Date.now() - ctx.runStartedAtMs,
        elapsedLabel: null,
        model: null,
        report: finishReport,
        costUsd,
        detailed: ctx.metricsDetailed,
        extraParts: null,
        color: ctx.verboseColor,
      })
    }
    return
  }

  ctx.clearProgressForStdout()
  const rendered =
    !ctx.plain && isRichTty(ctx.stdout)
      ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
          width: markdownRenderWidth(ctx.stdout, ctx.env),
          wrap: true,
          color: supportsColor(ctx.stdout, ctx.envForRun),
          hyperlinks: true,
        })
      : summary

  if (!ctx.plain && isRichTty(ctx.stdout)) {
    ctx.stdout.write(`\n${rendered.replace(/^\n+/, '')}`)
  } else {
    if (isRichTty(ctx.stdout)) ctx.stdout.write('\n')
    ctx.stdout.write(rendered.replace(/^\n+/, ''))
  }
  if (!rendered.endsWith('\n')) {
    ctx.stdout.write('\n')
  }
  ctx.restoreProgressAfterStdout?.()
  ctx.writeViaFooter([...assetFooterParts, footerLabel])

  const report = ctx.shouldComputeReport ? await ctx.buildReport() : null
  if (ctx.metricsEnabled && report) {
    const costUsd = await ctx.estimateCostUsd()
    writeFinishLine({
      stderr: ctx.stderr,
      elapsedMs: Date.now() - ctx.runStartedAtMs,
      elapsedLabel: null,
      model: null,
      report,
      costUsd,
      detailed: ctx.metricsDetailed,
      extraParts: null,
      color: ctx.verboseColor,
    })
  }
}

export type AssetSummaryContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  execFileImpl: ExecFileFn
  timeoutMs: number
  preprocessMode: 'off' | 'auto' | 'always'
  format: 'text' | 'markdown'
  extractMode: boolean
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  forceSummary: boolean
  outputLanguage: OutputLanguage
  videoMode: 'auto' | 'transcript' | 'understand'
  fixedModelSpec: FixedModelSpec | null
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
  isFallbackModel: boolean
  desiredOutputTokens: number | null
  envForAuto: Record<string, string | undefined>
  configForModelSelection: SummarizeConfig | null
  cliAvailability: Partial<Record<CliProvider, boolean>>
  requestedModel: RequestedModel
  requestedModelInput: string
  requestedModelLabel: string
  wantsFreeNamedModel: boolean
  isNamedModelSelection: boolean
  maxOutputTokensArg: number | null
  json: boolean
  metricsEnabled: boolean
  metricsDetailed: boolean
  shouldComputeReport: boolean
  runStartedAtMs: number
  verbose: boolean
  verboseColor: boolean
  streamingEnabled: boolean
  plain: boolean
  summaryEngine: ReturnType<typeof createSummaryEngine>
  trackedFetch: typeof fetch
  writeViaFooter: (parts: string[]) => void
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  getLiteLlmCatalog: () => Promise<
    Awaited<ReturnType<typeof import('../../../pricing/litellm.js').loadLiteLlmCatalog>>['catalog']
  >
  buildReport: () => Promise<RunMetricsReport>
  estimateCostUsd: () => Promise<number | null>
  llmCalls: LlmCall[]
  cache: CacheState
  apiStatus: {
    xaiApiKey: string | null
    apiKey: string | null
    openrouterApiKey: string | null
    apifyToken: string | null
    firecrawlConfigured: boolean
    googleConfigured: boolean
    anthropicConfigured: boolean
    providerBaseUrls: {
      openai: string | null
      anthropic: string | null
      google: string | null
      xai: string | null
    }
    zaiApiKey: string | null
    zaiBaseUrl: string
  }
}

export type SummarizeAssetArgs = {
  sourceKind: 'file' | 'asset-url'
  sourceLabel: string
  attachment: AssetAttachment
  onModelChosen?: ((modelId: string) => void) | null
}

export async function summarizeAsset(ctx: AssetSummaryContext, args: SummarizeAssetArgs) {
  const { promptText, attachments, assetFooterParts, textContent } = await prepareAssetPrompt({
    ctx: {
      env: ctx.env,
      envForRun: ctx.envForRun,
      execFileImpl: ctx.execFileImpl,
      timeoutMs: ctx.timeoutMs,
      preprocessMode: ctx.preprocessMode,
      format: ctx.format,
      lengthArg: ctx.lengthArg,
      outputLanguage: ctx.outputLanguage,
      fixedModelSpec: ctx.fixedModelSpec,
      promptOverride: ctx.promptOverride ?? null,
      lengthInstruction: ctx.lengthInstruction ?? null,
      languageInstruction: ctx.languageInstruction ?? null,
    },
    attachment: args.attachment,
  })
  const prompt: Prompt = {
    userText: promptText,
    ...(attachments.length > 0 ? { attachments } : {}),
  }

  const summaryLengthTarget =
    ctx.lengthArg.kind === 'preset'
      ? ctx.lengthArg.preset
      : { maxCharacters: ctx.lengthArg.maxCharacters }

  const promptTokensForAuto = attachments.length === 0 ? countTokens(prompt.userText) : null
  const lowerMediaType = args.attachment.mediaType.toLowerCase()
  const kind = lowerMediaType.startsWith('video/')
    ? ('video' as const)
    : lowerMediaType.startsWith('image/')
      ? ('image' as const)
      : textContent
        ? ('text' as const)
        : ('file' as const)
  const requiresVideoUnderstanding = kind === 'video' && ctx.videoMode !== 'transcript'

  if (shouldBypassShortContentSummary({ ctx, textContent })) {
    await outputBypassedAssetSummary({
      ctx,
      args,
      promptText,
      summaryText: textContent?.content ?? '',
      assetFooterParts,
      footerLabel: 'short content',
    })
    return
  }

  if (
    ctx.requestedModel.kind === 'auto' &&
    !ctx.isNamedModelSelection &&
    !ctx.forceSummary &&
    !ctx.json &&
    typeof ctx.maxOutputTokensArg === 'number' &&
    textContent &&
    countTokens(textContent.content) <= ctx.maxOutputTokensArg
  ) {
    ctx.clearProgressForStdout()
    ctx.stdout.write(`${textContent.content.trim()}\n`)
    ctx.restoreProgressAfterStdout?.()
    if (assetFooterParts.length > 0) {
      ctx.writeViaFooter([...assetFooterParts, 'no model'])
    }
    return
  }

  const attempts: ModelAttempt[] = await (async () => {
    if (ctx.isFallbackModel) {
      const catalog = await ctx.getLiteLlmCatalog()
      const all = buildAutoModelAttempts({
        kind,
        promptTokens: promptTokensForAuto,
        desiredOutputTokens: ctx.desiredOutputTokens,
        requiresVideoUnderstanding,
        env: ctx.envForAuto,
        config: ctx.configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability: ctx.cliAvailability,
      })
      const mapped: ModelAttempt[] = all.map((attempt) => {
        if (attempt.transport !== 'cli')
          return ctx.summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
        const parsed = parseCliUserModelId(attempt.userModelId)
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
      })
      return mapped
    }
    /* v8 ignore next */
    if (!ctx.fixedModelSpec) {
      throw new Error('Internal error: missing fixed model spec')
    }
    if (ctx.fixedModelSpec.transport === 'cli') {
      return [
        {
          transport: 'cli',
          userModelId: ctx.fixedModelSpec.userModelId,
          llmModelId: null,
          cliProvider: ctx.fixedModelSpec.cliProvider,
          cliModel: ctx.fixedModelSpec.cliModel,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: ctx.fixedModelSpec.requiredEnv,
        },
      ]
    }
    const openaiOverrides =
      ctx.fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
        ? {
            openaiApiKeyOverride: ctx.apiStatus.zaiApiKey,
            openaiBaseUrlOverride: ctx.apiStatus.zaiBaseUrl,
            forceChatCompletions: true,
          }
        : {}
    return [
      {
        transport: ctx.fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
        userModelId: ctx.fixedModelSpec.userModelId,
        llmModelId: ctx.fixedModelSpec.llmModelId,
        openrouterProviders: ctx.fixedModelSpec.openrouterProviders,
        forceOpenRouter: ctx.fixedModelSpec.forceOpenRouter,
        requiredEnv: ctx.fixedModelSpec.requiredEnv,
        ...openaiOverrides,
      },
    ]
  })()

  const cliContext = await (async () => {
    if (!attempts.some((a) => a.transport === 'cli')) return null
    if (attachments.length === 0) return null
    const needsPathPrompt = args.attachment.kind === 'image' || args.attachment.kind === 'file'
    if (!needsPathPrompt) return null
    const filePath = await ensureCliAttachmentPath({
      sourceKind: args.sourceKind,
      sourceLabel: args.sourceLabel,
      attachment: args.attachment,
    })
    const dir = path.dirname(filePath)
    const extraArgsByProvider: Partial<Record<CliProvider, string[]>> = {
      gemini: ['--include-directories', dir],
      codex: args.attachment.kind === 'image' ? ['-i', filePath] : undefined,
    }
    return {
      promptOverride: buildPathSummaryPrompt({
        kindLabel: args.attachment.kind === 'image' ? 'image' : 'file',
        filePath,
        filename: args.attachment.filename,
        mediaType: args.attachment.mediaType,
        summaryLength: summaryLengthTarget,
        outputLanguage: ctx.outputLanguage,
        promptOverride: ctx.promptOverride ?? null,
        lengthInstruction: ctx.lengthInstruction ?? null,
        languageInstruction: ctx.languageInstruction ?? null,
      }),
      allowTools: true,
      cwd: dir,
      extraArgsByProvider,
    }
  })()

  const cacheStore = ctx.cache.mode === 'default' ? ctx.cache.store : null
  const contentBlock = extractTaggedBlock(promptText, 'content')
  const contentHash =
    cacheStore && contentBlock && contentBlock.trim().length > 0
      ? hashString(normalizeContentForHash(contentBlock))
      : null
  const promptHash = cacheStore ? buildPromptHash(promptText) : null
  const lengthKey = buildLengthKey(ctx.lengthArg)
  const languageKey = buildLanguageKey(ctx.outputLanguage)

  let summaryResult: Awaited<ReturnType<typeof ctx.summaryEngine.runSummaryAttempt>> | null = null
  let usedAttempt: ModelAttempt | null = null
  let summaryFromCache = false
  let cacheChecked = false

  if (cacheStore && contentHash && promptHash) {
    cacheChecked = true
    for (const attempt of attempts) {
      if (!ctx.summaryEngine.envHasKeyFor(attempt.requiredEnv)) continue
      const key = buildSummaryCacheKey({
        contentHash,
        promptHash,
        model: attempt.userModelId,
        lengthKey,
        languageKey,
      })
      const cached = cacheStore.getText('summary', key)
      if (!cached) continue
      writeVerbose(ctx.stderr, ctx.verbose, 'cache hit summary', ctx.verboseColor)
      args.onModelChosen?.(attempt.userModelId)
      summaryResult = {
        summary: cached,
        summaryAlreadyPrinted: false,
        modelMeta: buildModelMetaFromAttempt(attempt),
        maxOutputTokensForCall: null,
      }
      usedAttempt = attempt
      summaryFromCache = true
      break
    }
  }
  if (cacheChecked && !summaryFromCache) {
    writeVerbose(ctx.stderr, ctx.verbose, 'cache miss summary', ctx.verboseColor)
  }

  let lastError: unknown = null
  let missingRequiredEnvs = new Set<ModelAttempt['requiredEnv']>()
  let sawOpenRouterNoAllowedProviders = false

  if (!summaryResult || !usedAttempt) {
    const attemptOutcome = await runModelAttempts({
      attempts,
      isFallbackModel: ctx.isFallbackModel,
      isNamedModelSelection: ctx.isNamedModelSelection,
      envHasKeyFor: ctx.summaryEngine.envHasKeyFor,
      formatMissingModelError: ctx.summaryEngine.formatMissingModelError,
      onAutoSkip: (attempt) => {
        writeVerbose(
          ctx.stderr,
          ctx.verbose,
          `auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`,
          ctx.verboseColor
        )
      },
      onAutoFailure: (attempt, error) => {
        writeVerbose(
          ctx.stderr,
          ctx.verbose,
          `auto failed ${attempt.userModelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ctx.verboseColor
        )
      },
      onFixedModelError: (attempt, error) => {
        if (isUnsupportedAttachmentError(error)) {
          throw new Error(
            `Model ${attempt.userModelId} does not support attaching files of type ${args.attachment.mediaType}. Try a different --model.`,
            { cause: error }
          )
        }
        throw error
      },
      runAttempt: (attempt) =>
        ctx.summaryEngine.runSummaryAttempt({
          attempt,
          prompt,
          allowStreaming: ctx.streamingEnabled,
          onModelChosen: args.onModelChosen ?? null,
          cli: cliContext,
        }),
    })
    summaryResult = attemptOutcome.result
    usedAttempt = attemptOutcome.usedAttempt
    lastError = attemptOutcome.lastError
    missingRequiredEnvs = attemptOutcome.missingRequiredEnvs
    sawOpenRouterNoAllowedProviders = attemptOutcome.sawOpenRouterNoAllowedProviders
  }

  if (!summaryResult || !usedAttempt) {
    const withFreeTip = (message: string) => {
      if (!ctx.isNamedModelSelection || !ctx.wantsFreeNamedModel) return message
      return (
        `${message}\n` +
        `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
      )
    }

    if (ctx.isNamedModelSelection) {
      if (lastError === null && missingRequiredEnvs.size > 0) {
        throw new Error(
          withFreeTip(
            `Missing ${Array.from(missingRequiredEnvs).sort().join(', ')} for --model ${ctx.requestedModelInput}.`
          )
        )
      }
      if (lastError instanceof Error) {
        if (sawOpenRouterNoAllowedProviders) {
          const message = await buildOpenRouterNoAllowedProvidersMessage({
            attempts,
            fetchImpl: ctx.trackedFetch,
            timeoutMs: ctx.timeoutMs,
          })
          throw new Error(withFreeTip(message), { cause: lastError })
        }
        throw new Error(withFreeTip(lastError.message), { cause: lastError })
      }
      throw new Error(withFreeTip(`No model available for --model ${ctx.requestedModelInput}`))
    }
    if (textContent) {
      ctx.clearProgressForStdout()
      ctx.stdout.write(`${textContent.content.trim()}\n`)
      ctx.restoreProgressAfterStdout?.()
      if (assetFooterParts.length > 0) {
        ctx.writeViaFooter([...assetFooterParts, 'no model'])
      }
      return
    }
    if (lastError instanceof Error) throw lastError
    throw new Error('No model available for this input')
  }

  if (!summaryFromCache && cacheStore && contentHash && promptHash) {
    const key = buildSummaryCacheKey({
      contentHash,
      promptHash,
      model: usedAttempt.userModelId,
      lengthKey,
      languageKey,
    })
    cacheStore.setText('summary', key, summaryResult.summary, ctx.cache.ttlMs)
    writeVerbose(ctx.stderr, ctx.verbose, 'cache write summary', ctx.verboseColor)
  }

  const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

  const extracted = {
    kind: 'asset' as const,
    source: args.sourceLabel,
    mediaType: args.attachment.mediaType,
    filename: args.attachment.filename,
  }

  if (ctx.json) {
    ctx.clearProgressForStdout()
    const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
    const input: {
      kind: 'file' | 'asset-url'
      filePath?: string
      url?: string
      timeoutMs: number
      length: { kind: 'preset'; preset: string } | { kind: 'chars'; maxCharacters: number }
      maxOutputTokens: number | null
      model: string
      language: ReturnType<typeof formatOutputLanguageForJson>
    } =
      args.sourceKind === 'file'
        ? {
            kind: 'file',
            filePath: args.sourceLabel,
            timeoutMs: ctx.timeoutMs,
            length:
              ctx.lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: ctx.lengthArg.preset }
                : { kind: 'chars', maxCharacters: ctx.lengthArg.maxCharacters },
            maxOutputTokens: ctx.maxOutputTokensArg,
            model: ctx.requestedModelLabel,
            language: formatOutputLanguageForJson(ctx.outputLanguage),
          }
        : {
            kind: 'asset-url',
            url: args.sourceLabel,
            timeoutMs: ctx.timeoutMs,
            length:
              ctx.lengthArg.kind === 'preset'
                ? { kind: 'preset', preset: ctx.lengthArg.preset }
                : { kind: 'chars', maxCharacters: ctx.lengthArg.maxCharacters },
            maxOutputTokens: ctx.maxOutputTokensArg,
            model: ctx.requestedModelLabel,
            language: formatOutputLanguageForJson(ctx.outputLanguage),
          }
    const payload = {
      input,
      env: {
        hasXaiKey: Boolean(ctx.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(ctx.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(ctx.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(ctx.apiStatus.apifyToken),
        hasFirecrawlKey: ctx.apiStatus.firecrawlConfigured,
        hasGoogleKey: ctx.apiStatus.googleConfigured,
        hasAnthropicKey: ctx.apiStatus.anthropicConfigured,
      },
      extracted,
      prompt: promptText,
      llm: {
        provider: modelMeta.provider,
        model: usedAttempt.userModelId,
        maxCompletionTokens: maxOutputTokensForCall,
        strategy: 'single' as const,
      },
      metrics: ctx.metricsEnabled ? finishReport : null,
      summary,
    }
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    ctx.restoreProgressAfterStdout?.()
    if (ctx.metricsEnabled && finishReport) {
      const costUsd = await ctx.estimateCostUsd()
      writeFinishLine({
        stderr: ctx.stderr,
        elapsedMs: Date.now() - ctx.runStartedAtMs,
        elapsedLabel: summaryFromCache ? 'Cached' : null,
        model: usedAttempt.userModelId,
        report: finishReport,
        costUsd,
        detailed: ctx.metricsDetailed,
        extraParts: null,
        color: ctx.verboseColor,
      })
    }
    return
  }

  if (!summaryAlreadyPrinted) {
    ctx.clearProgressForStdout()
    const rendered =
      !ctx.plain && isRichTty(ctx.stdout)
        ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
            width: markdownRenderWidth(ctx.stdout, ctx.env),
            wrap: true,
            color: supportsColor(ctx.stdout, ctx.envForRun),
            hyperlinks: true,
          })
        : summary

    if (!ctx.plain && isRichTty(ctx.stdout)) {
      ctx.stdout.write(`\n${rendered.replace(/^\n+/, '')}`)
    } else {
      if (isRichTty(ctx.stdout)) ctx.stdout.write('\n')
      ctx.stdout.write(rendered.replace(/^\n+/, ''))
    }
    if (!rendered.endsWith('\n')) {
      ctx.stdout.write('\n')
    }
    ctx.restoreProgressAfterStdout?.()
  }

  ctx.writeViaFooter([...assetFooterParts, `model ${usedAttempt.userModelId}`])

  const report = ctx.shouldComputeReport ? await ctx.buildReport() : null
  if (ctx.metricsEnabled && report) {
    const costUsd = await ctx.estimateCostUsd()
    writeFinishLine({
      stderr: ctx.stderr,
      elapsedMs: Date.now() - ctx.runStartedAtMs,
      elapsedLabel: summaryFromCache ? 'Cached' : null,
      model: usedAttempt.userModelId,
      report,
      costUsd,
      detailed: ctx.metricsDetailed,
      extraParts: null,
      color: ctx.verboseColor,
    })
  }
}
