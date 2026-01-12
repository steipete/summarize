import { promises as fs } from 'node:fs'

import { buildExtractCacheKey, buildSlidesCacheKey } from '../../../cache.js'
import { loadRemoteAsset } from '../../../content/asset.js'
import {
  createLinkPreviewClient,
  type ExtractedLinkContent,
  type FetchLinkContentOptions,
} from '../../../content/index.js'
import { createFirecrawlScraper } from '../../../firecrawl.js'
import {
  extractSlidesForSource,
  resolveSlideSource,
  type SlideExtractionResult,
} from '../../../slides/index.js'
import { createOscProgressController } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import { createWebsiteProgress } from '../../../tty/website-progress.js'
import { assertAssetMediaTypeSupported } from '../../attachments.js'
import { readTweetWithBird } from '../../bird.js'
import { UVX_TIP } from '../../constants.js'
import { resolveTwitterCookies } from '../../cookies/twitter.js'
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

  const { io, flags, model, cache: cacheState, hooks } = ctx

  const markdown = createMarkdownConverters(ctx, { isYoutubeUrl })
  if (flags.firecrawlMode === 'always' && !model.apiStatus.firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  writeVerbose(
    io.stderr,
    flags.verbose,
    `config url=${url} timeoutMs=${flags.timeoutMs} youtube=${flags.youtubeMode} firecrawl=${flags.firecrawlMode} length=${
      flags.lengthArg.kind === 'preset'
        ? flags.lengthArg.preset
        : `${flags.lengthArg.maxCharacters} chars`
    } maxOutputTokens=${formatOptionalNumber(flags.maxOutputTokensArg)} retries=${flags.retries} json=${flags.json} extract=${flags.extractMode} format=${flags.format} preprocess=${flags.preprocessMode} markdownMode=${flags.markdownMode} model=${model.requestedModelLabel} videoMode=${flags.videoMode} timestamps=${flags.transcriptTimestamps ? 'on' : 'off'} stream=${flags.streamingEnabled ? 'on' : 'off'} plain=${flags.plain}`,
    flags.verboseColor
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `configFile path=${formatOptionalString(flags.configPath)} model=${formatOptionalString(
      flags.configModelLabel
    )}`,
    flags.verboseColor
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `env xaiKey=${Boolean(model.apiStatus.xaiApiKey)} openaiKey=${Boolean(model.apiStatus.apiKey)} zaiKey=${Boolean(model.apiStatus.zaiApiKey)} googleKey=${model.apiStatus.googleConfigured} anthropicKey=${model.apiStatus.anthropicConfigured} openrouterKey=${model.apiStatus.openrouterConfigured} apifyToken=${Boolean(model.apiStatus.apifyToken)} firecrawlKey=${model.apiStatus.firecrawlConfigured}`,
    flags.verboseColor
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `markdown htmlRequested=${markdown.markdownRequested} transcriptRequested=${markdown.transcriptMarkdownRequested} provider=${markdown.markdownProvider}`,
    flags.verboseColor
  )

  const firecrawlApiKey = model.apiStatus.firecrawlApiKey
  const scrapeWithFirecrawl =
    model.apiStatus.firecrawlConfigured && flags.firecrawlMode !== 'off' && firecrawlApiKey
      ? createFirecrawlScraper({
          apiKey: firecrawlApiKey,
          fetchImpl: io.fetch,
        })
      : null

  const readTweetWithBirdClient = hasBirdCli(io.env)
    ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
        readTweetWithBird({ url, timeoutMs, env: io.env })
    : null

  writeVerbose(io.stderr, flags.verbose, 'extract start', flags.verboseColor)
  const oscProgress = createOscProgressController({
    label: 'Fetching website',
    env: io.env,
    isTty: flags.progressEnabled,
    write: (data: string) => io.stderr.write(data),
  })
  oscProgress.setIndeterminate('Fetching website')
  const spinner = startSpinner({
    text: 'Fetching website (connecting)…',
    enabled: flags.progressEnabled,
    stream: io.stderr,
  })
  const websiteProgress = createWebsiteProgress({
    enabled: flags.progressEnabled,
    spinner,
    oscProgress,
  })

  const cacheStore = cacheState.mode === 'default' ? cacheState.store : null
  const transcriptCache = cacheStore ? cacheStore.transcriptCache : null

  const client = createLinkPreviewClient({
    env: io.envForRun,
    apifyApiToken: model.apiStatus.apifyToken,
    ytDlpPath: model.apiStatus.ytDlpPath,
    falApiKey: model.apiStatus.falApiKey,
    openaiApiKey: model.apiStatus.openaiTranscriptionKey,
    scrapeWithFirecrawl,
    convertHtmlToMarkdown: markdown.convertHtmlToMarkdown,
    readTweetWithBird: readTweetWithBirdClient,
    resolveTwitterCookies: async (_args) => {
      const res = await resolveTwitterCookies({ env: io.env })
      return {
        cookiesFromBrowser: res.cookies.cookiesFromBrowser,
        source: res.cookies.source,
        warnings: res.warnings,
      }
    },
    fetch: io.fetch,
    transcriptCache,
    onProgress:
      websiteProgress || hooks.onLinkPreviewProgress
        ? (event) => {
            websiteProgress?.onProgress(event)
            hooks.onLinkPreviewProgress?.(event)
          }
        : null,
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
    stopProgress()
  }
  hooks.setClearProgressBeforeStdout(clearProgressLine)
  try {
    const buildFetchOptions = (): FetchLinkContentOptions => ({
      timeoutMs: flags.timeoutMs,
      maxCharacters:
        typeof flags.maxExtractCharacters === 'number' && flags.maxExtractCharacters > 0
          ? flags.maxExtractCharacters
          : undefined,
      youtubeTranscript: flags.youtubeMode,
      mediaTranscript: flags.videoMode === 'transcript' ? 'prefer' : 'auto',
      transcriptTimestamps: flags.transcriptTimestamps,
      firecrawl: flags.firecrawlMode,
      format: markdown.markdownRequested ? 'markdown' : 'text',
      markdownMode: markdown.markdownRequested ? markdown.effectiveMarkdownMode : undefined,
      cacheMode: cacheState.mode,
    })

    const fetchWithCache = async (targetUrl: string): Promise<ExtractedLinkContent> => {
      const options = buildFetchOptions()
      const cacheKey =
        cacheStore && cacheState.mode === 'default'
          ? buildExtractCacheKey({
              url: targetUrl,
              options: {
                youtubeTranscript: options.youtubeTranscript,
                mediaTranscript: options.mediaTranscript,
                firecrawl: options.firecrawl,
                format: options.format,
                markdownMode: options.markdownMode ?? null,
                transcriptTimestamps: options.transcriptTimestamps ?? false,
                ...(typeof options.maxCharacters === 'number'
                  ? { maxCharacters: options.maxCharacters }
                  : {}),
              },
            })
          : null
      if (cacheKey && cacheStore) {
        const cached = cacheStore.getJson<ExtractedLinkContent>('extract', cacheKey)
        if (cached) {
          writeVerbose(io.stderr, flags.verbose, 'cache hit extract', flags.verboseColor)
          return cached
        }
        writeVerbose(io.stderr, flags.verbose, 'cache miss extract', flags.verboseColor)
      }
      const extracted = await fetchLinkContentWithBirdTip({
        client,
        url: targetUrl,
        options,
        env: io.env,
      })
      if (cacheKey && cacheStore) {
        cacheStore.setJson('extract', cacheKey, extracted, cacheState.ttlMs)
        writeVerbose(io.stderr, flags.verbose, 'cache write extract', flags.verboseColor)
      }
      return extracted
    }

    let extracted = await fetchWithCache(url)
    let extractionUi = deriveExtractionUi(extracted)
    let slidesResult: SlideExtractionResult | null = null

    const isCachedSlidesValid = async (
      cached: SlideExtractionResult,
      source: { sourceId: string; kind: string }
    ): Promise<boolean> => {
      if (!cached || cached.slides.length === 0) return false
      if (cached.sourceId !== source.sourceId || cached.sourceKind !== source.kind) return false
      try {
        await fs.stat(cached.slidesDir)
      } catch {
        return false
      }
      for (const slide of cached.slides) {
        if (!slide.imagePath) return false
        try {
          await fs.stat(slide.imagePath)
        } catch {
          return false
        }
      }
      return true
    }

    const runSlidesExtraction = async () => {
      if (!flags.slides || slidesResult) return
      const source = resolveSlideSource({ url, extracted })
      if (!source) {
        throw new Error('Slides are only supported for YouTube or direct video URLs.')
      }
      const slidesCacheKey =
        cacheStore && cacheState.mode === 'default'
          ? buildSlidesCacheKey({ url: source.url, settings: flags.slides })
          : null
      if (slidesCacheKey && cacheStore) {
        const cached = cacheStore.getJson<SlideExtractionResult>('slides', slidesCacheKey)
        if (cached && (await isCachedSlidesValid(cached, source))) {
          writeVerbose(io.stderr, flags.verbose, 'cache hit slides', flags.verboseColor)
          slidesResult = cached
          ctx.hooks.onSlidesExtracted?.(slidesResult)
          ctx.hooks.onSlidesProgress?.('Slides: cached')
          return
        }
        writeVerbose(io.stderr, flags.verbose, 'cache miss slides', flags.verboseColor)
      }
      if (flags.progressEnabled) {
        spinner.setText('Extracting slides…')
        oscProgress.setIndeterminate('Extracting slides')
      }
      ctx.hooks.onSlidesProgress?.('Slides: extracting…')
      slidesResult = await extractSlidesForSource({
        source,
        settings: flags.slides,
        env: io.env,
        timeoutMs: flags.timeoutMs,
        ytDlpPath: model.apiStatus.ytDlpPath,
        ffmpegPath: null,
        tesseractPath: null,
        hooks: {
          onSlideChunk: (chunk) => ctx.hooks.onSlideChunk?.(chunk),
        },
      })
      if (slidesResult) {
        ctx.hooks.onSlidesExtracted?.(slidesResult)
        ctx.hooks.onSlidesProgress?.(
          `Slides: done (${slidesResult.slides.length.toString()} slides)`
        )
        if (slidesCacheKey && cacheStore) {
          cacheStore.setJson('slides', slidesCacheKey, slidesResult, cacheState.ttlMs)
          writeVerbose(io.stderr, flags.verbose, 'cache write slides', flags.verboseColor)
        }
      }
      if (flags.progressEnabled) {
        updateSummaryProgress()
      }
    }

    const updateSummaryProgress = () => {
      if (!flags.progressEnabled) return
      websiteProgress?.stop?.()
      if (!flags.extractMode) {
        oscProgress.setIndeterminate('Summarizing')
      }
      spinner.setText(
        flags.extractMode
          ? `Extracted (${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})`
          : `Summarizing (sent ${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})…`
      )
    }

    updateSummaryProgress()
    logExtractionDiagnostics({
      extracted,
      stderr: io.stderr,
      verbose: flags.verbose,
      verboseColor: flags.verboseColor,
    })
    const transcriptCacheStatus = extracted.diagnostics?.transcript?.cacheStatus
    if (transcriptCacheStatus && transcriptCacheStatus !== 'unknown') {
      writeVerbose(
        io.stderr,
        flags.verbose,
        `cache ${transcriptCacheStatus} transcript`,
        flags.verboseColor
      )
    }

    if (
      flags.extractMode &&
      markdown.markdownRequested &&
      flags.preprocessMode !== 'off' &&
      markdown.effectiveMarkdownMode === 'auto' &&
      !extracted.diagnostics.markdown.used &&
      !hasUvxCli(io.env)
    ) {
      io.stderr.write(`${UVX_TIP}\n`)
    }

    if (!isYoutubeUrl && extracted.isVideoOnly && extracted.video) {
      if (extracted.video.kind === 'youtube') {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `video-only page detected; switching to YouTube URL ${extracted.video.url}`,
          flags.verboseColor
        )
        if (flags.progressEnabled) {
          spinner.setText('Video-only page: fetching YouTube transcript…')
        }
        extracted = await fetchWithCache(extracted.video.url)
        extractionUi = deriveExtractionUi(extracted)
        updateSummaryProgress()
      } else if (extracted.video.kind === 'direct') {
        await runSlidesExtraction()
        const wantsVideoUnderstanding =
          flags.videoMode === 'understand' || flags.videoMode === 'auto'
        // Direct video URLs require a model that can consume video attachments (currently Gemini).
        const canVideoUnderstand =
          wantsVideoUnderstanding &&
          model.apiStatus.googleConfigured &&
          (model.requestedModel.kind === 'auto' ||
            (model.fixedModelSpec?.transport === 'native' &&
              model.fixedModelSpec.provider === 'google'))

        if (canVideoUnderstand) {
          hooks.onExtracted?.(extracted)
          if (flags.progressEnabled) spinner.setText('Downloading video…')
          const loadedVideo = await loadRemoteAsset({
            url: extracted.video.url,
            fetchImpl: io.fetch,
            timeoutMs: flags.timeoutMs,
          })
          assertAssetMediaTypeSupported({ attachment: loadedVideo.attachment, sizeLabel: null })

          let chosenModel: string | null = null
          if (flags.progressEnabled) spinner.setText('Summarizing video…')
          await hooks.summarizeAsset({
            sourceKind: 'asset-url',
            sourceLabel: loadedVideo.sourceLabel,
            attachment: loadedVideo.attachment,
            onModelChosen: (modelId) => {
              chosenModel = modelId
              hooks.onModelChosen?.(modelId)
              if (flags.progressEnabled) spinner.setText(`Summarizing video (model: ${modelId})…`)
            },
          })
          const slideCount = slidesResult
            ? (slidesResult as SlideExtractionResult).slides.length
            : null
          hooks.writeViaFooter([
            ...extractionUi.footerParts,
            ...(chosenModel ? [`model ${chosenModel}`] : []),
            ...(slideCount != null ? [`slides ${slideCount}`] : []),
          ])
          return
        }
      }
    }

    await runSlidesExtraction()

    hooks.onExtracted?.(extracted)

    const prompt = buildUrlPrompt({
      extracted,
      outputLanguage: flags.outputLanguage,
      lengthArg: flags.lengthArg,
      promptOverride: flags.promptOverride ?? null,
      lengthInstruction: flags.lengthInstruction ?? null,
      languageInstruction: flags.languageInstruction ?? null,
      slides: slidesResult,
    })

    // Whisper transcription costs need to be folded into the finish line totals.
    const transcriptionCostUsd = estimateWhisperTranscriptionCostUsd({
      transcriptionProvider: extracted.transcriptionProvider,
      transcriptSource: extracted.transcriptSource,
      mediaDurationSeconds: extracted.mediaDurationSeconds,
      openaiWhisperUsdPerMinute: model.openaiWhisperUsdPerMinute,
    })
    const transcriptionCostLabel =
      typeof transcriptionCostUsd === 'number' ? `txcost=${formatUSD(transcriptionCostUsd)}` : null
    hooks.setTranscriptionCost(transcriptionCostUsd, transcriptionCostLabel)

    if (flags.extractMode) {
      // Apply transcript→markdown conversion if requested
      let extractedForOutput = extracted
      if (markdown.transcriptMarkdownRequested && markdown.convertTranscriptToMarkdown) {
        if (flags.progressEnabled) {
          spinner.setText('Converting transcript to markdown…')
        }
        const markdownContent = await markdown.convertTranscriptToMarkdown({
          title: extracted.title,
          source: extracted.siteName,
          transcript: extracted.content,
          timeoutMs: flags.timeoutMs,
        })
        extractedForOutput = {
          ...extracted,
          content: markdownContent,
          diagnostics: {
            ...extracted.diagnostics,
            markdown: {
              ...extracted.diagnostics.markdown,
              requested: true,
              used: true,
              provider: 'llm',
              notes: 'transcript',
            },
          },
        }
        extractionUi = deriveExtractionUi(extractedForOutput)
      }
      await outputExtractedUrl({
        ctx,
        url,
        extracted: extractedForOutput,
        extractionUi,
        prompt,
        effectiveMarkdownMode: markdown.effectiveMarkdownMode,
        transcriptionCostLabel,
        slides: slidesResult,
      })
      return
    }

    const onModelChosen = (modelId: string) => {
      hooks.onModelChosen?.(modelId)
      if (!flags.progressEnabled) return
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
      slides: slidesResult,
    })
  } finally {
    hooks.clearProgressIfCurrent(clearProgressLine)
    stopProgress()
  }
}
