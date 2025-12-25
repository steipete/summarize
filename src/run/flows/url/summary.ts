import { countTokens } from 'gpt-tokenizer'
import { render as renderMarkdownAnsi } from 'markdansi'
import type { ExtractedLinkContent } from '../../../content/index.js'
import { formatOutputLanguageForJson } from '../../../language.js'
import { buildAutoModelAttempts } from '../../../model-auto.js'
import { buildLinkSummaryPrompt } from '../../../prompts/index.js'
import { parseCliUserModelId } from '../../env.js'
import {
  buildExtractFinishLabel,
  buildLengthPartsForFinishLine,
  writeFinishLine,
} from '../../finish-line.js'
import { writeVerbose } from '../../logging.js'
import { prepareMarkdownForTerminal } from '../../markdown.js'
import { runModelAttempts } from '../../model-attempts.js'
import { buildOpenRouterNoAllowedProvidersMessage } from '../../openrouter.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import type { ModelAttempt } from '../../types.js'
import type { UrlExtractionUi } from './extract.js'
import type { UrlFlowContext } from './types.js'

export function buildUrlPrompt({
  extracted,
  outputLanguage,
  lengthArg,
}: {
  extracted: ExtractedLinkContent
  outputLanguage: UrlFlowContext['outputLanguage']
  lengthArg: UrlFlowContext['lengthArg']
}): string {
  const isYouTube = extracted.siteName === 'YouTube'
  return buildLinkSummaryPrompt({
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
}

const buildFinishExtras = ({
  extracted,
  metricsDetailed,
  transcriptionCostLabel,
}: {
  extracted: ExtractedLinkContent
  metricsDetailed: boolean
  transcriptionCostLabel: string | null
}) => {
  const parts = [
    ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
    ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
  ]
  return parts.length > 0 ? parts : null
}

const pickModelForFinishLine = (llmCalls: UrlFlowContext['llmCalls'], fallback: string | null) => {
  const findLastModel = (purpose: (typeof llmCalls)[number]['purpose']): string | null => {
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

export async function outputExtractedUrl({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
}) {
  ctx.clearProgressForStdout()
  const finishLabel = buildExtractFinishLabel({
    extracted: { diagnostics: extracted.diagnostics },
    format: ctx.format,
    markdownMode: effectiveMarkdownMode,
    hasMarkdownLlmCall: ctx.llmCalls.some((call) => call.purpose === 'markdown'),
  })
  const finishModel = pickModelForFinishLine(ctx.llmCalls, null)

  if (ctx.json) {
    const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: ctx.timeoutMs,
        youtube: ctx.youtubeMode,
        firecrawl: ctx.firecrawlMode,
        format: ctx.format,
        markdown: effectiveMarkdownMode,
        length:
          ctx.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: ctx.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: ctx.lengthArg.maxCharacters },
        maxOutputTokens: ctx.maxOutputTokensArg,
        model: ctx.requestedModelLabel,
        language: formatOutputLanguageForJson(ctx.outputLanguage),
      },
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
      prompt,
      llm: null,
      metrics: ctx.metricsEnabled ? finishReport : null,
      summary: null,
    }
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (ctx.metricsEnabled && finishReport) {
      const costUsd = await ctx.estimateCostUsd()
      writeFinishLine({
        stderr: ctx.stderr,
        elapsedMs: Date.now() - ctx.runStartedAtMs,
        label: finishLabel,
        model: finishModel,
        report: finishReport,
        costUsd,
        detailed: ctx.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: ctx.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: ctx.verboseColor,
      })
    }
    return
  }

  const renderedExtract =
    ctx.format === 'markdown' &&
    (ctx.effectiveRenderMode === 'md' || ctx.effectiveRenderMode === 'md-live') &&
    isRichTty(ctx.stdout)
      ? renderMarkdownAnsi(prepareMarkdownForTerminal(extracted.content), {
          width: markdownRenderWidth(ctx.stdout, ctx.env),
          wrap: true,
          color: supportsColor(ctx.stdout, ctx.envForRun),
          hyperlinks: true,
        })
      : extracted.content

  ctx.stdout.write(renderedExtract)
  if (!renderedExtract.endsWith('\n')) {
    ctx.stdout.write('\n')
  }
  ctx.writeViaFooter(extractionUi.footerParts)
  const report = ctx.shouldComputeReport ? await ctx.buildReport() : null
  if (ctx.metricsEnabled && report) {
    const costUsd = await ctx.estimateCostUsd()
    writeFinishLine({
      stderr: ctx.stderr,
      elapsedMs: Date.now() - ctx.runStartedAtMs,
      label: finishLabel,
      model: finishModel,
      report,
      costUsd,
      detailed: ctx.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: ctx.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: ctx.verboseColor,
    })
  }
}

export async function summarizeExtractedUrl({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
  onModelChosen,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
  onModelChosen?: ((modelId: string) => void) | null
}) {
  const promptTokens = countTokens(prompt)
  const kindForAuto = extracted.siteName === 'YouTube' ? ('youtube' as const) : ('website' as const)

  const attempts: ModelAttempt[] = await (async () => {
    if (ctx.isFallbackModel) {
      const catalog = await ctx.getLiteLlmCatalog()
      const list = buildAutoModelAttempts({
        kind: kindForAuto,
        promptTokens,
        desiredOutputTokens: ctx.desiredOutputTokens,
        requiresVideoUnderstanding: false,
        env: ctx.envForAuto,
        config: ctx.configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability: ctx.cliAvailability,
      })
      if (ctx.verbose) {
        for (const attempt of list.slice(0, 8)) {
          writeVerbose(ctx.stderr, ctx.verbose, `auto candidate ${attempt.debug}`, ctx.verboseColor)
        }
      }
      return list.map((attempt) => {
        if (attempt.transport !== 'cli')
          return ctx.summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
        const parsed = parseCliUserModelId(attempt.userModelId)
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
      })
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
        `auto failed ${attempt.userModelId}: ${error instanceof Error ? error.message : String(error)}`,
        ctx.verboseColor
      )
    },
    onFixedModelError: (_attempt, error) => {
      throw error
    },
    runAttempt: (attempt) =>
      ctx.summaryEngine.runSummaryAttempt({
        attempt,
        prompt,
        allowStreaming: ctx.streamingEnabled,
        onModelChosen: onModelChosen ?? null,
      }),
  })
  const summaryResult = attemptOutcome.result
  const usedAttempt = attemptOutcome.usedAttempt
  const { lastError, missingRequiredEnvs, sawOpenRouterNoAllowedProviders } = attemptOutcome

  if (!summaryResult || !usedAttempt) {
    // Auto mode: surface raw extracted content when no model can run.
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
    ctx.clearProgressForStdout()
    if (ctx.json) {
      const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
      const finishModel = pickModelForFinishLine(ctx.llmCalls, null)
      const payload = {
        input: {
          kind: 'url' as const,
          url,
          timeoutMs: ctx.timeoutMs,
          youtube: ctx.youtubeMode,
          firecrawl: ctx.firecrawlMode,
          format: ctx.format,
          markdown: effectiveMarkdownMode,
          length:
            ctx.lengthArg.kind === 'preset'
              ? { kind: 'preset' as const, preset: ctx.lengthArg.preset }
              : { kind: 'chars' as const, maxCharacters: ctx.lengthArg.maxCharacters },
          maxOutputTokens: ctx.maxOutputTokensArg,
          model: ctx.requestedModelLabel,
          language: formatOutputLanguageForJson(ctx.outputLanguage),
        },
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
        prompt,
        llm: null,
        metrics: ctx.metricsEnabled ? finishReport : null,
        summary: extracted.content,
      }
      ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (ctx.metricsEnabled && finishReport) {
        const costUsd = await ctx.estimateCostUsd()
        writeFinishLine({
          stderr: ctx.stderr,
          elapsedMs: Date.now() - ctx.runStartedAtMs,
          label: extractionUi.finishSourceLabel,
          model: finishModel,
          report: finishReport,
          costUsd,
          detailed: ctx.metricsDetailed,
          extraParts: buildFinishExtras({
            extracted,
            metricsDetailed: ctx.metricsDetailed,
            transcriptionCostLabel,
          }),
          color: ctx.verboseColor,
        })
      }
      return
    }
    ctx.stdout.write(`${extracted.content}\n`)
    if (extractionUi.footerParts.length > 0) {
      ctx.writeViaFooter([...extractionUi.footerParts, 'no model'])
    }
    if (lastError instanceof Error && ctx.verbose) {
      writeVerbose(
        ctx.stderr,
        ctx.verbose,
        `auto failed all models: ${lastError.message}`,
        ctx.verboseColor
      )
    }
    return
  }

  const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

  if (ctx.json) {
    const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: ctx.timeoutMs,
        youtube: ctx.youtubeMode,
        firecrawl: ctx.firecrawlMode,
        format: ctx.format,
        markdown: effectiveMarkdownMode,
        length:
          ctx.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: ctx.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: ctx.lengthArg.maxCharacters },
        maxOutputTokens: ctx.maxOutputTokensArg,
        model: ctx.requestedModelLabel,
        language: formatOutputLanguageForJson(ctx.outputLanguage),
      },
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
      prompt,
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
    if (ctx.metricsEnabled && finishReport) {
      const costUsd = await ctx.estimateCostUsd()
      writeFinishLine({
        stderr: ctx.stderr,
        elapsedMs: Date.now() - ctx.runStartedAtMs,
        label: extractionUi.finishSourceLabel,
        model: usedAttempt.userModelId,
        report: finishReport,
        costUsd,
        detailed: ctx.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: ctx.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: ctx.verboseColor,
      })
    }
    return
  }

  if (!summaryAlreadyPrinted) {
    ctx.clearProgressForStdout()
    const rendered =
      (ctx.effectiveRenderMode === 'md' || ctx.effectiveRenderMode === 'md-live') &&
      isRichTty(ctx.stdout)
        ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
            width: markdownRenderWidth(ctx.stdout, ctx.env),
            wrap: true,
            color: supportsColor(ctx.stdout, ctx.envForRun),
            hyperlinks: true,
          })
        : summary

    ctx.stdout.write(rendered)
    if (!rendered.endsWith('\n')) {
      ctx.stdout.write('\n')
    }
  }

  const report = ctx.shouldComputeReport ? await ctx.buildReport() : null
  if (ctx.metricsEnabled && report) {
    const costUsd = await ctx.estimateCostUsd()
    writeFinishLine({
      stderr: ctx.stderr,
      elapsedMs: Date.now() - ctx.runStartedAtMs,
      label: extractionUi.finishSourceLabel,
      model: modelMeta.canonical,
      report,
      costUsd,
      detailed: ctx.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: ctx.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: ctx.verboseColor,
    })
  }
}
