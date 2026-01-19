import { countTokens } from 'gpt-tokenizer'
import { render as renderMarkdownAnsi } from 'markdansi'
import {
  buildLanguageKey,
  buildLengthKey,
  buildPromptHash,
  buildSummaryCacheKey,
  hashString,
  normalizeContentForHash,
} from '../../../cache.js'
import type { ExtractedLinkContent } from '../../../content/index.js'
import { formatOutputLanguageForJson } from '../../../language.js'
import { parseGatewayStyleModelId } from '../../../llm/model-id.js'
import type { Prompt } from '../../../llm/prompt.js'
import { buildAutoModelAttempts } from '../../../model-auto.js'
import { buildLinkSummaryPrompt, SUMMARY_LENGTH_TARGET_CHARACTERS } from '../../../prompts/index.js'
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
import { resolveTargetCharacters } from '../../format.js'
import type { ModelAttempt } from '../../types.js'
import type { UrlExtractionUi } from './extract.js'
import type { SlidesTerminalOutput } from './slides-output.js'
import { coerceSummaryWithSlides, interleaveSlidesIntoTranscript } from './slides-text.js'
import type { UrlFlowContext } from './types.js'

type SlidesResult = Awaited<
  ReturnType<typeof import('../../../slides/index.js').extractSlidesForSource>
>

type TranscriptSegment = { startSeconds: number; text: string }

const MAX_SLIDE_TRANSCRIPT_CHARS_BY_PRESET = {
  short: 2500,
  medium: 5000,
  long: 9000,
  xl: 15000,
  xxl: 24000,
} as const

const SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS = 30
const SLIDE_TRANSCRIPT_LEEWAY_SECONDS = 10

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(':').map((item) => Number(item))
  if (parts.some((item) => !Number.isFinite(item))) return null
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return minutes * 60 + seconds
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return hours * 3600 + minutes * 60 + seconds
  }
  return null
}

function parseTranscriptTimedText(input: string | null | undefined): TranscriptSegment[] {
  if (!input) return []
  const segments: TranscriptSegment[] = []
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/)
    if (!match) continue
    const seconds = parseTimestampSeconds(match[1])
    if (seconds == null) continue
    const text = (match[2] ?? '').trim()
    if (!text) continue
    segments.push({ startSeconds: seconds, text })
  }
  segments.sort((a, b) => a.startSeconds - b.startSeconds)
  return segments
}

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = clamped % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  if (hours <= 0) return `${minutes}:${ss}`
  const hh = String(hours).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function truncateTranscript(value: string, limit: number): string {
  if (value.length <= limit) return value
  const truncated = value.slice(0, limit).trimEnd()
  const clean = truncated.replace(/\s+\S*$/, '').trim()
  const result = clean.length > 0 ? clean : truncated.trim()
  return result.length > 0 ? `${result}…` : ''
}

