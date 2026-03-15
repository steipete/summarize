import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtractedLinkContent, MediaCache } from "../content/index.js";
import { extractYouTubeVideoId, isDirectMediaUrl, isYouTubeUrl } from "../content/index.js";
import { canSpawnCommand, resolveExecutableInPath } from "../run/env.js";
import {
  buildSlidesMediaCacheKey,
  downloadRemoteVideo,
  downloadYoutubeVideo,
  formatBytes,
  resolveYoutubeStreamUrl,
} from "./download.js";
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
  adjustTimestampWithinSegment,
  applyMaxSlidesFilter,
  applyMinDurationFilter,
  buildIntervalTimestamps,
  buildSceneSegments,
  calibrateSceneThreshold,
  clamp,
  filterTimestampsByMinDuration,
  findSceneSegment,
  mergeTimestamps,
  resolveExtractedTimestamp,
  selectTimestampTargets,
} from "./scene-detection.js";
import type { SlideSettings } from "./settings.js";
import { buildDirectSourceId, buildYoutubeSourceId } from "./source-id.js";
import {
  buildSlidesDirId,
  readSlidesCacheIfValid,
  resolveSlidesDir,
  serializeSlideImagePath,
} from "./store.js";
import type {
  SlideAutoTune,
  SlideExtractionResult,
  SlideImage,
  SlideSource,
  SlideSourceKind,
} from "./types.js";

const slidesLocks = new Map<string, Promise<void>>();
const YT_DLP_TIMEOUT_MS = 300_000;
const DEFAULT_SLIDES_WORKERS = 8;
const DEFAULT_SLIDES_SAMPLE_COUNT = 8;
// Prefer broadly-decodable H.264/MP4 for ffmpeg stability.
// (Some "bestvideo" picks AV1 which can fail on certain ffmpeg builds / hwaccel setups.)
const DEFAULT_YT_DLP_FORMAT_EXTRACT =
  "bestvideo[height<=720][vcodec^=avc1][ext=mp4]/best[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/best[height<=720]";

type SlidesLogger = ((message: string) => void) | null;

export { parseShowinfoTimestamp, resolveExtractedTimestamp } from "./scene-detection.js";

function createSlidesLogger(logger: SlidesLogger) {
  const logSlides = (message: string) => {
    if (!logger) return;
    logger(message);
  };
  const logSlidesTiming = (label: string, startedAt: number) => {
    const elapsedMs = Date.now() - startedAt;
    logSlides(`${label} elapsedMs=${elapsedMs}`);
    return elapsedMs;
  };
  return { logSlides, logSlidesTiming };
}

function resolveSlidesWorkers(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_WORKERS ?? env.SLIDES_WORKERS;
  if (!raw) return DEFAULT_SLIDES_WORKERS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_WORKERS;
  return Math.max(1, Math.min(16, Math.round(parsed)));
}

function resolveSlidesSampleCount(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_SAMPLES ?? env.SLIDES_SAMPLES;
  if (!raw) return DEFAULT_SLIDES_SAMPLE_COUNT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_SAMPLE_COUNT;
  return Math.max(3, Math.min(12, Math.round(parsed)));
}

function resolveSlidesYtDlpExtractFormat(env: Record<string, string | undefined>): string {
  return (
    env.SUMMARIZE_SLIDES_YTDLP_FORMAT_EXTRACT ??
    env.SLIDES_YTDLP_FORMAT_EXTRACT ??
    DEFAULT_YT_DLP_FORMAT_EXTRACT
  ).trim();
}

function resolveSlidesStreamFallback(env: Record<string, string | undefined>): boolean {
  const raw = env.SLIDES_EXTRACT_STREAM?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveToolPath(
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string,
): string | null {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) return resolveExecutableInPath(explicit, env);
  return resolveExecutableInPath(binary, env);
}

async function resolveRunnableTool({
  binary,
  env,
  explicitEnvKey,
  probeArgs,
}: {
  binary: string;
  env: Record<string, string | undefined>;
  explicitEnvKey?: string;
  probeArgs: string[];
}): Promise<string | null> {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) {
    return (await canSpawnCommand({ command: explicit, args: probeArgs, env })) ? explicit : null;
  }
  const resolved = resolveToolPath(binary, env, explicitEnvKey);
  if (resolved) return resolved;
  return (await canSpawnCommand({ command: binary, args: probeArgs, env })) ? binary : null;
}

