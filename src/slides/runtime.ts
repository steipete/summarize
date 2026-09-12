import { resolveBundledFfmpegCommand } from "@steipete/summarize-core/ffmpeg";
import { resolveExecutableInPath } from "../application/environment.js";
import { canSpawnCommand } from "../run/env.js";
import type { ProcessCommand } from "./process.js";
import { clamp } from "./scene-detection.js";

const DEFAULT_SLIDES_WORKERS = 8;
const DEFAULT_SLIDES_SAMPLE_COUNT = 8;
// Prefer broadly-decodable H.264/MP4 for ffmpeg stability.
// (Some "bestvideo" picks AV1 which can fail on certain ffmpeg builds / hwaccel setups.)
const DEFAULT_YT_DLP_FORMAT_EXTRACT =
  "bestvideo[height<=720][vcodec^=avc1][ext=mp4]/best[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/best[height<=720]";

type SlidesLogger = ((message: string) => void) | null;

export function createSlidesLogger(logger: SlidesLogger) {
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

export function resolveSlidesWorkers(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_WORKERS ?? env.SLIDES_WORKERS;
  if (!raw) return DEFAULT_SLIDES_WORKERS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_WORKERS;
  return Math.max(1, Math.min(16, Math.round(parsed)));
}

export function resolveSlidesSampleCount(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_SAMPLES ?? env.SLIDES_SAMPLES;
  if (!raw) return DEFAULT_SLIDES_SAMPLE_COUNT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_SAMPLE_COUNT;
  return Math.max(3, Math.min(12, Math.round(parsed)));
}

export function resolveSlidesYtDlpExtractFormat(env: Record<string, string | undefined>): string {
  return (
    env.SUMMARIZE_SLIDES_YTDLP_FORMAT_EXTRACT ??
    env.SLIDES_YTDLP_FORMAT_EXTRACT ??
    DEFAULT_YT_DLP_FORMAT_EXTRACT
  ).trim();
}

export function resolveSlidesStreamFallback(env: Record<string, string | undefined>): boolean {
  const raw = env.SLIDES_EXTRACT_STREAM?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

type ResolveRunnableToolArgs = {
  binary: string;
  env: Record<string, string | undefined>;
  explicitEnvKey?: string;
  probeArgs: string[];
};

export function resolveRunnableTool(
  args: ResolveRunnableToolArgs & { binary: "ffmpeg" | "ffprobe" },
): Promise<ProcessCommand | null>;
export function resolveRunnableTool(args: ResolveRunnableToolArgs): Promise<string | null>;
export async function resolveRunnableTool({
  binary,
  env,
  explicitEnvKey,
  probeArgs,
}: ResolveRunnableToolArgs): Promise<ProcessCommand | null> {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) {
    return (await canSpawnCommand({ command: explicit, args: probeArgs, env })) ? explicit : null;
  }
  const resolved = resolveExecutableInPath(binary, env, explicitEnvKey);
  if (resolved) return resolved;
  if (await canSpawnCommand({ command: binary, args: probeArgs, env })) return binary;
  if (binary === "ffmpeg" || binary === "ffprobe") {
    return resolveBundledFfmpegCommand(binary);
  }
  return null;
}

export function createSlidesProgress(
  onSlidesProgress: ((text: string) => void) | null | undefined,
) {
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
}
