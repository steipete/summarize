import { runProcess, runProcessCapture, type ProcessCommand } from "./process.js";
import type { SlideImage } from "./types.js";

const FFMPEG_TIMEOUT_FALLBACK_MS = 300_000;
const FFMPEG_CAPABILITY_TIMEOUT_MS = 10_000;

export type FfmpegVfrArgs = ["-fps_mode" | "-vsync", "vfr"];

export type SceneSegment = { start: number; end: number | null };

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function parseShowinfoTimestamp(line: string): number | null {
  if (!line.includes("showinfo")) return null;
  const match = /pts_time:(\d+\.?\d*)/.exec(line);
  if (!match) return null;
  const ts = Number(match[1]);
  if (!Number.isFinite(ts)) return null;
  return ts;
}

export async function resolveFfmpegVfrArgs({
  ffmpegPath,
  timeoutMs,
}: {
  ffmpegPath: ProcessCommand;
  timeoutMs: number;
}): Promise<FfmpegVfrArgs> {
  try {
    const help = await runProcessCapture({
      command: ffmpegPath,
      args: ["-hide_banner", "-h", "long"],
      timeoutMs: Math.min(Math.max(timeoutMs, 1), FFMPEG_CAPABILITY_TIMEOUT_MS),
      errorLabel: "ffmpeg",
    });
    if (help.includes("-fps_mode")) return ["-fps_mode", "vfr"];
  } catch {
    // Older and minimal builds still support the legacy equivalent.
  }
  return ["-vsync", "vfr"];
}

export function resolveExtractedTimestamp({
  requested,
  actual,
  seekBase,
}: {
  requested: number;
  actual: number | null;
  seekBase?: number | null;
}): number {
  if (!Number.isFinite(requested)) return 0;
  if (actual == null || !Number.isFinite(actual) || actual < 0) return requested;
  const base =
    typeof seekBase === "number" && Number.isFinite(seekBase) && seekBase >= 0 ? seekBase : null;
  if (base === null) {
    if (actual <= 5) return requested + actual;
    return actual;
  }
  const candidateRelative = base + actual;
  const candidateAbsolute = actual;
  return Math.abs(candidateRelative - requested) <= Math.abs(candidateAbsolute - requested)
    ? candidateRelative
    : candidateAbsolute;
}

export function roundThreshold(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildSegments(
  durationSeconds: number | null,
  workers: number,
): Array<{ start: number; duration: number }> {
  if (!durationSeconds || durationSeconds <= 0 || workers <= 1) {
    return [{ start: 0, duration: durationSeconds ?? 0 }];
  }
  const clampedWorkers = Math.max(1, Math.min(16, Math.round(workers)));
  const segmentCount = Math.min(clampedWorkers, Math.ceil(durationSeconds / 60));
  const segmentDuration = durationSeconds / segmentCount;
  const segments: Array<{ start: number; duration: number }> = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const start = i * segmentDuration;
    const remaining = durationSeconds - start;
    const duration = i === segmentCount - 1 ? remaining : segmentDuration;
    segments.push({ start, duration });
  }
  return segments;
}

export async function detectSceneTimestamps({
  ffmpegPath,
  inputPath,
  threshold,
  timeoutMs,
  vfrArgs,
  segments,
  workers,
  onSegmentProgress,
  runWithConcurrency,
}: {
  ffmpegPath: ProcessCommand;
  inputPath: string;
  threshold: number;
  timeoutMs: number;
  vfrArgs: FfmpegVfrArgs;
  segments?: Array<{ start: number; duration: number }>;
  workers?: number;
  onSegmentProgress?: ((completed: number, total: number) => void) | null;
  runWithConcurrency: <T>(
    tasks: Array<() => Promise<T>>,
    workers: number,
    onProgress?: ((completed: number, total: number) => void) | null,
  ) => Promise<T[]>;
}): Promise<number[]> {
  const filter = `select='gt(scene,${threshold})',showinfo`;
  const usedSegments = segments && segments.length > 0 ? segments : [{ start: 0, duration: 0 }];
  const concurrency = workers && workers > 0 ? workers : 1;
  const tasks = usedSegments.map((segment) => async () => {
    const timestamps: number[] = [];
    await runProcess({
      command: ffmpegPath,
      args: [
        "-hide_banner",
        ...(segment.duration > 0
          ? ["-ss", String(segment.start), "-t", String(segment.duration)]
          : []),
        "-i",
        inputPath,
        "-vf",
        filter,
        ...vfrArgs,
        "-an",
        "-sn",
        "-f",
        "null",
        "-",
      ],
      timeoutMs: Math.max(timeoutMs, FFMPEG_TIMEOUT_FALLBACK_MS),
      errorLabel: "ffmpeg",
      onStderrLine: (line) => {
        const ts = parseShowinfoTimestamp(line);
        if (ts != null) timestamps.push(ts + segment.start);
      },
    });
    return timestamps;
  });
  const results = await runWithConcurrency(tasks, concurrency, onSegmentProgress ?? undefined);
  return results.flat().sort((a, b) => a - b);
}

