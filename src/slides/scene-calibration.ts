import { runProcessCaptureBuffer, type ProcessCommand } from "./process.js";
import { clamp, roundThreshold } from "./scene-detection.js";

const FFMPEG_CALIBRATION_SAMPLE_TIMEOUT_MS = 10_000;

function buildCalibrationSampleTimestamps(
  durationSeconds: number | null,
  sampleCount: number,
): number[] {
  if (!durationSeconds || durationSeconds <= 0) return [0];
  const clamped = Math.max(3, Math.min(12, Math.round(sampleCount)));
  const startRatio = 0.05;
  const endRatio = 0.95;
  const step = (endRatio - startRatio) / (clamped - 1);
  const points: number[] = [];
  for (let i = 0; i < clamped; i += 1) {
    const ratio = startRatio + step * i;
    points.push(clamp(durationSeconds * ratio, 0, durationSeconds - 0.1));
  }
  return points;
}

function computeDiffStats(values: number[]): {
  median: number;
  p75: number;
  p90: number;
  max: number;
} {
  if (values.length === 0) return { median: 0, p75: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p)))] ?? 0;
  return {
    median: at((sorted.length - 1) * 0.5),
    p75: at((sorted.length - 1) * 0.75),
    p90: at((sorted.length - 1) * 0.9),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function buildAverageHash(pixels: Uint8Array): Uint8Array {
  let sum = 0;
  for (const value of pixels) sum += value;
  const avg = sum / pixels.length;
  const bits = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    bits[i] = pixels[i] >= avg ? 1 : 0;
  }
  return bits;
}

function computeHashDistanceRatio(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return len === 0 ? 0 : diff / len;
}

async function hashFrameAtTimestamp({
  ffmpegPath,
  inputPath,
  timestamp,
  timeoutMs,
}: {
  ffmpegPath: ProcessCommand;
  inputPath: string;
  timestamp: number;
  timeoutMs: number;
}): Promise<Uint8Array | null> {
  try {
    const buffer = await runProcessCaptureBuffer({
      command: ffmpegPath,
      args: [
        "-hide_banner",
        "-ss",
        String(timestamp),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=32:32,format=gray",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ],
      // Calibration is optional. A bundled WebAssembly runner can finish the
      // frame and then linger during Node/V8 shutdown, so do not let one sample
      // consume the full request timeout and block the remaining slide work.
      timeoutMs: Math.min(Math.max(timeoutMs, 1), FFMPEG_CALIBRATION_SAMPLE_TIMEOUT_MS),
      errorLabel: "ffmpeg",
    });
    if (buffer.length < 1024) return null;
    return buildAverageHash(buffer.subarray(0, 1024));
  } catch {
    return null;
  }
}

export async function calibrateSceneThreshold({
  ffmpegPath,
  inputPath,
  durationSeconds,
  sampleCount,
  timeoutMs,
  logSlides,
}: {
  ffmpegPath: ProcessCommand;
  inputPath: string;
  durationSeconds: number | null;
  sampleCount: number;
  timeoutMs: number;
  logSlides?: ((message: string) => void) | null;
}): Promise<{ threshold: number; confidence: number }> {
  const timestamps = buildCalibrationSampleTimestamps(durationSeconds, sampleCount);
  if (timestamps.length < 2) return { threshold: 0.2, confidence: 0 };

  const hashes: Uint8Array[] = [];
  for (const timestamp of timestamps) {
    const hash = await hashFrameAtTimestamp({ ffmpegPath, inputPath, timestamp, timeoutMs });
    if (hash) hashes.push(hash);
  }

  const diffs: number[] = [];
  for (let i = 1; i < hashes.length; i += 1) {
    diffs.push(computeHashDistanceRatio(hashes[i - 1], hashes[i]));
  }

  const stats = computeDiffStats(diffs);
  let threshold = roundThreshold(Math.max(stats.median * 0.15, stats.p75 * 0.2, stats.p90 * 0.25));
  if (stats.p75 >= 0.12) {
    threshold = Math.min(threshold, 0.05);
  } else if (stats.p90 < 0.05) {
    threshold = 0.05;
  }
  threshold = clamp(threshold, 0.05, 0.3);
  const confidence =
    diffs.length >= 2 ? clamp(stats.p75 / 0.25, 0, 1) : clamp(stats.max / 0.25, 0, 1);
  logSlides?.(
    `calibration samples=${timestamps.length} diffs=${diffs.length} median=${stats.median.toFixed(
      3,
    )} p75=${stats.p75.toFixed(3)} threshold=${threshold}`,
  );
  return { threshold, confidence };
}
