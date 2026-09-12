import { promises as fs } from "node:fs";
import type { MediaCache } from "../content/index.js";
import { downloadRemoteVideo, downloadYoutubeVideo, resolveYoutubeStreamUrl } from "./download.js";
import {
  buildSlideTimeline,
  buildSlidesChunkMeta,
  emitFinalSlides,
  emitPlaceholderSlides,
  renameSlidesWithTimestamps,
  SLIDES_PROGRESS,
  writeSlidesJson,
} from "./extract-finalize.js";
import { detectSlideTimestamps, extractFramesAtTimestamps } from "./frame-extraction.js";
import { prepareSlidesInput } from "./ingest.js";
import { runOcrOnSlides } from "./ocr.js";
import {
  createSlidesLogger,
  createSlidesProgress,
  resolveRunnableTool,
  resolveSlidesSampleCount,
  resolveSlidesStreamFallback,
  resolveSlidesWorkers,
  resolveSlidesYtDlpExtractFormat,
} from "./runtime.js";
import {
  adjustTimestampWithinSegment,
  applyMaxSlidesFilter,
  applyMinDurationFilter,
  buildIntervalTimestamps,
  buildSceneSegments,
  filterTimestampsByMinDuration,
  findSceneSegment,
  mergeTimestamps,
  selectTimestampTargets,
} from "./scene-detection.js";
import type { SlideSettings } from "./settings.js";
import {
  prepareSlidesDir,
  withSlidesLock,
  readSlidesCacheIfValid,
  resolveSlidesDir,
} from "./store.js";
import type { SlideExtractionResult, SlideImage, SlideSource, SlideSourceKind } from "./types.js";

export { parseShowinfoTimestamp, resolveExtractedTimestamp } from "./scene-detection.js";

type ExtractSlidesArgs = {
  source: SlideSource;
  settings: SlideSettings;
  noCache?: boolean;
  mediaCache?: MediaCache | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  ytDlpPath: string | null;
  disableYtDlpAutoResolve?: boolean;
  allowRemoteUrlFallback?: boolean;
  ytDlpCookiesFromBrowser?: string | null;
  ffmpegPath: string | null;
  tesseractPath: string | null;
  hooks?: {
    onSlideChunk?: (chunk: {
      slide: SlideImage;
      meta: {
        slidesDir: string;
        sourceUrl: string;
        sourceId: string;
        sourceKind: SlideSourceKind;
        ocrAvailable: boolean;
      };
    }) => void;
    onSlidesTimeline?: ((slides: SlideExtractionResult) => void) | null;
    onSlidesProgress?: ((text: string) => void) | null;
    onSlidesLog?: ((message: string) => void) | null;
  } | null;
};