export function applyMinDurationFilter(
  slides: SlideImage[],
  minDurationSeconds: number,
  warnings: string[],
  removeFile: (path: string) => void,
): SlideImage[] {
  if (minDurationSeconds <= 0) return slides;
  const filtered: SlideImage[] = [];
  let lastTimestamp = -Infinity;
  for (const slide of slides) {
    if (slide.timestamp - lastTimestamp >= minDurationSeconds) {
      filtered.push(slide);
      lastTimestamp = slide.timestamp;
    } else {
      removeFile(slide.imagePath);
    }
  }
  if (filtered.length < slides.length) {
    warnings.push(`Filtered ${slides.length - filtered.length} slides by min duration`);
  }
  return filtered.map((slide, index) => ({ ...slide, index: index + 1 }));
}

export function mergeTimestamps(
  sceneTimestamps: number[],
  intervalTimestamps: number[],
  minDurationSeconds: number,
): number[] {
  const merged = [...sceneTimestamps, ...intervalTimestamps].filter((value) =>
    Number.isFinite(value),
  );
  merged.sort((a, b) => a - b);
  if (merged.length === 0) return [];
  const result: number[] = [];
  const minGap = Math.max(0.1, minDurationSeconds * 0.5);
  for (const ts of merged) {
    if (result.length === 0 || ts - result[result.length - 1] >= minGap) {
      result.push(ts);
    }
  }
  return result;
}

export function filterTimestampsByMinDuration(
  timestamps: number[],
  minDurationSeconds: number,
): number[] {
  if (minDurationSeconds <= 0) return timestamps.slice();
  const sorted = timestamps
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  const filtered: number[] = [];
  let lastTimestamp = -Infinity;
  for (const ts of sorted) {
    if (ts - lastTimestamp >= minDurationSeconds) {
      filtered.push(ts);
      lastTimestamp = ts;
    }
  }
  return filtered;
}

export function buildSceneSegments(
  sceneTimestamps: number[],
  durationSeconds: number | null,
): SceneSegment[] {
  const sorted = sceneTimestamps
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice()
    .sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const ts of sorted) {
    if (deduped.length === 0 || ts - deduped[deduped.length - 1] > 0.05) deduped.push(ts);
  }
  const starts = [0, ...deduped];
  const ends = [...deduped, durationSeconds];
  const segments: SceneSegment[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const rawEnd = ends[i];
    const end =
      typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : null;
    segments.push({ start, end });
  }
  return segments;
}

export function findSceneSegment(segments: SceneSegment[], timestamp: number): SceneSegment | null {
  for (const segment of segments) {
    if (timestamp >= segment.start && (segment.end == null || timestamp < segment.end)) {
      return segment;
    }
  }
  return segments[segments.length - 1] ?? null;
}

export function adjustTimestampWithinSegment(
  timestamp: number,
  segment: SceneSegment | null,
): number {
  if (!segment) return timestamp;
  const start = Math.max(0, segment.start);
  const end = segment.end;
  if (end == null || !Number.isFinite(end) || end <= start) return Math.max(timestamp, start);
  const duration = Math.max(0, end - start);
  const padding = Math.min(1.5, Math.max(0.2, duration * 0.08));
  if (duration <= padding * 2) return start + duration * 0.5;
  return clamp(timestamp, start + padding, end - padding);
}

