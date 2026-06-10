import { type SlideExtractionResult } from "../../../slides/index.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../../../tty/theme.js";
import { UVX_TIP } from "../../constants.js";
import { hasUvxCli } from "../../env.js";
import {
  estimateWhisperTranscriptionCostUsd,
  formatOptionalNumber,
  formatOptionalString,
  formatUSD,
} from "../../format.js";
import { writeVerbose } from "../../logging.js";
import { deriveExtractionUi, logExtractionDiagnostics } from "./extract.js";
import { createUrlExtractionSession } from "./extraction-session.js";
import { createUrlFlowProgress, writeSlidesBackgroundFailureWarning } from "./flow-progress.js";
import { createMarkdownConverters } from "./markdown.js";
import { createUrlSlidesSession } from "./slides-session.js";
import { buildUrlPrompt, outputExtractedUrl, summarizeExtractedUrl } from "./summary.js";
import type { UrlFlowContext } from "./types.js";
import { handleVideoOnlyExtractedContent } from "./video-only.js";

export async function runUrlFlow({
  ctx,
  url,
  isYoutubeUrl,
}: {
  ctx: UrlFlowContext;
  url: string;
  isYoutubeUrl: boolean;
}): Promise<void> {
  if (!url) {
    throw new Error("Only HTTP and HTTPS URLs can be summarized");
  }

  const { io, flags, model, cache: cacheState, hooks } = ctx;
  ctx.perfTrace?.mark("url:start");
  const theme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: io.envForRun.SUMMARIZE_THEME }),
    enabled: flags.verboseColor,
    trueColor: resolveTrueColor(io.envForRun),
  });

  const markdown = createMarkdownConverters(ctx, { isYoutubeUrl });
  if (flags.firecrawlMode === "always" && isYoutubeUrl) {
    throw new Error(
      "--firecrawl always is not supported for YouTube URLs; use --youtube auto|web|yt-dlp|apify instead",
    );
  }
  if (flags.firecrawlMode === "always" && !model.apiStatus.firecrawlConfigured) {
    throw new Error("--firecrawl always requires FIRECRAWL_API_KEY");
  }

  writeVerbose(
    io.stderr,
    flags.verbose,
    `config url=${url} timeoutMs=${flags.timeoutMs} youtube=${flags.youtubeMode} firecrawl=${flags.firecrawlMode} length=${
      flags.lengthArg.kind === "preset"
        ? flags.lengthArg.preset
        : `${flags.lengthArg.maxCharacters} chars`
    } maxOutputTokens=${formatOptionalNumber(flags.maxOutputTokensArg)} retries=${flags.retries} json=${flags.json} extract=${flags.extractMode} format=${flags.format} preprocess=${flags.preprocessMode} markdownMode=${flags.markdownMode} model=${model.requestedModelLabel} videoMode=${flags.videoMode} timestamps=${flags.transcriptTimestamps ? "on" : "off"} diarize=${flags.transcriptDiarization ?? "off"} stream=${flags.streamingEnabled ? "on" : "off"} plain=${flags.plain}`,
    flags.verboseColor,
    io.envForRun,
  );
  writeVerbose(
    io.stderr,
    flags.verbose,
    `configFile path=${formatOptionalString(flags.configPath)} model=${formatOptionalString(
      flags.configModelLabel,
    )}`,
    flags.verboseColor,
    io.envForRun,
  );
  writeVerbose(
    io.stderr,
    flags.verbose,
    `env xaiKey=${Boolean(model.apiStatus.xaiApiKey)} openaiKey=${Boolean(model.apiStatus.apiKey)} zaiKey=${Boolean(model.apiStatus.zaiApiKey)} googleKey=${model.apiStatus.googleConfigured} anthropicKey=${model.apiStatus.anthropicConfigured} openrouterKey=${model.apiStatus.openrouterConfigured} apifyToken=${Boolean(model.apiStatus.apifyToken)} firecrawlKey=${model.apiStatus.firecrawlConfigured}`,
    flags.verboseColor,
    io.envForRun,
  );
  writeVerbose(
    io.stderr,
    flags.verbose,
    `markdown htmlRequested=${markdown.markdownRequested} transcriptRequested=${markdown.transcriptMarkdownRequested} provider=${markdown.markdownProvider}`,
    flags.verboseColor,
    io.envForRun,
  );

  writeVerbose(io.stderr, flags.verbose, "extract start", flags.verboseColor, io.envForRun);
  const {
    handleSigint,
    handleSigterm,
    hooks: progressHooks,
    pauseProgress,
    progressStatus,
    renderStatus,
    renderStatusFromText,
    renderStatusWithMeta,
    spinner,
    stopProgress,
    styleDim,
    styleLabel,
    websiteProgress,
  } = createUrlFlowProgress({ ctx, theme });
  const flowCtx = progressHooks === hooks ? ctx : { ...ctx, hooks: progressHooks };
  const activeHooks = flowCtx.hooks;

  const extractionSession = createUrlExtractionSession({
    ctx: flowCtx,
    markdown: {
      convertHtmlToMarkdown: markdown.convertHtmlToMarkdown,
      effectiveMarkdownMode: markdown.effectiveMarkdownMode,
      markdownRequested: markdown.markdownRequested,
    },
    onProgress:
      websiteProgress || activeHooks.onLinkPreviewProgress
        ? (event) => {
            websiteProgress?.onProgress(event);
            activeHooks.onLinkPreviewProgress?.(event);
          }
        : null,
  });

  const pauseProgressLine = pauseProgress;
  activeHooks.setClearProgressBeforeStdout(pauseProgressLine);
  let backgroundSlidesPromise: Promise<SlideExtractionResult | null> | null = null;
  try {
    let extracted = await extractionSession.fetchInitialExtract(url);
    let emittedExtracted = extracted;
    activeHooks.onExtracted?.(extracted);
    ctx.perfTrace?.mark("url:extracted");
    let extractionUi = deriveExtractionUi(extracted);

    const formatSummaryProgress = (modelId?: string | null) => {
      const dim = (value: string) => theme.dim(value);
      const accent = (value: string) => theme.accent(value);
      const sentLabel = `${dim("sent ")}${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel}`;
      const modelLabel = modelId ? `${dim("model: ")}${accent(modelId)}` : "";
      const meta = modelLabel ? `${sentLabel}${dim(", ")}${modelLabel}` : sentLabel;
      return `${styleLabel("Summarizing")} ${dim("(")}${meta}${dim(")")}${dim("…")}`;
    };

    const updateSummaryProgress = () => {
      if (!flags.progressEnabled) return;
      websiteProgress?.stop?.();
      progressStatus.setSummary(
        flags.extractMode
          ? `${styleLabel("Extracted")}${styleDim(
              ` (${extractionUi.contentSizeLabel}${extractionUi.viaSourceLabel})`,
            )}`
          : formatSummaryProgress(),
        flags.extractMode ? null : "Summarizing",
      );
    };

    const slidesSession = createUrlSlidesSession({
      ctx: flowCtx,
      url,
      extracted,
      cacheStore: extractionSession.cacheStore,
      progressStatus,
      renderStatus,
      renderStatusFromText,
      updateSummaryProgress,
    });

    updateSummaryProgress();
    logExtractionDiagnostics({
      extracted,
      stderr: io.stderr,
      verbose: flags.verbose,
      verboseColor: flags.verboseColor,
      env: io.envForRun,
    });
    const transcriptCacheStatus = extracted.diagnostics?.transcript?.cacheStatus;
    if (transcriptCacheStatus && transcriptCacheStatus !== "unknown") {
      writeVerbose(
        io.stderr,
        flags.verbose,
        `cache ${transcriptCacheStatus} transcript`,
        flags.verboseColor,
        io.envForRun,
      );
    }

    if (
      flags.extractMode &&
      markdown.markdownRequested &&
      flags.preprocessMode !== "off" &&
      markdown.effectiveMarkdownMode === "auto" &&
      !extracted.diagnostics.markdown.used &&
      !hasUvxCli(io.env)
    ) {
      io.stderr.write(`${UVX_TIP}\n`);
    }

    const videoOnlyResult = await handleVideoOnlyExtractedContent({
      ctx,
      extracted,
      extractionUi,
      isYoutubeUrl,
      fetchWithCache: (targetUrl) => extractionSession.fetchWithCache(targetUrl),
      runSlidesExtraction: slidesSession.runSlidesExtraction,
      renderStatus,
      renderStatusWithMeta,
      spinner,
      styleDim,
      updateSummaryProgress,
      accent: theme.accent,
    });
    if (videoOnlyResult.handled) {
      return;
    }
    extracted = videoOnlyResult.extracted;
    extractionUi = videoOnlyResult.extractionUi;
    slidesSession.setExtracted(extracted);
    if (extracted !== emittedExtracted) {
      emittedExtracted = extracted;
      activeHooks.onExtracted?.(extracted);
    }
    updateSummaryProgress();

    if (flags.slides) {
      backgroundSlidesPromise = slidesSession.runSlidesExtraction().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        writeSlidesBackgroundFailureWarning({ ctx, theme, message });
        writeVerbose(
          io.stderr,
          flags.verbose,
          `slides failed: ${message}`,
          flags.verboseColor,
          io.envForRun,
        );
        return null;
      });
    }

    let slidesForPrompt: SlideExtractionResult | null = null;
    if (slidesSession.slidesTimelinePromise) {
      slidesForPrompt = await slidesSession.slidesTimelinePromise;
    }

    const prompt = buildUrlPrompt({
      extracted,
      outputLanguage: flags.outputLanguage,
      lengthArg: flags.lengthArg,
      promptOverride: flags.promptOverride ?? null,
      lengthInstruction: flags.lengthInstruction ?? null,
      languageInstruction: flags.languageInstruction ?? null,
      slides: slidesForPrompt ?? slidesSession.getSlidesExtracted() ?? null,
    });
    ctx.perfTrace?.mark("url:prompt");

    // Whisper transcription costs need to be folded into the finish line totals.
    const transcriptionCostUsd = estimateWhisperTranscriptionCostUsd({
      transcriptionProvider: extracted.transcriptionProvider,
      transcriptSource: extracted.transcriptSource,
      mediaDurationSeconds: extracted.mediaDurationSeconds,
      openaiWhisperUsdPerMinute: model.openaiWhisperUsdPerMinute,
    });
    const transcriptionCostLabel =
      typeof transcriptionCostUsd === "number" ? `txcost=${formatUSD(transcriptionCostUsd)}` : null;
    activeHooks.setTranscriptionCost(transcriptionCostUsd, transcriptionCostLabel);

    if (flags.extractMode) {
      // Apply transcript→markdown conversion if requested
      let extractedForOutput = extracted;
      if (markdown.transcriptMarkdownRequested && markdown.convertTranscriptToMarkdown) {
        if (flags.progressEnabled) {
          spinner.setText(renderStatus("Converting transcript to markdown"));
        }
        const markdownContent = await markdown.convertTranscriptToMarkdown({
          title: extracted.title,
          source: extracted.siteName,
          transcript: extracted.content,
          timeoutMs: flags.timeoutMs,
          outputLanguage: flags.outputLanguage,
        });
        extractedForOutput = {
          ...extracted,
          content: markdownContent,
          diagnostics: {
            ...extracted.diagnostics,
            markdown: {
              ...extracted.diagnostics.markdown,
              requested: true,
              used: true,
              provider: "llm",
              notes: "transcript",
            },
          },
        };
        extractionUi = deriveExtractionUi(extractedForOutput);
      }
      await outputExtractedUrl({
        ctx,
        url,
        extracted: extractedForOutput,
        extractionUi,
        prompt,
        effectiveMarkdownMode: markdown.effectiveMarkdownMode,
        transcriptionCostLabel,
        slides: slidesSession.getSlidesExtracted() ?? slidesForPrompt ?? null,
        slidesOutput: slidesSession.slidesOutput,
      });
      if (backgroundSlidesPromise) await backgroundSlidesPromise;
      return;
    }

    const onModelChosen = (modelId: string) => {
      activeHooks.onModelChosen?.(modelId);
      if (!flags.progressEnabled) return;
      progressStatus.setSummary(formatSummaryProgress(modelId), "Summarizing");
    };

    await summarizeExtractedUrl({
      ctx: flowCtx,
      url,
      extracted,
      extractionUi,
      prompt,
      effectiveMarkdownMode: markdown.effectiveMarkdownMode,
      transcriptionCostLabel,
      onModelChosen,
      slides: slidesSession.getSlidesExtracted() ?? slidesForPrompt ?? null,
      slidesOutput: slidesSession.slidesOutput,
    });
    ctx.perfTrace?.mark("url:summary-done");
    if (backgroundSlidesPromise) await backgroundSlidesPromise;
  } finally {
    if (backgroundSlidesPromise) {
      await backgroundSlidesPromise;
    }
    if (flags.progressEnabled) {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    }
    activeHooks.clearProgressIfCurrent(pauseProgressLine);
    stopProgress();
  }
}