function buildSlidesPromptText({
  slides,
  transcriptTimedText,
  preset,
}: {
  slides: SlidesResult | null | undefined
  transcriptTimedText: string | null | undefined
  preset: 'short' | 'medium' | 'long' | 'xl' | 'xxl'
}): string | null {
  if (!slides || slides.slides.length === 0) return null
  const segments = parseTranscriptTimedText(transcriptTimedText)

  const slidesWithTimestamps = slides.slides
    .filter((slide) => Number.isFinite(slide.timestamp))
    .map((slide) => ({ index: slide.index, timestamp: Math.max(0, Math.floor(slide.timestamp)) }))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (slidesWithTimestamps.length === 0) return null

  const totalBudget = Number(MAX_SLIDE_TRANSCRIPT_CHARS_BY_PRESET[preset])
  const perSlideBudget = Math.max(
    120,
    Math.floor(totalBudget / Math.max(1, slidesWithTimestamps.length))
  )

  let remaining = totalBudget
  const blocks: string[] = []

  for (let i = 0; i < slidesWithTimestamps.length; i += 1) {
    const slide = slidesWithTimestamps[i]
    if (!slide) continue
    const prev = slidesWithTimestamps[i - 1]
    const next = slidesWithTimestamps[i + 1]
    const startBase = prev ? Math.floor((prev.timestamp + slide.timestamp) / 2) : slide.timestamp
    const endBase = next ? Math.ceil((slide.timestamp + next.timestamp) / 2) : slide.timestamp
    const start = Math.max(
      0,
      (prev ? startBase : slide.timestamp - SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS) -
        SLIDE_TRANSCRIPT_LEEWAY_SECONDS
    )
    const end =
      (next ? endBase : slide.timestamp + SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS) +
      SLIDE_TRANSCRIPT_LEEWAY_SECONDS

    const excerptParts: string[] = []
    for (const segment of segments) {
      if (segment.startSeconds < start) continue
      if (segment.startSeconds > end) break
      excerptParts.push(segment.text)
    }
    const excerptRaw = excerptParts.join(' ').trim().replace(/\s+/g, ' ')
    const excerptBudget = remaining > 0 ? Math.min(perSlideBudget, remaining) : 0
    const excerpt =
      excerptRaw && excerptBudget > 0 ? truncateTranscript(excerptRaw, excerptBudget) : ''
    const label = `[slide:${slide.index}] [${formatTimestamp(start)}–${formatTimestamp(end)}]`
    const block = excerpt ? `${label}\n${excerpt}` : label
    blocks.push(block)
    remaining = Math.max(0, remaining - block.length)
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null
}

export function buildUrlPrompt({
  extracted,
  outputLanguage,
  lengthArg,
  promptOverride,
  lengthInstruction,
  languageInstruction,
  slides,
}: {
  extracted: ExtractedLinkContent
  outputLanguage: UrlFlowContext['flags']['outputLanguage']
  lengthArg: UrlFlowContext['flags']['lengthArg']
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
  slides?: SlidesResult | null
}): string {
  const isYouTube = extracted.siteName === 'YouTube'
  const preset = lengthArg.kind === 'preset' ? lengthArg.preset : 'medium'
  const slidesText = buildSlidesPromptText({
    slides,
    transcriptTimedText: extracted.transcriptTimedText,
    preset,
  })
  return buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title,
    siteName: extracted.siteName,
    description: extracted.description,
    content: extracted.content,
    truncated: extracted.truncated,
    hasTranscript:
      isYouTube ||
      (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
    hasTranscriptTimestamps: Boolean(extracted.transcriptTimedText),
    slides: slidesText ? { count: slides?.slides.length ?? 0, text: slidesText } : null,
    summaryLength:
      lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
    outputLanguage,
    shares: [],
    promptOverride: promptOverride ?? null,
    lengthInstruction: lengthInstruction ?? null,
    languageInstruction: languageInstruction ?? null,
  })
}

function shouldBypassShortContentSummary({
  extracted,
  lengthArg,
  forceSummary,
}: {
  extracted: ExtractedLinkContent
  lengthArg: UrlFlowContext['flags']['lengthArg']
  forceSummary: boolean
}): boolean {
  if (forceSummary) return false
  if (!extracted.content || extracted.content.length === 0) return false
  const targetCharacters = resolveTargetCharacters(lengthArg, SUMMARY_LENGTH_TARGET_CHARACTERS)
  if (!Number.isFinite(targetCharacters) || targetCharacters <= 0) return false
  return extracted.content.length <= targetCharacters
}