type ExtractSlidesArgs = {
  source: SlideSource;
  settings: SlideSettings;
  noCache?: boolean;
  mediaCache?: MediaCache | null;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  ytDlpPath: string | null;
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

export function resolveSlideSource({
  url,
  extracted,
}: {
  url: string;
  extracted: ExtractedLinkContent;
}): SlideSource | null {
  const directUrl = extracted.video?.url ?? extracted.url;
  const youtubeCandidate =
    extractYouTubeVideoId(extracted.video?.url ?? "") ??
    extractYouTubeVideoId(extracted.url) ??
    extractYouTubeVideoId(url);
  if (youtubeCandidate) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeCandidate}`,
      kind: "youtube",
      sourceId: buildYoutubeSourceId(youtubeCandidate),
    };
  }

  if (extracted.video?.kind === "direct" || isDirectMediaUrl(directUrl) || isDirectMediaUrl(url)) {
    const normalized = directUrl || url;
    return {
      url: normalized,
      kind: "direct",
      sourceId: buildDirectSourceId(normalized),
    };
  }

  if (isYouTubeUrl(url)) {
    const fallbackId = extractYouTubeVideoId(url);
    if (fallbackId) {
      return {
        url: `https://www.youtube.com/watch?v=${fallbackId}`,
        kind: "youtube",
        sourceId: buildYoutubeSourceId(fallbackId),
      };
    }
  }

  return null;
}

export function resolveSlideSourceFromUrl(url: string): SlideSource | null {
  const youtubeCandidate = extractYouTubeVideoId(url);
  if (youtubeCandidate) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeCandidate}`,
      kind: "youtube",
      sourceId: buildYoutubeSourceId(youtubeCandidate),
    };
  }

  if (isDirectMediaUrl(url)) {
    return {
      url,
      kind: "direct",
      sourceId: buildDirectSourceId(url),
    };
  }

  if (isYouTubeUrl(url)) {
    const fallbackId = extractYouTubeVideoId(url);
    if (fallbackId) {
      return {
        url: `https://www.youtube.com/watch?v=${fallbackId}`,
        kind: "youtube",
        sourceId: buildYoutubeSourceId(fallbackId),
      };
    }
  }

  return null;
}

export async function extractSlidesForSource({
  source,
  settings,
  noCache = false,
  mediaCache = null,
  env,
  timeoutMs,
  ytDlpPath,
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

      const reportSlidesProgress = (() => {
        const onSlidesProgress = hooks?.onSlidesProgress;
        if (!onSlidesProgress) return null;
        let lastText = "";
        let lastPercent = 0;
        return (label: string, percent: number, detail?: string) => {
          const clamped = clamp(Math.round(percent), 0, 100);
          const nextPercent = Math.max(lastPercent, clamped);
          const suffix = detail ? ` ${detail}` : "";
          const text = `Slides: ${label}${suffix} ${nextPercent}%`;
          if (text === lastText) return;
          lastText = text;
          lastPercent = nextPercent;
          onSlidesProgress(text);
        };
      })();

      const warnings: string[] = [];
      const workers = resolveSlidesWorkers(env);
      const totalStartedAt = Date.now();
      logSlides(
        `pipeline=ingest(sequential)->scene-detect(parallel:${workers})->extract-frames(parallel:${workers})->ocr(parallel:${workers})`,
      );

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
        (await resolveRunnableTool({
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
        ytDlpPath: ytDlpBinary,
        ytDlpCookiesFromBrowser,
        resolveSlidesYtDlpExtractFormat: () => resolveSlidesYtDlpExtractFormat(env),
        resolveSlidesStreamFallback: () => resolveSlidesStreamFallback(env),
        buildSlidesMediaCacheKey,
        formatBytes,
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
        const extractElapsedMs = logSlidesTiming?.(
          `extract frames (count=${trimmed.length}, parallel=${workers})`,
          extractFramesStartedAt,
        );
        if (trimmed.length > 0 && typeof extractElapsedMs === "number") {
          logSlides?.(
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
        logSlidesTiming?.("rename slides", renameStartedAt);
        if (renamedSlides.length === 0) {
          throw new Error("No slides extracted; try lowering --slides-scene-threshold.");
        }

        let slidesWithOcr = renamedSlides;
        if (ocrEnabled && tesseractPath) {
          const ocrStartedAt = Date.now();
          logSlides?.(`ocr start count=${renamedSlides.length} mode=parallel workers=${workers}`);
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
          const elapsedMs = logSlidesTiming?.("ocr done", ocrStartedAt);
          if (renamedSlides.length > 0 && typeof elapsedMs === "number") {
            logSlides?.(`ocr avgMsPerSlide=${Math.round(elapsedMs / renamedSlides.length)}`);
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

async function prepareSlidesDir(slidesDir: string): Promise<void> {
  await fs.mkdir(slidesDir, { recursive: true });
  const entries = await fs.readdir(slidesDir);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.startsWith("slide_") && entry.endsWith(".png")) {
        await fs.rm(path.join(slidesDir, entry), { force: true });
      }
      if (entry === "slides.json") {
        await fs.rm(path.join(slidesDir, entry), { force: true });
      }
    }),
  );
}

async function withSlidesLock<T>(
  key: string,
  fn: () => Promise<T>,
  onWait?: (() => void) | null,
): Promise<T> {
  const previous = slidesLocks.get(key) ?? null;
  if (previous && onWait) onWait();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  slidesLocks.set(key, current);
  await (previous ?? Promise.resolve());
  try {
    return await fn();
  } finally {
    release();
    if (slidesLocks.get(key) === current) {
      slidesLocks.delete(key);
    }
  }
}