export async function extractSlidesForSource({
  source,
  settings,
  noCache = false,
  mediaCache = null,
  env,
  fetchImpl,
  timeoutMs,
  ytDlpPath,
  disableYtDlpAutoResolve = false,
  allowRemoteUrlFallback = true,
  ytDlpCookiesFromBrowser,
  ffmpegPath,
  tesseractPath,
  hooks,
}: ExtractSlidesArgs): Promise<SlideExtractionResult> {
  const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId);
  return withSlidesLock(
    slidesDir,
    async () => {
      const { logSlides, logSlidesTiming } = createSlidesLogger(hooks?.onSlidesLog ?? null);
      if (!noCache) {
        const cached = await readSlidesCacheIfValid({ source, settings });
        if (cached) {
          hooks?.onSlidesTimeline?.(cached);
          return cached;
        }
      }

      const reportSlidesProgress = createSlidesProgress(hooks?.onSlidesProgress);

      const warnings: string[] = [];
      const totalStartedAt = Date.now();
      const ffmpegBinary =
        ffmpegPath ??
        (await resolveRunnableTool({
          binary: "ffmpeg",
          env,
          explicitEnvKey: "FFMPEG_PATH",
          probeArgs: ["-version"],
        }));
      if (!ffmpegBinary) {
        throw new Error("Missing ffmpeg (install ffmpeg or add it to PATH).");
      }
      const workers =
        typeof ffmpegBinary === "object" && ffmpegBinary.source === "wasm"
          ? 1
          : resolveSlidesWorkers(env);
      logSlides(
        `pipeline=ingest(sequential)->scene-detect(parallel:${workers})->extract-frames(parallel:${workers})->ocr(parallel:${workers})`,
      );
      const ffprobeBinary = await resolveRunnableTool({
        binary: "ffprobe",
        env,
        explicitEnvKey: "FFPROBE_PATH",
        probeArgs: ["-version"],
      });

      if (settings.ocr && !tesseractPath) {
        const resolved = await resolveRunnableTool({
          binary: "tesseract",
          env,
          explicitEnvKey: "TESSERACT_PATH",
          probeArgs: ["--version"],
        });
        if (!resolved) {
          throw new Error("Missing tesseract OCR (install tesseract or skip --slides-ocr).");
        }
        tesseractPath = resolved;
      }
      const ocrEnabled = Boolean(settings.ocr && tesseractPath);
      const ocrAvailable = Boolean(
        tesseractPath ??
        (await resolveRunnableTool({
          binary: "tesseract",
          env,
          explicitEnvKey: "TESSERACT_PATH",
          probeArgs: ["--version"],
        })),
      );

      {
        const prepareStartedAt = Date.now();
        await prepareSlidesDir(slidesDir);
        logSlidesTiming("prepare output dir", prepareStartedAt);
      }
      reportSlidesProgress?.("preparing source", SLIDES_PROGRESS.PREPARE);

      const ytDlpBinary =
        ytDlpPath ??
        (disableYtDlpAutoResolve
          ? null
          : await resolveRunnableTool({
              binary: "yt-dlp",
              env,
              explicitEnvKey: "YT_DLP_PATH",
              probeArgs: ["--version"],
            }));

      const {
        inputPath,
        inputCleanup,
        warnings: ingestWarnings,
      } = await prepareSlidesInput({
        source,
        mediaCache,
        timeoutMs,
        fetchImpl,
        ytDlpPath: ytDlpBinary,
        allowRemoteUrlFallback,
        ytDlpCookiesFromBrowser,
        resolveSlidesYtDlpExtractFormat: () => resolveSlidesYtDlpExtractFormat(env),
        resolveSlidesStreamFallback: () => resolveSlidesStreamFallback(env),
        reportSlidesProgress,
        logSlidesTiming,
        downloadYoutubeVideo,
        downloadRemoteVideo,
        resolveYoutubeStreamUrl,
      });
      warnings.push(...ingestWarnings);

      try {
        const ffmpegStartedAt = Date.now();
        reportSlidesProgress?.("detecting scenes", SLIDES_PROGRESS.FETCH_VIDEO + 2);
        const detection = await detectSlideTimestamps({
          ffmpegPath: ffmpegBinary,
          ffprobePath: ffprobeBinary,
          inputPath,
          sceneThreshold: settings.sceneThreshold,
          autoTuneThreshold: settings.autoTuneThreshold,
          env,
          timeoutMs,
          warnings,
          workers,
          sampleCount: resolveSlidesSampleCount(env),
          onSegmentProgress: (completed, total) => {
            const ratio = total > 0 ? completed / total : 0;
            const mapped =
              SLIDES_PROGRESS.FETCH_VIDEO +
              2 +
              ratio * (SLIDES_PROGRESS.DETECT_SCENES - (SLIDES_PROGRESS.FETCH_VIDEO + 2));
            reportSlidesProgress?.(
              "detecting scenes",
              mapped,
              total > 0 ? `(${completed}/${total})` : undefined,
            );
          },
          logSlides,
          logSlidesTiming,
        });
        reportSlidesProgress?.("detecting scenes", SLIDES_PROGRESS.DETECT_SCENES);
        logSlidesTiming("ffmpeg scene-detect", ffmpegStartedAt);

        const interval = buildIntervalTimestamps({
          durationSeconds: detection.durationSeconds,
          minDurationSeconds: settings.minDurationSeconds,
          maxSlides: settings.maxSlides,
        });
        const combined = mergeTimestamps(
          detection.timestamps,
          interval?.timestamps ?? [],
          settings.minDurationSeconds,
        );
        if (combined.length === 0) {
          throw new Error("No slides detected; try adjusting slide extraction settings.");
        }
        const sceneSegments = buildSceneSegments(detection.timestamps, detection.durationSeconds);
        const selected = interval?.timestamps.length
          ? selectTimestampTargets({
              targets: interval.timestamps,
              sceneTimestamps: detection.timestamps,
              minDurationSeconds: settings.minDurationSeconds,
              intervalSeconds: interval.intervalSeconds,
            })
          : combined;
        const spaced = filterTimestampsByMinDuration(selected, settings.minDurationSeconds);
        const trimmed = applyMaxSlidesFilter(
          spaced.map((timestamp, index) => {
            const segment = findSceneSegment(sceneSegments, timestamp);
            const adjusted = adjustTimestampWithinSegment(timestamp, segment);
            return { index: index + 1, timestamp: adjusted, imagePath: "", segment };
          }),
          settings.maxSlides,
          warnings,
          (imagePath) => {
            void fs.rm(imagePath, { force: true }).catch(() => {});
          },
        );

        const chunkMeta = buildSlidesChunkMeta({ slidesDir, source, ocrAvailable });
        const timelineSlides = buildSlideTimeline({
          source,
          slidesDir,
          sceneThreshold: settings.sceneThreshold,
          autoTuneThreshold: settings.autoTuneThreshold,
          autoTune: detection.autoTune,
          maxSlides: settings.maxSlides,
          minSlideDuration: settings.minDurationSeconds,
          ocrRequested: settings.ocr,
          ocrAvailable,
          warnings,
          slides: trimmed,
        });
        hooks?.onSlidesTimeline?.(timelineSlides);

        // Emit placeholders immediately so the UI can render the slide list while frames are still extracting.
        emitPlaceholderSlides({
          slides: trimmed,
          meta: chunkMeta,
          onSlideChunk: hooks?.onSlideChunk,
        });

        const formatProgressCount = (completed: number, total: number) =>
          total > 0 ? `(${completed}/${total})` : "";
        const reportFrameProgress = (completed: number, total: number) => {
          const ratio = total > 0 ? completed / total : 0;
          reportSlidesProgress?.(
            "extracting frames",
            SLIDES_PROGRESS.DETECT_SCENES +
              ratio * (SLIDES_PROGRESS.EXTRACT_FRAMES - SLIDES_PROGRESS.DETECT_SCENES),
            formatProgressCount(completed, total),
          );
        };
        reportFrameProgress(0, trimmed.length);

        const onSlideChunk = hooks?.onSlideChunk;
        const extractFrames = async () =>
          extractFramesAtTimestamps({
            ffmpegPath: ffmpegBinary,
            inputPath,
            outputDir: slidesDir,
            timestamps: trimmed.map((slide) => slide.timestamp),
            segments: trimmed.map((slide) => slide.segment ?? null),
            durationSeconds: detection.durationSeconds,
            timeoutMs,
            workers,
            onProgress: reportFrameProgress,
            onStatus: hooks?.onSlidesProgress ?? null,
            onSlide: onSlideChunk
              ? (slide) =>
                  onSlideChunk({
                    slide,
                    meta: chunkMeta,
                  })
              : null,
            logSlides,
            logSlidesTiming,
          });
        const extractFramesStartedAt = Date.now();
        const extractedSlides: SlideImage[] = await extractFrames();
        const extractElapsedMs = logSlidesTiming(
          `extract frames (count=${trimmed.length}, parallel=${workers})`,
          extractFramesStartedAt,
        );
        if (trimmed.length > 0) {
          logSlides(
            `extract frames avgMsPerFrame=${Math.round(extractElapsedMs / trimmed.length)}`,
          );
        }

        const rawSlides = applyMinDurationFilter(
          extractedSlides,
          settings.minDurationSeconds,
          warnings,
          (imagePath) => {
            void fs.rm(imagePath, { force: true }).catch(() => {});
          },
        );

        const renameStartedAt = Date.now();
        const renamedSlides = await renameSlidesWithTimestamps(rawSlides, slidesDir);
        logSlidesTiming("rename slides", renameStartedAt);
        if (renamedSlides.length === 0) {
          throw new Error("No slides extracted; try lowering --slides-scene-threshold.");
        }

        let slidesWithOcr = renamedSlides;
        if (ocrEnabled && tesseractPath) {
          const ocrStartedAt = Date.now();
          logSlides(`ocr start count=${renamedSlides.length} mode=parallel workers=${workers}`);
          const ocrStartPercent = SLIDES_PROGRESS.OCR - 3;
          const reportOcrProgress = (completed: number, total: number) => {
            const ratio = total > 0 ? completed / total : 0;
            reportSlidesProgress?.(
              "running OCR",
              ocrStartPercent + ratio * (SLIDES_PROGRESS.OCR - ocrStartPercent),
              formatProgressCount(completed, total),
            );
          };
          reportOcrProgress(0, renamedSlides.length);
          slidesWithOcr = await runOcrOnSlides(
            renamedSlides,
            tesseractPath,
            workers,
            reportOcrProgress,
          );
          const elapsedMs = logSlidesTiming("ocr done", ocrStartedAt);
          if (renamedSlides.length > 0) {
            logSlides(`ocr avgMsPerSlide=${Math.round(elapsedMs / renamedSlides.length)}`);
          }
        }

        reportSlidesProgress?.("finalizing", SLIDES_PROGRESS.FINAL - 1);
        emitFinalSlides({
          slides: slidesWithOcr,
          meta: chunkMeta,
          onSlideChunk: hooks?.onSlideChunk,
        });
        const result = buildSlideTimeline({
          source,
          slidesDir,
          sceneThreshold: settings.sceneThreshold,
          autoTuneThreshold: settings.autoTuneThreshold,
          autoTune: detection.autoTune,
          maxSlides: settings.maxSlides,
          minSlideDuration: settings.minDurationSeconds,
          ocrRequested: settings.ocr,
          ocrAvailable,
          warnings,
          slides: slidesWithOcr,
        });

        await writeSlidesJson(result, slidesDir);
        reportSlidesProgress?.("finalizing", SLIDES_PROGRESS.FINAL);
        logSlidesTiming("slides total", totalStartedAt);
        return result;
      } finally {
        if (inputCleanup) {
          await inputCleanup();
        }
      }
    },
    () => {
      hooks?.onSlidesProgress?.("Slides: queued");
    },
  );
}
