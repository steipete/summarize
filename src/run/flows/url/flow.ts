import * as urlUtils from '@steipete/summarize-core/content/url'

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
  validateSlidesCache,
} from '../../../slides/index.js'
import { createOscProgressController } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from '../../../tty/theme.js'
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
import { createSlidesTerminalOutput } from './slides-output.js'
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
  const theme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: io.envForRun.SUMMARIZE_THEME }),
    enabled: flags.verboseColor,
    trueColor: resolveTrueColor(io.envForRun),
  })

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
    flags.verboseColor,
    io.envForRun
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `configFile path=${formatOptionalString(flags.configPath)} model=${formatOptionalString(
      flags.configModelLabel
    )}`,
    flags.verboseColor,
    io.envForRun
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `env xaiKey=${Boolean(model.apiStatus.xaiApiKey)} openaiKey=${Boolean(model.apiStatus.apiKey)} zaiKey=${Boolean(model.apiStatus.zaiApiKey)} googleKey=${model.apiStatus.googleConfigured} anthropicKey=${model.apiStatus.anthropicConfigured} openrouterKey=${model.apiStatus.openrouterConfigured} apifyToken=${Boolean(model.apiStatus.apifyToken)} firecrawlKey=${model.apiStatus.firecrawlConfigured}`,
    flags.verboseColor,
    io.envForRun
  )
  writeVerbose(
    io.stderr,
    flags.verbose,
    `markdown htmlRequested=${markdown.markdownRequested} transcriptRequested=${markdown.transcriptMarkdownRequested} provider=${markdown.markdownProvider}`,
    flags.verboseColor,
    io.envForRun
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

  writeVerbose(io.stderr, flags.verbose, 'extract start', flags.verboseColor, io.envForRun)
  const oscProgress = createOscProgressController({
    label: 'Fetching website',
    env: io.env,
    isTty: flags.progressEnabled,
    write: (data: string) => io.stderr.write(data),
  })
  oscProgress.setIndeterminate('Fetching website')
  const spinner = startSpinner({
    text: `${theme.label('Fetching website')}${theme.dim(' (connecting)…')}`,
    enabled: flags.progressEnabled,
    stream: io.stderr,
    color: theme.palette.spinner,
  })
  const styleLabel = (text: string) => theme.label(text)
  const styleDim = (text: string) => theme.dim(text)
  const renderStatus = (label: string, detail = '…') => `${styleLabel(label)}${styleDim(detail)}`
  const renderStatusWithMeta = (label: string, meta: string, suffix = '…') =>
    `${styleLabel(label)} ${meta}${styleDim(suffix)}`
  const renderStatusFromText = (text: string) => {
    const match = text.match(/^([^:]+):(.*)$/)
    if (!match) return styleLabel(text)
    return `${styleLabel(match[1])}${styleDim(`:${match[2]}`)}`
  }
  const handleSignal = () => {
    try {
      spinner.stopAndClear()
    } catch {
      // ignore
    }
    oscProgress.clear()
  }
  const handleSigint = () => {
    handleSignal()
    process.exit(130)
  }
  const handleSigterm = () => {
    handleSignal()
    process.exit(143)
  }
  if (flags.progressEnabled) {
    process.once('SIGINT', handleSigint)
    process.once('SIGTERM', handleSigterm)
  }
  if (!hooks.onSlidesProgress && flags.progressEnabled) {
    hooks.onSlidesProgress = (text: string) => {
      const match = text.match(/(\d{1,3})%/)
      const percent = match ? Number(match[1]) : null
      spinner.setText(renderStatusFromText(text))
      if (Number.isFinite(percent) && percent !== null) {
        oscProgress.setPercent('Slides', Math.max(0, Math.min(100, percent)))
      } else {
        oscProgress.setIndeterminate('Slides')
      }
    }
  }
  const websiteProgress = createWebsiteProgress({
    enabled: flags.progressEnabled,
    spinner,
    oscProgress,
    theme,
  })

  const cacheStore = cacheState.mode === 'default' ? cacheState.store : null
  const transcriptCache = cacheStore ? cacheStore.transcriptCache : null

  const client = createLinkPreviewClient({
    env: io.envForRun,
    apifyApiToken: model.apiStatus.apifyToken,
    ytDlpPath: model.apiStatus.ytDlpPath,
    transcription: {
      env: io.envForRun,
      falApiKey: model.apiStatus.falApiKey,
      groqApiKey: model.apiStatus.groqApiKey,
      openaiApiKey: model.apiStatus.openaiTranscriptionKey,
    },
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
    mediaCache: ctx.mediaCache ?? null,
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
  const pauseProgressLine = () => {
    spinner.pause()
    return () => spinner.resume()
  }
  hooks.setClearProgressBeforeStdout(pauseProgressLine)
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

    const fetchWithCache = async (
      targetUrl: string,
      {
        bypassExtractCache = false,
      }: {
        bypassExtractCache?: boolean
      } = {}
    ): Promise<ExtractedLinkContent> => {
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
      if (!bypassExtractCache && cacheKey && cacheStore) {
        const cached = cacheStore.getJson<ExtractedLinkContent>('extract', cacheKey)
        if (cached) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            'cache hit extract',
            flags.verboseColor,
            io.envForRun
          )
          return cached
        }
        writeVerbose(
          io.stderr,
          flags.verbose,
          'cache miss extract',
          flags.verboseColor,
          io.envForRun
        )
      }
      try {
        const extracted = await fetchLinkContentWithBirdTip({
          client,
          url: targetUrl,
          options,
          env: io.env,
        })
        if (cacheKey && cacheStore) {
          cacheStore.setJson('extract', cacheKey, extracted, cacheState.ttlMs)
          writeVerbose(
            io.stderr,
            flags.verbose,
            'cache write extract',
            flags.verboseColor,
            io.envForRun
          )
        }
        return extracted
      } catch (err) {
        const preferUrlMode =
          typeof urlUtils.shouldPreferUrlMode === 'function'
            ? urlUtils.shouldPreferUrlMode(targetUrl)
            : false
        const isTwitter = urlUtils.isTwitterStatusUrl?.(targetUrl) ?? false
        if (!preferUrlMode || isTwitter) throw err
        // Fallback: skip HTML fetch and proceed with URL-only extraction (YouTube/direct media).
        writeVerbose(
          io.stderr,
          flags.verbose,
          `extract fallback url-only (${(err as Error).message ?? String(err)})`,
          flags.verboseColor,
          io.envForRun
        )
        return {
          content: '',
          title: null,
          description: null,
          url: targetUrl,
          siteName: null,
          wordCount: 0,
          totalCharacters: 0,
          truncated: false,
          mediaDurationSeconds: null,
          video: null,
          isVideoOnly: true,
          transcriptSource: null,
          transcriptCharacters: null,
          transcriptWordCount: null,
          transcriptLines: null,
          transcriptMetadata: null,
          transcriptSegments: null,
          transcriptTimedText: null,
          transcriptionProvider: null,
          diagnostics: {
            strategy: 'html',
            firecrawl: {
              attempted: false,
              used: false,
              cacheMode: cacheState.mode,
              cacheStatus: 'bypassed',
              notes: 'skipped (url-only fallback)',
            },
            markdown: {
              requested: false,
              used: false,
              provider: null,
              notes: 'skipped (url fallback)',
            },
            transcript: {
              cacheMode: cacheState.mode,
              cacheStatus: 'unknown',
              textProvided: false,
              provider: null,
              attemptedProviders: [],
            },
          },
        }
      }
    }

    let extracted = await fetchWithCache(url)
    if (flags.slides && !resolveSlideSource({ url, extracted })) {
      const isTwitter = urlUtils.isTwitterStatusUrl?.(url) ?? false
      if (isTwitter) {
        const refreshed = await fetchWithCache(url, { bypassExtractCache: true })
        if (resolveSlideSource({ url, extracted: refreshed })) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            'extract refresh for slides',
            flags.verboseColor,
            io.envForRun
          )
          extracted = refreshed
        }
      }
    }
    let extractionUi = deriveExtractionUi(extracted)
    let slidesExtracted: SlideExtractionResult | null = null
    let slidesDone = false
    let slidesTimelineResolved = false
    let resolveSlidesTimeline: ((value: SlideExtractionResult | null) => void) | null = null
    const slidesTimelinePromise = flags.slides
      ? new Promise<SlideExtractionResult | null>((resolve) => {
          resolveSlidesTimeline = resolve
        })
      : null

    const resolveTimeline = (value: SlideExtractionResult | null) => {
      if (slidesTimelineResolved) return
      slidesTimelineResolved = true
      resolveSlidesTimeline?.(value)
    }
    const slidesOutputEnabled =
      Boolean(flags.slides) && flags.slidesOutput !== false && !flags.json && !flags.extractMode
    const slidesOutput = createSlidesTerminalOutput({
      io,
      flags: { plain: flags.plain, lengthArg: flags.lengthArg, slidesDebug: flags.slidesDebug },
      extracted,
      slides: null,
      enabled: slidesOutputEnabled,
      outputMode: 'delta',
      clearProgressForStdout: hooks.clearProgressForStdout,
      restoreProgressAfterStdout: hooks.restoreProgressAfterStdout ?? null,
      onProgressText: flags.progressEnabled
        ? (text) => spinner.setText(renderStatusFromText(text))
        : null,
    })

    if (slidesOutput) {
      const existingSlidesExtracted = hooks.onSlidesExtracted
      const existingSlidesDone = hooks.onSlidesDone
      const existingSlideChunk = hooks.onSlideChunk
      hooks.onSlidesExtracted = (value) => {
        existingSlidesExtracted?.(value)
        slidesOutput.onSlidesExtracted(value)
      }
      hooks.onSlidesDone = (result) => {
        existingSlidesDone?.(result)
        slidesOutput.onSlidesDone(result)
      }
      hooks.onSlideChunk = (chunk) => {
        existingSlideChunk?.(chunk)
        slidesOutput.onSlideChunk(chunk)
      }
    }

    const markSlidesDone = (result: { ok: boolean; error?: string | null }) => {
      if (slidesDone) return
      slidesDone = true
      hooks.onSlidesDone?.(result)
    }

    const runSlidesExtraction = async (): Promise<SlideExtractionResult | null> => {
      if (!flags.slides) return null
      if (slidesExtracted) {
        if (!slidesDone) markSlidesDone({ ok: true })
        return slidesExtracted
      }
      let errorMessage: string | null = null
      try {
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
          const validated = cached
            ? await validateSlidesCache({ cached, source, settings: flags.slides })
            : null
          if (validated) {
            writeVerbose(
              io.stderr,
              flags.verbose,
              'cache hit slides',
              flags.verboseColor,
              io.envForRun
            )
            slidesExtracted = validated
            resolveTimeline(validated)
            ctx.hooks.onSlidesExtracted?.(slidesExtracted)
            ctx.hooks.onSlidesProgress?.('Slides: cached 100%')
            return slidesExtracted
          }
          writeVerbose(
            io.stderr,
            flags.verbose,
            'cache miss slides',
            flags.verboseColor,
            io.envForRun
          )
        }
        if (flags.progressEnabled) {
          spinner.setText(renderStatus('Extracting slides'))
          oscProgress.setIndeterminate('Extracting slides')
        }
        // Prefer indeterminate progress until we get real percentage updates from the slide pipeline.
        ctx.hooks.onSlidesProgress?.('Slides: extracting')
        const onSlidesLog = (message: string) => {
          writeVerbose(
            io.stderr,
            flags.verbose,
            `slides ${message}`,
            flags.verboseColor,
            io.envForRun
          )
        }
        slidesExtracted = await extractSlidesForSource({
          source,
          settings: flags.slides,
          noCache: cacheState.mode === 'bypass',
          mediaCache: ctx.mediaCache,
          env: io.env,
          timeoutMs: flags.timeoutMs,
          ytDlpPath: model.apiStatus.ytDlpPath,
          ytDlpCookiesFromBrowser: model.apiStatus.ytDlpCookiesFromBrowser,
          ffmpegPath: null,
          tesseractPath: null,
          hooks: {
            onSlideChunk: (chunk) => ctx.hooks.onSlideChunk?.(chunk),
            onSlidesTimeline: (timeline) => {
              resolveTimeline(timeline)
              ctx.hooks.onSlidesExtracted?.(timeline)
            },
            onSlidesProgress: ctx.hooks.onSlidesProgress ?? undefined,
            onSlidesLog,
          },
        })
        if (slidesExtracted) {
          ctx.hooks.onSlidesExtracted?.(slidesExtracted)
          ctx.hooks.onSlidesProgress?.(
            `Slides: done (${slidesExtracted.slides.length.toString()} slides) 100%`
          )
          if (slidesCacheKey && cacheStore) {
            cacheStore.setJson('slides', slidesCacheKey, slidesExtracted, cacheState.ttlMs)
            writeVerbose(
              io.stderr,
              flags.verbose,
              'cache write slides',
              flags.verboseColor,
              io.envForRun
            )
          }
        }
        if (flags.progressEnabled) {
          updateSummaryProgress()
        }
        return slidesExtracted
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        if (!slidesTimelineResolved) {
          resolveTimeline(slidesExtracted ?? null)
        }
        if (!slidesDone) {
          markSlidesDone(errorMessage ? { ok: false, error: errorMessage } : { ok: true })
        }
      }
    }

    const formatSummaryProgress = (modelId?: string | null) => {
      const dim = (value: string) => theme.dim(value)
      const accent = (value: string) => theme.accent(value)
      const sentLabel = `${dim('sent ')}${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel}`
      const modelLabel = modelId ? `${dim('model: ')}${accent(modelId)}` : ''
      const meta = modelLabel ? `${sentLabel}${dim(', ')}${modelLabel}` : sentLabel
      return `${styleLabel('Summarizing')} ${dim('(')}${meta}${dim(')')}${dim('…')}`
    }

    const updateSummaryProgress = () => {
      if (!flags.progressEnabled) return
      websiteProgress?.stop?.()
      if (!flags.extractMode) {
        oscProgress.setIndeterminate('Summarizing')
      }
      spinner.setText(
        flags.extractMode
          ? `${styleLabel('Extracted')}${styleDim(
              ` (${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})`
            )}`
          : formatSummaryProgress()
      )
    }

    updateSummaryProgress()
    logExtractionDiagnostics({
      extracted,
      stderr: io.stderr,
      verbose: flags.verbose,
      verboseColor: flags.verboseColor,
      env: io.envForRun,
    })
    const transcriptCacheStatus = extracted.diagnostics?.transcript?.cacheStatus
    if (transcriptCacheStatus && transcriptCacheStatus !== 'unknown') {
      writeVerbose(
        io.stderr,
        flags.verbose,
        `cache ${transcriptCacheStatus} transcript`,
        flags.verboseColor,
        io.envForRun
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
          flags.verboseColor,
          io.envForRun
        )
        if (flags.progressEnabled) {
          spinner.setText(renderStatus('Video-only page', ': fetching YouTube transcript…'))
        }
        extracted = await fetchWithCache(extracted.video.url)
        extractionUi = deriveExtractionUi(extracted)
        updateSummaryProgress()
      } else if (extracted.video.kind === 'direct') {
        const directVideoSlides = await runSlidesExtraction()
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
          if (flags.progressEnabled) spinner.setText(renderStatus('Downloading video'))
          const loadedVideo = await loadRemoteAsset({
            url: extracted.video.url,
            fetchImpl: io.fetch,
            timeoutMs: flags.timeoutMs,
          })
          assertAssetMediaTypeSupported({ attachment: loadedVideo.attachment, sizeLabel: null })

          let chosenModel: string | null = null
          if (flags.progressEnabled) spinner.setText(renderStatus('Summarizing video'))
          await hooks.summarizeAsset({
            sourceKind: 'asset-url',
            sourceLabel: loadedVideo.sourceLabel,
            attachment: loadedVideo.attachment,
            onModelChosen: (modelId) => {
              chosenModel = modelId
              hooks.onModelChosen?.(modelId)
              if (flags.progressEnabled) {
                const meta = `${styleDim('(')}${styleDim('model: ')}${theme.accent(
                  modelId
                )}${styleDim(')')}`
                spinner.setText(renderStatusWithMeta('Summarizing video', meta))
              }
            },
          })
          const slideCount = directVideoSlides ? directVideoSlides.slides.length : null
          hooks.writeViaFooter([
            ...extractionUi.footerParts,
            ...(chosenModel ? [`model ${chosenModel}`] : []),
            ...(slideCount != null ? [`slides ${slideCount}`] : []),
          ])
          return
        }
      }
    }

    // Start slides in parallel; wait for real timing data before prompting.
    if (flags.slides) {
      void runSlidesExtraction().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.hooks.onSlidesProgress?.(`Slides: failed (${message})`)
        writeVerbose(
          io.stderr,
          flags.verbose,
          `slides failed: ${message}`,
          flags.verboseColor,
          io.envForRun
        )
      })
    }

    hooks.onExtracted?.(extracted)

    let slidesForPrompt: SlideExtractionResult | null = null
    if (slidesTimelinePromise) {
      slidesForPrompt = await slidesTimelinePromise
    }

    const prompt = buildUrlPrompt({
      extracted,
      outputLanguage: flags.outputLanguage,
      lengthArg: flags.lengthArg,
      promptOverride: flags.promptOverride ?? null,
      lengthInstruction: flags.lengthInstruction ?? null,
      languageInstruction: flags.languageInstruction ?? null,
      slides: slidesForPrompt ?? slidesExtracted ?? null,
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
          spinner.setText(renderStatus('Converting transcript to markdown'))
        }
        const markdownContent = await markdown.convertTranscriptToMarkdown({
          title: extracted.title,
          source: extracted.siteName,
          transcript: extracted.content,
          timeoutMs: flags.timeoutMs,
          outputLanguage: flags.outputLanguage,
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
        slides: slidesExtracted ?? slidesForPrompt ?? null,
        slidesOutput,
      })
      return
    }

    const onModelChosen = (modelId: string) => {
      hooks.onModelChosen?.(modelId)
      if (!flags.progressEnabled) return
      spinner.setText(formatSummaryProgress(modelId))
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
      slides: slidesExtracted ?? slidesForPrompt ?? null,
      slidesOutput,
    })
  } finally {
    if (flags.progressEnabled) {
      process.off('SIGINT', handleSigint)
      process.off('SIGTERM', handleSigterm)
    }
    hooks.clearProgressIfCurrent(pauseProgressLine)
    stopProgress()
  }
}
