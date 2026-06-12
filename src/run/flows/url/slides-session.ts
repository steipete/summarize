import { parseTranscriptTimedText } from "@steipete/summarize-core/slides";
import { buildSlidesCacheKey } from "../../../cache.js";
import type { ExtractedLinkContent } from "../../../content/index.js";
import {
  extractSlidesForSource,
  resolveSlideSource,
  resolveSlidesDir,
  type SlideExtractionResult,
  type SlideSettings,
  validateSlidesCache,
} from "../../../slides/index.js";
import { buildIntervalTimestamps } from "../../../slides/scene-detection.js";
import { writeVerbose } from "../../logging.js";
import { resolveUrlFlowYtDlpPath } from "./external-media.js";
import { createSlidesTerminalOutput, type SlidesTerminalOutput } from "./slides-output.js";
import { composeUrlFlowHooks, type UrlFlowContext } from "./types.js";

type ProgressStatusLike = {
  clearSlides: () => void;
  setSlides: (text: string, percent?: number | null) => void;
};

function resolvePlannedTimelineDurationSeconds(extracted: ExtractedLinkContent): number | null {
  const exact =
    typeof extracted.mediaDurationSeconds === "number" &&
    Number.isFinite(extracted.mediaDurationSeconds) &&
    extracted.mediaDurationSeconds > 0
      ? extracted.mediaDurationSeconds
      : null;
  if (exact != null) return exact;

  const segmentEnds = (extracted.transcriptSegments ?? [])
    .map((segment) => {
      const endMs =
        typeof segment.endMs === "number" && Number.isFinite(segment.endMs)
          ? segment.endMs
          : segment.startMs;
      return typeof endMs === "number" && Number.isFinite(endMs) ? endMs / 1000 : null;
    })
    .filter((value): value is number => value != null && value > 0);
  const segmentDuration = segmentEnds.length > 0 ? Math.max(...segmentEnds) : null;
  if (segmentDuration != null && Number.isFinite(segmentDuration) && segmentDuration > 0) {
    return segmentDuration;
  }

  const timedSegments = parseTranscriptTimedText(extracted.transcriptTimedText);
  const lastTimedSegment = timedSegments.at(-1);
  if (lastTimedSegment && Number.isFinite(lastTimedSegment.startSeconds)) {
    return lastTimedSegment.startSeconds;
  }

  return null;
}

function buildPlannedSlidesTimeline({
  url,
  extracted,
  settings,
}: {
  url: string;
  extracted: ExtractedLinkContent;
  settings: SlideSettings;
}): SlideExtractionResult | null {
  const source = resolveSlideSource({ url, extracted });
  if (!source) return null;
  const durationSeconds = resolvePlannedTimelineDurationSeconds(extracted);
  const interval = buildIntervalTimestamps({
    durationSeconds,
    minDurationSeconds: settings.minDurationSeconds,
    maxSlides: settings.maxSlides,
  });
  if (!interval || interval.timestamps.length === 0) return null;

  return {
    sourceUrl: source.url,
    sourceKind: source.kind,
    sourceId: source.sourceId,
    slidesDir: resolveSlidesDir(settings.outputDir, source.sourceId),
    sceneThreshold: settings.sceneThreshold,
    autoTuneThreshold: settings.autoTuneThreshold,
    autoTune: {
      enabled: false,
      chosenThreshold: settings.sceneThreshold,
      confidence: 0,
      strategy: "none",
    },
    maxSlides: settings.maxSlides,
    minSlideDuration: settings.minDurationSeconds,
    ocrRequested: settings.ocr,
    ocrAvailable: false,
    slides: interval.timestamps.map((timestamp, index) => ({
      index: index + 1,
      timestamp,
      imagePath: "",
    })),
    warnings: [],
  };
}

