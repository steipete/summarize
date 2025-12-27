import { loadRemoteAsset } from '../../../content/asset.js'
import { createLinkPreviewClient } from '../../../content/index.js'
import { createFirecrawlScraper } from '../../../firecrawl.js'
import { createOscProgressController } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import { createWebsiteProgress } from '../../../tty/website-progress.js'
import { assertAssetMediaTypeSupported } from '../../attachments.js'
import { readTweetWithBird } from '../../bird.js'
import { UVX_TIP } from '../../constants.js'
import { hasBirdCli, hasUvxCli } from '../../env.js'
import {
  estimateWhisperTranscriptionCostUsd,
  formatOptionalNumber,
  formatOptionalString,
  formatUSD,
} from '../../format.js'
import { writeVerbose } from '../../logging.js'
import {
  deriveExtractionUi,
  fetchLinkContentWithBirdTip,
  logExtractionDiagnostics,
} from './extract.js'
import { createMarkdownConverters } from './markdown.js'
import { buildUrlPrompt, outputExtractedUrl, summarizeExtractedUrl } from './summary.js'
import type { UrlFlowContext } from './types.js'

export async function runUrlFlow({
  ctx,
  url,
  isYoutubeUrl,
}: {
  ctx: UrlFlowContext
  url: string
  isYoutubeUrl: boolean
}): Promise<void> {
  if (!url) {
    throw new Error('Only HTTP and HTTPS URLs can be summarized')
  }

  const markdown = createMarkdownConverters(ctx, { isYoutubeUrl })
  if (ctx.firecrawlMode === 'always' && !ctx.apiStatus.firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  writeVerbose(
    ctx.stderr,
    ctx.verbose,
    `config url=${url} timeoutMs=${ctx.timeoutMs} youtube=${ctx.youtubeMode} firecrawl=${ctx.firecrawlMode} length=${
      ctx.lengthArg.kind === 'preset'
        ? ctx.lengthArg.preset
        : `${ctx.lengthArg.maxCharacters} chars`
    } maxOutputTokens=${formatOptionalNumber(ctx.maxOutputTokensArg)} retries=${ctx.retries} json=${ctx.json} extract=${ctx.extractMode} format=${ctx.format} preprocess=${ctx.preprocessMode} markdownMode=${ctx.markdownMode} model=${ctx.requestedModelLabel} videoMode=${ctx.videoMode} stream=${ctx.streamingEnabled ? 'on' : 'off'} plain=${ctx.plain}`,
    ctx.verboseColor
  )
  writeVerbose(
    ctx.stderr,
    ctx.verbose,
    `configFile path=${formatOptionalString(ctx.configPath)} model=${formatOptionalString(
      ctx.configModelLabel
    )}`,
    ctx.verboseColor
  )
  writeVerbose(
    ctx.stderr,
    ctx.verbose,
    `env xaiKey=${Boolean(ctx.apiStatus.xaiApiKey)} openaiKey=${Boolean(ctx.apiStatus.apiKey)} zaiKey=${Boolean(ctx.apiStatus.zaiApiKey)} googleKey=${ctx.apiStatus.googleConfigured} anthropicKey=${ctx.apiStatus.anthropicConfigured} openrouterKey=${ctx.apiStatus.openrouterConfigured} apifyToken=${Boolean(ctx.apiStatus.apifyToken)} firecrawlKey=${ctx.apiStatus.firecrawlConfigured}`,
    ctx.verboseColor
  )
  writeVerbose(
    ctx.stderr,
    ctx.verbose,
    `markdown requested=${markdown.markdownRequested} provider=${markdown.markdownProvider}`,
    ctx.verboseColor
  )

  const firecrawlApiKey = ctx.apiStatus.firecrawlApiKey
  const scrapeWithFirecrawl =
    ctx.apiStatus.firecrawlConfigured && ctx.firecrawlMode !== 'off' && firecrawlApiKey
      ? createFirecrawlScraper({
          apiKey: firecrawlApiKey,
          fetchImpl: ctx.trackedFetch,
        })
      : null

  const readTweetWithBirdClient = hasBirdCli(ctx.env)
    ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
        readTweetWithBird({ url, timeoutMs, env: ctx.env })
    : null

  writeVerbose(ctx.stderr, ctx.verbose, 'extract start', ctx.verboseColor)
  const oscProgress = createOscProgressController({
    label: 'Fetching website',
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  })
  oscProgress.setIndeterminate('Fetching website')
  const spinner = startSpinner({
    text: 'Fetching website (connecting)…',
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
  })
  const websiteProgress = createWebsiteProgress({
    enabled: ctx.progressEnabled,
    spinner,
    oscProgress,
  })

  const client = createLinkPreviewClient({
    apifyApiToken: ctx.apiStatus.apifyToken,
    ytDlpPath: ctx.apiStatus.ytDlpPath,
    falApiKey: ctx.apiStatus.falApiKey,
    openaiApiKey: ctx.apiStatus.openaiTranscriptionKey,
    scrapeWithFirecrawl,
    convertHtmlToMarkdown: markdown.convertHtmlToMarkdown,
    readTweetWithBird: readTweetWithBirdClient,
    fetch: ctx.trackedFetch,
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
  const clearProgressLine = () => {
    spinner.pause()
    oscProgress.clear()
    queueMicrotask(() => spinner.resume())
  }
  ctx.setClearProgressBeforeStdout(clearProgressLine)
  try {
    let extracted = await fetchLinkContentWithBirdTip({
      client,
      url,
      options: {
        timeoutMs: ctx.timeoutMs,
        youtubeTranscript: ctx.youtubeMode,
        firecrawl: ctx.firecrawlMode,
        format: markdown.markdownRequested ? 'markdown' : 'text',
        markdownMode: markdown.markdownRequested ? markdown.effectiveMarkdownMode : undefined,
      },
      env: ctx.env,
    })
    let extractionUi = deriveExtractionUi(extracted)

    const updateSummaryProgress = () => {
      if (!ctx.progressEnabled) return
      websiteProgress?.stop?.()
      if (!ctx.extractMode) {
        oscProgress.setIndeterminate('Summarizing')
      }
      spinner.setText(
        ctx.extractMode
          ? `Extracted (${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})`
          : `Summarizing (sent ${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})…`
      )
    }

    updateSummaryProgress()
    logExtractionDiagnostics({
      extracted,
      stderr: ctx.stderr,
      verbose: ctx.verbose,
      verboseColor: ctx.verboseColor,
    })

    if (
      ctx.extractMode &&
      markdown.markdownRequested &&
      ctx.preprocessMode !== 'off' &&
      markdown.effectiveMarkdownMode === 'auto' &&
      !extracted.diagnostics.markdown.used &&
      !hasUvxCli(ctx.env)
    ) {
      ctx.stderr.write(`${UVX_TIP}\n`)
    }

    if (!isYoutubeUrl && extracted.isVideoOnly && extracted.video) {
      if (extracted.video.kind === 'youtube') {
        writeVerbose(
          ctx.stderr,
          ctx.verbose,
          `video-only page detected; switching to YouTube URL ${extracted.video.url}`,
          ctx.verboseColor
        )
        if (ctx.progressEnabled) {
          spinner.setText('Video-only page: fetching YouTube transcript…')
        }
        extracted = await fetchLinkContentWithBirdTip({
          client,
          url: extracted.video.url,
          options: {
            timeoutMs: ctx.timeoutMs,
            youtubeTranscript: ctx.youtubeMode,
            firecrawl: ctx.firecrawlMode,
            format: markdown.markdownRequested ? 'markdown' : 'text',
            markdownMode: markdown.markdownRequested ? markdown.effectiveMarkdownMode : undefined,
          },
          env: ctx.env,
        })
        extractionUi = deriveExtractionUi(extracted)
        updateSummaryProgress()
      } else if (extracted.video.kind === 'direct') {
        const wantsVideoUnderstanding = ctx.videoMode === 'understand' || ctx.videoMode === 'auto'
        // Direct video URLs require a model that can consume video attachments (currently Gemini).
        const canVideoUnderstand =
          wantsVideoUnderstanding &&
          ctx.apiStatus.googleConfigured &&
          (ctx.requestedModel.kind === 'auto' ||
            (ctx.fixedModelSpec?.transport === 'native' &&
              ctx.fixedModelSpec.provider === 'google'))

        if (canVideoUnderstand) {
          if (ctx.progressEnabled) spinner.setText('Downloading video…')
          const loadedVideo = await loadRemoteAsset({
            url: extracted.video.url,
            fetchImpl: ctx.trackedFetch,
            timeoutMs: ctx.timeoutMs,
          })
          assertAssetMediaTypeSupported({ attachment: loadedVideo.attachment, sizeLabel: null })

          let chosenModel: string | null = null
          if (ctx.progressEnabled) spinner.setText('Summarizing video…')
          await ctx.summarizeAsset({
            sourceKind: 'asset-url',
            sourceLabel: loadedVideo.sourceLabel,
            attachment: loadedVideo.attachment,
            onModelChosen: (modelId) => {
              chosenModel = modelId
              if (ctx.progressEnabled) spinner.setText(`Summarizing video (model: ${modelId})…`)
            },
          })
          ctx.writeViaFooter([
            ...extractionUi.footerParts,
            ...(chosenModel ? [`model ${chosenModel}`] : []),
          ])
          return
        }
      }
    }

    const prompt = buildUrlPrompt({
      extracted,
      outputLanguage: ctx.outputLanguage,
      lengthArg: ctx.lengthArg,
    })

    // Whisper transcription costs need to be folded into the finish line totals.
    const transcriptionCostUsd = estimateWhisperTranscriptionCostUsd({
      transcriptionProvider: extracted.transcriptionProvider,
      transcriptSource: extracted.transcriptSource,
      mediaDurationSeconds: extracted.mediaDurationSeconds,
      openaiWhisperUsdPerMinute: ctx.openaiWhisperUsdPerMinute,
    })
    const transcriptionCostLabel =
      typeof transcriptionCostUsd === 'number' ? `txcost=${formatUSD(transcriptionCostUsd)}` : null
    ctx.setTranscriptionCost(transcriptionCostUsd, transcriptionCostLabel)

    if (ctx.extractMode) {
      await outputExtractedUrl({
        ctx,
        url,
        extracted,
        extractionUi,
        prompt,
        effectiveMarkdownMode: markdown.effectiveMarkdownMode,
        transcriptionCostLabel,
      })
      return
    }

    const onModelChosen = (modelId: string) => {
      if (!ctx.progressEnabled) return
      spinner.setText(
        `Summarizing (sent ${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel}, model: ${modelId})…`
      )
    }

    await summarizeExtractedUrl({
      ctx,
      url,
      extracted,
      extractionUi,
      prompt,
      effectiveMarkdownMode: markdown.effectiveMarkdownMode,
      transcriptionCostLabel,
      onModelChosen,
    })
  } finally {
    ctx.clearProgressIfCurrent(clearProgressLine)
    stopProgress()
  }
}