export function selectTimestampTargets({
  targets,
  sceneTimestamps,
  minDurationSeconds,
  intervalSeconds,
}: {
  targets: number[];
  sceneTimestamps: number[];
  minDurationSeconds: number;
  intervalSeconds: number;
}): number[] {
  const targetList = targets
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (targetList.length === 0) return [];

  const sceneList = filterTimestampsByMinDuration(
    sceneTimestamps,
    Math.max(0.1, minDurationSeconds * 0.25),
  );
  const windowSeconds = Math.max(2, Math.min(10, intervalSeconds * 0.35));
  const picked: number[] = [];
  let lastPicked = -Infinity;
  let sceneIndex = 0;

  for (const target of targetList) {
    while (sceneIndex < sceneList.length && sceneList[sceneIndex] < target - windowSeconds) {
      sceneIndex += 1;
    }
    let best: number | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let idx = sceneIndex; idx < sceneList.length; idx += 1) {
      const candidate = sceneList[idx];
      if (candidate > target + windowSeconds) break;
      const diff = Math.abs(candidate - target);
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
    }
    const candidate = best ?? target;
    const chosen = candidate - lastPicked >= minDurationSeconds ? candidate : target;
    picked.push(chosen);
    lastPicked = chosen;
  }

  return picked;
}

export function buildIntervalTimestamps({
  durationSeconds,
  minDurationSeconds,
  maxSlides,
}: {
  durationSeconds: number | null;
  minDurationSeconds: number;
  maxSlides: number;
}): { timestamps: number[]; intervalSeconds: number } | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const maxCount = Math.max(1, Math.floor(maxSlides));
  const targetCount = Math.min(maxCount, clamp(Math.round(durationSeconds / 180), 6, 20));
  const intervalSeconds = Math.max(minDurationSeconds, durationSeconds / targetCount);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const timestamps: number[] = [];
  for (let t = 0; t < durationSeconds; t += intervalSeconds) timestamps.push(t);
  return { timestamps, intervalSeconds };
}

export async function probeVideoInfo({
  ffprobePath,
  inputPath,
  timeoutMs,
}: {
  ffprobePath: ProcessCommand;
  inputPath: string;
  timeoutMs: number;
}): Promise<{ durationSeconds: number | null; width: number | null; height: number | null }> {
  try {
    const output = await runProcessCapture({
      command: ffprobePath,
      args: ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", inputPath],
      timeoutMs: Math.min(timeoutMs, 30_000),
      errorLabel: "ffprobe",
    });
    const parsed = JSON.parse(output) as {
      streams?: Array<{
        codec_type?: string;
        duration?: string | number;
        width?: number;
        height?: number;
      }>;
      format?: { duration?: string | number };
    };
    let durationSeconds: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    for (const stream of parsed.streams ?? []) {
      if (stream.codec_type !== "video") continue;
      if (width == null && typeof stream.width === "number") width = stream.width;
      if (height == null && typeof stream.height === "number") height = stream.height;
      const duration = Number(stream.duration);
      if (Number.isFinite(duration) && duration > 0) durationSeconds = duration;
    }
    if (durationSeconds == null) {
      const formatDuration = Number(parsed.format?.duration);
      if (Number.isFinite(formatDuration) && formatDuration > 0) durationSeconds = formatDuration;
    }
    return { durationSeconds, width, height };
  } catch {
    return { durationSeconds: null, width: null, height: null };
  }
}

export function applyMaxSlidesFilter<
  T extends { index: number; timestamp: number; imagePath: string },
>(slides: T[], maxSlides: number, warnings: string[], removeFile: (path: string) => void): T[] {
  if (maxSlides <= 0 || slides.length <= maxSlides) return slides;
  const kept = slides.slice(0, maxSlides);
  const removed = slides.slice(maxSlides);
  for (const slide of removed) {
    if (slide.imagePath) removeFile(slide.imagePath);
  }
  warnings.push(`Trimmed slides to max ${maxSlides}`);
  return kept.map((slide, index) => ({ ...slide, index: index + 1 }));
}