export type UrlSlidesSession = {
  getSlidesExtracted: () => SlideExtractionResult | null;
  runSlidesExtraction: () => Promise<SlideExtractionResult | null>;
  slidesOutput: SlidesTerminalOutput | null;
  slidesTimelinePromise: Promise<SlideExtractionResult | null> | null;
  setExtracted: (value: ExtractedLinkContent) => void;
};

export function createUrlSlidesSession({
  ctx,
  url,
  extracted: initialExtracted,
  cacheStore,
  progressStatus,
  renderStatus,
  renderStatusFromText,
  updateSummaryProgress,
}: {
  ctx: UrlFlowContext;
  url: string;
  extracted: ExtractedLinkContent;
  cacheStore: UrlFlowContext["cache"]["store"] | null;
  progressStatus: ProgressStatusLike;
  renderStatus: (label: string, detail?: string) => string;
  renderStatusFromText: (text: string) => string;
  updateSummaryProgress: () => void;
}): UrlSlidesSession {
  const { io, flags, model, cache: cacheState, hooks } = ctx;
  let extracted = initialExtracted;
  let slidesExtracted: SlideExtractionResult | null = null;
  let slidesDone = false;
  let slidesTimelineResolved = false;
  let resolveSlidesTimeline: ((value: SlideExtractionResult | null) => void) | null = null;
  const slidesTimelinePromise = flags.slides
    ? new Promise<SlideExtractionResult | null>((resolve) => {
        resolveSlidesTimeline = resolve;
      })
    : null;

  const resolveTimeline = (value: SlideExtractionResult | null) => {
    if (slidesTimelineResolved) return;
    slidesTimelineResolved = true;
    resolveSlidesTimeline?.(value);
  };

  const slidesOutputEnabled =
    Boolean(flags.slides) && flags.slidesOutput !== false && !flags.json && !flags.extractMode;
  const slidesOutput = createSlidesTerminalOutput({
    io,
    flags: { plain: flags.plain, lengthArg: flags.lengthArg, slidesDebug: flags.slidesDebug },
    extracted,
    slides: null,
    enabled: slidesOutputEnabled,
    outputMode: "delta",
    clearProgressForStdout: hooks.clearProgressForStdout,
    restoreProgressAfterStdout: hooks.restoreProgressAfterStdout ?? null,
    onProgressText: flags.progressEnabled
      ? (text) => progressStatus.setSlides(renderStatusFromText(text))
      : null,
  });

  const sessionHooks = slidesOutput
    ? composeUrlFlowHooks(hooks, {
        onSlidesExtracted: (value) => {
          hooks.onSlidesExtracted?.(value);
          slidesOutput.onSlidesExtracted(value);
        },
        onSlidesDone: (result) => {
          hooks.onSlidesDone?.(result);
          progressStatus.clearSlides();
          slidesOutput.onSlidesDone(result);
        },
        onSlideChunk: (chunk) => {
          hooks.onSlideChunk?.(chunk);
          slidesOutput.onSlideChunk(chunk);
        },
      })
    : hooks;

  const markSlidesDone = (result: { ok: boolean; error?: string | null }) => {
    if (slidesDone) return;
    slidesDone = true;
    progressStatus.clearSlides();
    sessionHooks.onSlidesDone?.(result);
  };

  const emitPlannedSlidesTimeline = () => {
    if (!flags.slides || slidesTimelineResolved) return null;
    const planned = buildPlannedSlidesTimeline({ url, extracted, settings: flags.slides });
    if (!planned) return null;
    resolveTimeline(planned);
    sessionHooks.onSlidesExtracted?.(planned);
    return planned;
  };

  emitPlannedSlidesTimeline();

  const runSlidesExtraction = async (): Promise<SlideExtractionResult | null> => {
    if (!flags.slides) return null;
    if (slidesExtracted) {
      if (!slidesDone) markSlidesDone({ ok: true });
      return slidesExtracted;
    }
    let errorMessage: string | null = null;
    try {
      const source = resolveSlideSource({ url, extracted });
      if (!source) {
        throw new Error("Slides are only supported for YouTube or direct video URLs.");
      }
      const slidesCacheKey =
        cacheStore && cacheState.mode === "default"
          ? buildSlidesCacheKey({ url: source.url, settings: flags.slides })
          : null;
      if (slidesCacheKey && cacheStore) {
        const cached = cacheStore.getJson<SlideExtractionResult>("slides", slidesCacheKey);
        const validated = cached
          ? await validateSlidesCache({ cached, source, settings: flags.slides })
          : null;
        if (validated) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            "cache hit slides",
            flags.verboseColor,
            io.envForRun,
          );
          slidesExtracted = validated;
          resolveTimeline(validated);
          sessionHooks.onSlidesExtracted?.(slidesExtracted);
          sessionHooks.onSlidesProgress?.("Slides: cached 100%");
          return slidesExtracted;
        }
        writeVerbose(
          io.stderr,
          flags.verbose,
          "cache miss slides",
          flags.verboseColor,
          io.envForRun,
        );
      }
      if (flags.progressEnabled) {
        progressStatus.setSlides(renderStatus("Extracting slides"));
      }
      const activeSlidesProgress = sessionHooks.onSlidesProgress;
      activeSlidesProgress?.("Slides: extracting");
      const onSlidesLog = (message: string) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `slides ${message}`,
          flags.verboseColor,
          io.envForRun,
        );
      };
      slidesExtracted = await extractSlidesForSource({
        source,
        settings: flags.slides,
        noCache: cacheState.mode === "bypass",
        mediaCache: ctx.mediaCache,
        env: io.env,
        fetchImpl: io.urlFetch ?? io.fetch,
        timeoutMs: flags.timeoutMs,
        ytDlpPath: resolveUrlFlowYtDlpPath({
          urlFetch: io.urlFetch,
          ytDlpPath: model.apiStatus.ytDlpPath,
          allowGuardedExternalDownloader: source.kind === "youtube",
        }),
        disableYtDlpAutoResolve: Boolean(io.urlFetch),
        allowRemoteUrlFallback: !io.urlFetch,
        ytDlpCookiesFromBrowser: model.apiStatus.ytDlpCookiesFromBrowser,
        ffmpegPath: null,
        tesseractPath: null,
        hooks: {
          onSlideChunk: (chunk) => sessionHooks.onSlideChunk?.(chunk),
          onSlidesTimeline: (timeline) => {
            resolveTimeline(timeline);
            sessionHooks.onSlidesExtracted?.(timeline);
          },
          onSlidesProgress: activeSlidesProgress ?? undefined,
          onSlidesLog,
        },
      });
      if (slidesExtracted) {
        sessionHooks.onSlidesExtracted?.(slidesExtracted);
        sessionHooks.onSlidesProgress?.(
          `Slides: done (${slidesExtracted.slides.length.toString()} slides) 100%`,
        );
        if (slidesCacheKey && cacheStore) {
          cacheStore.setJson("slides", slidesCacheKey, slidesExtracted, cacheState.ttlMs);
          writeVerbose(
            io.stderr,
            flags.verbose,
            "cache write slides",
            flags.verboseColor,
            io.envForRun,
          );
        }
      }
      if (flags.progressEnabled) {
        updateSummaryProgress();
      }
      return slidesExtracted;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (!slidesTimelineResolved) {
        resolveTimeline(slidesExtracted ?? null);
      }
      if (!slidesDone) {
        markSlidesDone(errorMessage ? { ok: false, error: errorMessage } : { ok: true });
      }
    }
  };

  return {
    getSlidesExtracted: () => slidesExtracted,
    runSlidesExtraction,
    slidesOutput,
    slidesTimelinePromise,
    setExtracted: (value) => {
      extracted = value;
      emitPlannedSlidesTimeline();
    },
  };
}