async function outputSummaryFromExtractedContent({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
  slides,
  footerLabel,
  verboseMessage,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
  slides?: Awaited<
    ReturnType<typeof import('../../../slides/index.js').extractSlidesForSource>
  > | null
  footerLabel?: string | null
  verboseMessage?: string | null
}) {
  const { io, flags, model, hooks } = ctx

  hooks.clearProgressForStdout()
  const finishModel = pickModelForFinishLine(model.llmCalls, null)

  if (flags.json) {
    const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: flags.timeoutMs,
        youtube: flags.youtubeMode,
        firecrawl: flags.firecrawlMode,
        format: flags.format,
        markdown: effectiveMarkdownMode,
        timestamps: flags.transcriptTimestamps,
        length:
          flags.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
        maxOutputTokens: flags.maxOutputTokensArg,
        model: model.requestedModelLabel,
        language: formatOutputLanguageForJson(flags.outputLanguage),
      },
      env: {
        hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(model.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(model.apiStatus.apifyToken),
        hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
        hasGoogleKey: model.apiStatus.googleConfigured,
        hasAnthropicKey: model.apiStatus.anthropicConfigured,
      },
      extracted,
      slides,
      prompt,
      llm: null,
      metrics: flags.metricsEnabled ? finishReport : null,
      summary: extracted.content,
    }
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (flags.metricsEnabled && finishReport) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        label: extractionUi.finishSourceLabel,
        model: finishModel,
        report: finishReport,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  io.stdout.write(`${extracted.content}\n`)
  hooks.restoreProgressAfterStdout?.()
  if (extractionUi.footerParts.length > 0) {
    const footer = footerLabel ? [...extractionUi.footerParts, footerLabel] : extractionUi.footerParts
    hooks.writeViaFooter(footer)
  }
  if (verboseMessage && flags.verbose) {
    writeVerbose(io.stderr, flags.verbose, verboseMessage, flags.verboseColor)
  }
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

const pickModelForFinishLine = (
  llmCalls: UrlFlowContext['model']['llmCalls'],
  fallback: string | null
) => {
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

export async function outputExtractedUrl({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
  slides,
  slidesOutput,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
  slides?: Awaited<
    ReturnType<typeof import('../../../slides/index.js').extractSlidesForSource>
  > | null
  slidesOutput?: SlidesTerminalOutput | null
}) {
  const { io, flags, model, hooks } = ctx

  hooks.clearProgressForStdout()
  const finishLabel = buildExtractFinishLabel({
    extracted: { diagnostics: extracted.diagnostics },
    format: flags.format,
    markdownMode: effectiveMarkdownMode,
    hasMarkdownLlmCall: model.llmCalls.some((call) => call.purpose === 'markdown'),
  })
  const finishModel = pickModelForFinishLine(model.llmCalls, null)

  if (flags.json) {
    const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: flags.timeoutMs,
        youtube: flags.youtubeMode,
        firecrawl: flags.firecrawlMode,
        format: flags.format,
        markdown: effectiveMarkdownMode,
        timestamps: flags.transcriptTimestamps,
        length:
          flags.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
        maxOutputTokens: flags.maxOutputTokensArg,
        model: model.requestedModelLabel,
        language: formatOutputLanguageForJson(flags.outputLanguage),
      },
      env: {
        hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(model.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(model.apiStatus.apifyToken),
        hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
        hasGoogleKey: model.apiStatus.googleConfigured,
        hasAnthropicKey: model.apiStatus.anthropicConfigured,
      },
      extracted,
      slides,
      prompt,
      llm: null,
      metrics: flags.metricsEnabled ? finishReport : null,
      summary: null,
    }
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    hooks.restoreProgressAfterStdout?.()
    hooks.restoreProgressAfterStdout?.()
    if (flags.metricsEnabled && finishReport) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        label: finishLabel,
        model: finishModel,
        report: finishReport,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  const extractCandidate =
    flags.transcriptTimestamps &&
    extracted.transcriptTimedText &&
    extracted.transcriptSource &&
    extracted.content.toLowerCase().startsWith('transcript:')
      ? `Transcript:\n${extracted.transcriptTimedText}`
      : extracted.content

  const slideTags =
    slides?.slides && slides.slides.length > 0
      ? slides.slides.map((slide) => `[slide:${slide.index}]`).join('\n')
      : ''

  if (slidesOutput && slides?.slides && slides.slides.length > 0) {
    const transcriptText = extracted.transcriptTimedText
      ? `Transcript:\n${extracted.transcriptTimedText}`
      : null
    const interleaved = transcriptText
      ? interleaveSlidesIntoTranscript({
          transcriptTimedText: transcriptText,
          slides: slides.slides.map((slide) => ({
            index: slide.index,
            timestamp: slide.timestamp,
          })),
        })
      : `${extractCandidate.trimEnd()}\n\n${slideTags}`
    await slidesOutput.renderFromText(interleaved)
    hooks.restoreProgressAfterStdout?.()
    const slideFooter = slides ? [`slides ${slides.slides.length}`] : []
    hooks.writeViaFooter([...extractionUi.footerParts, ...slideFooter])
    const report = flags.shouldComputeReport ? await hooks.buildReport() : null
    if (flags.metricsEnabled && report) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        label: finishLabel,
        model: finishModel,
        report,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  const renderedExtract =
    flags.format === 'markdown' && !flags.plain && isRichTty(io.stdout)
      ? renderMarkdownAnsi(prepareMarkdownForTerminal(extractCandidate), {
          width: markdownRenderWidth(io.stdout, io.env),
          wrap: true,
          color: supportsColor(io.stdout, io.envForRun),
          hyperlinks: true,
        })
      : extractCandidate

  if (flags.format === 'markdown' && !flags.plain && isRichTty(io.stdout)) {
    io.stdout.write(`\n${renderedExtract.replace(/^\n+/, '')}`)
  } else {
    io.stdout.write(renderedExtract)
  }
  if (!renderedExtract.endsWith('\n')) {
    io.stdout.write('\n')
  }
  hooks.restoreProgressAfterStdout?.()
  const slideFooter = slides ? [`slides ${slides.slides.length}`] : []
  hooks.writeViaFooter([...extractionUi.footerParts, ...slideFooter])
  const report = flags.shouldComputeReport ? await hooks.buildReport() : null
  if (flags.metricsEnabled && report) {
    const costUsd = await hooks.estimateCostUsd()
    writeFinishLine({
      stderr: io.stderr,
      elapsedMs: Date.now() - flags.runStartedAtMs,
      label: finishLabel,
      model: finishModel,
      report,
      costUsd,
      detailed: flags.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: flags.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: flags.verboseColor,
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
  slides,
  slidesOutput,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
  onModelChosen?: ((modelId: string) => void) | null
  slides?: Awaited<
    ReturnType<typeof import('../../../slides/index.js').extractSlidesForSource>
  > | null
  slidesOutput?: SlidesTerminalOutput | null
}) {
  const { io, flags, model, cache: cacheState, hooks } = ctx

  const promptPayload: Prompt = { userText: prompt }
  const promptTokens = countTokens(promptPayload.userText)
  const kindForAuto = extracted.siteName === 'YouTube' ? ('youtube' as const) : ('website' as const)

  const attempts: ModelAttempt[] = await (async () => {
    if (model.isFallbackModel) {
      const catalog = await model.getLiteLlmCatalog()
      const list = buildAutoModelAttempts({
        kind: kindForAuto,
        promptTokens,
        desiredOutputTokens: model.desiredOutputTokens,
        requiresVideoUnderstanding: false,
        env: model.envForAuto,
        config: model.configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability: model.cliAvailability,
      })
      if (flags.verbose) {
        for (const attempt of list.slice(0, 8)) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            `auto candidate ${attempt.debug}`,
            flags.verboseColor
          )
        }
      }
      return list.map((attempt) => {
        if (attempt.transport !== 'cli')
          return model.summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
        const parsed = parseCliUserModelId(attempt.userModelId)
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
      })
    }
    /* v8 ignore next */
    if (!model.fixedModelSpec) {
      throw new Error('Internal error: missing fixed model spec')
    }
    if (model.fixedModelSpec.transport === 'cli') {
      return [
        {
          transport: 'cli',
          userModelId: model.fixedModelSpec.userModelId,
          llmModelId: null,
          cliProvider: model.fixedModelSpec.cliProvider,
          cliModel: model.fixedModelSpec.cliModel,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: model.fixedModelSpec.requiredEnv,
        },
      ]
    }
    const openaiOverrides =
      model.fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
        ? {
            openaiApiKeyOverride: model.apiStatus.zaiApiKey,
            openaiBaseUrlOverride: model.apiStatus.zaiBaseUrl,
            forceChatCompletions: true,
          }
        : {}
    return [
      {
        transport: model.fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
        userModelId: model.fixedModelSpec.userModelId,
        llmModelId: model.fixedModelSpec.llmModelId,
        openrouterProviders: model.fixedModelSpec.openrouterProviders,
        forceOpenRouter: model.fixedModelSpec.forceOpenRouter,
        requiredEnv: model.fixedModelSpec.requiredEnv,
        ...openaiOverrides,
      },
    ]
  })()

  const cacheStore = cacheState.mode === 'default' ? cacheState.store : null
  const contentHash = cacheStore ? hashString(normalizeContentForHash(extracted.content)) : null
  const promptHash = cacheStore ? buildPromptHash(prompt) : null
  const lengthKey = buildLengthKey(flags.lengthArg)
  const languageKey = buildLanguageKey(flags.outputLanguage)

  let summaryResult: Awaited<ReturnType<typeof model.summaryEngine.runSummaryAttempt>> | null = null
  let usedAttempt: ModelAttempt | null = null
  let summaryFromCache = false
  let cacheChecked = false

  if (
    shouldBypassShortContentSummary({
      extracted,
      lengthArg: flags.lengthArg,
      forceSummary: flags.forceSummary,
    })
  ) {
    await outputSummaryFromExtractedContent({
      ctx,
      url,
      extracted,
      extractionUi,
      prompt,
      effectiveMarkdownMode,
      transcriptionCostLabel,
      slides,
      footerLabel: 'short content',
      verboseMessage: 'short content: skipping summary',
    })
    return
  }

  if (cacheStore && contentHash && promptHash) {
    cacheChecked = true
    for (const attempt of attempts) {
      if (!model.summaryEngine.envHasKeyFor(attempt.requiredEnv)) continue
      const key = buildSummaryCacheKey({
        contentHash,
        promptHash,
        model: attempt.userModelId,
        lengthKey,
        languageKey,
      })
      const cached = cacheStore.getText('summary', key)
      if (!cached) continue
      writeVerbose(io.stderr, flags.verbose, 'cache hit summary', flags.verboseColor)
      onModelChosen?.(attempt.userModelId)
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
    writeVerbose(io.stderr, flags.verbose, 'cache miss summary', flags.verboseColor)
  }
  ctx.hooks.onSummaryCached?.(summaryFromCache)

  let lastError: unknown = null
  let missingRequiredEnvs = new Set<ModelAttempt['requiredEnv']>()
  let sawOpenRouterNoAllowedProviders = false

  if (!summaryResult || !usedAttempt) {
    const attemptOutcome = await runModelAttempts({
      attempts,
      isFallbackModel: model.isFallbackModel,
      isNamedModelSelection: model.isNamedModelSelection,
      envHasKeyFor: model.summaryEngine.envHasKeyFor,
      formatMissingModelError: model.summaryEngine.formatMissingModelError,
      onAutoSkip: (attempt) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`,
          flags.verboseColor
        )
      },
      onAutoFailure: (attempt, error) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `auto failed ${attempt.userModelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          flags.verboseColor
        )
      },
      onFixedModelError: (_attempt, error) => {
        throw error
      },
      runAttempt: (attempt) =>
        model.summaryEngine.runSummaryAttempt({
          attempt,
          prompt: promptPayload,
          allowStreaming: flags.streamingEnabled && !flags.slides,
          onModelChosen: onModelChosen ?? null,
          streamHandler: flags.slides ? null : (slidesOutput?.streamHandler ?? null),
        }),
    })
    summaryResult = attemptOutcome.result
    usedAttempt = attemptOutcome.usedAttempt
    lastError = attemptOutcome.lastError
    missingRequiredEnvs = attemptOutcome.missingRequiredEnvs
    sawOpenRouterNoAllowedProviders = attemptOutcome.sawOpenRouterNoAllowedProviders
  }

  if (!summaryResult || !usedAttempt) {
    // Auto mode: surface raw extracted content when no model can run.
    const withFreeTip = (message: string) => {
      if (!model.isNamedModelSelection || !model.wantsFreeNamedModel) return message
      return (
        `${message}\n` +
        `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
      )
    }

    if (model.isNamedModelSelection) {
      if (lastError === null && missingRequiredEnvs.size > 0) {
        throw new Error(
          withFreeTip(
            `Missing ${Array.from(missingRequiredEnvs).sort().join(', ')} for --model ${model.requestedModelInput}.`
          )
        )
      }
      if (lastError instanceof Error) {
        if (sawOpenRouterNoAllowedProviders) {
          const message = await buildOpenRouterNoAllowedProvidersMessage({
            attempts,
            fetchImpl: io.fetch,
            timeoutMs: flags.timeoutMs,
          })
          throw new Error(withFreeTip(message), { cause: lastError })
        }
        throw new Error(withFreeTip(lastError.message), { cause: lastError })
      }
      throw new Error(withFreeTip(`No model available for --model ${model.requestedModelInput}`))
    }
    await outputSummaryFromExtractedContent({
      ctx,
      url,
      extracted,
      extractionUi,
      prompt,
      effectiveMarkdownMode,
      transcriptionCostLabel,
      slides,
      footerLabel: 'no model',
      verboseMessage:
        lastError instanceof Error ? `auto failed all models: ${lastError.message}` : null,
    })
    return
  }

  if (!summaryFromCache && cacheStore && contentHash && promptHash) {
    const key = buildSummaryCacheKey({
      contentHash,
      promptHash,
      model: usedAttempt.userModelId,
      lengthKey,
      languageKey,
    })
    cacheStore.setText('summary', key, summaryResult.summary, cacheState.ttlMs)
    writeVerbose(io.stderr, flags.verbose, 'cache write summary', flags.verboseColor)
  }

  const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

  if (flags.json) {
    const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: flags.timeoutMs,
        youtube: flags.youtubeMode,
        firecrawl: flags.firecrawlMode,
        format: flags.format,
        markdown: effectiveMarkdownMode,
        timestamps: flags.transcriptTimestamps,
        length:
          flags.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
        maxOutputTokens: flags.maxOutputTokensArg,
        model: model.requestedModelLabel,
        language: formatOutputLanguageForJson(flags.outputLanguage),
      },
      env: {
        hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(model.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(model.apiStatus.apifyToken),
        hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
        hasGoogleKey: model.apiStatus.googleConfigured,
        hasAnthropicKey: model.apiStatus.anthropicConfigured,
      },
      extracted,
      slides,
      prompt,
      llm: {
        provider: modelMeta.provider,
        model: usedAttempt.userModelId,
        maxCompletionTokens: maxOutputTokensForCall,
        strategy: 'single' as const,
      },
      metrics: flags.metricsEnabled ? finishReport : null,
      summary,
    }
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (flags.metricsEnabled && finishReport) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        elapsedLabel: summaryFromCache ? 'Cached' : null,
        label: extractionUi.finishSourceLabel,
        model: usedAttempt.userModelId,
        report: finishReport,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  if (slidesOutput) {
    if (!summaryAlreadyPrinted) {
      const summaryForSlides =
        slides && slides.slides.length > 0
          ? coerceSummaryWithSlides({
              markdown: summary,
              slides: slides.slides.map((slide) => ({
                index: slide.index,
                timestamp: slide.timestamp,
              })),
              transcriptTimedText: extracted.transcriptTimedText ?? null,
              lengthArg: flags.lengthArg,
            })
          : summary
      await slidesOutput.renderFromText(summaryForSlides)
    }
  } else if (!summaryAlreadyPrinted) {
    hooks.clearProgressForStdout()
    const rendered =
      !flags.plain && isRichTty(io.stdout)
        ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
            width: markdownRenderWidth(io.stdout, io.env),
            wrap: true,
            color: supportsColor(io.stdout, io.envForRun),
            hyperlinks: true,
          })
        : summary

    if (!flags.plain && isRichTty(io.stdout)) {
      io.stdout.write(`\n${rendered.replace(/^\n+/, '')}`)
    } else {
      if (isRichTty(io.stdout)) io.stdout.write('\n')
      io.stdout.write(rendered.replace(/^\n+/, ''))
    }
    if (!rendered.endsWith('\n')) {
      io.stdout.write('\n')
    }
    hooks.restoreProgressAfterStdout?.()
  }

  const report = flags.shouldComputeReport ? await hooks.buildReport() : null
  if (flags.metricsEnabled && report) {
    const costUsd = await hooks.estimateCostUsd()
    writeFinishLine({
      stderr: io.stderr,
      elapsedMs: Date.now() - flags.runStartedAtMs,
      elapsedLabel: summaryFromCache ? 'Cached' : null,
      label: extractionUi.finishSourceLabel,
      model: modelMeta.canonical,
      report,
      costUsd,
      detailed: flags.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: flags.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: flags.verboseColor,
    })
  }
}
