export type DirectMediaKind = "video" | "audio";

const DIRECT_VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "webm",
  "mpeg",
  "mpg",
  "avi",
  "wmv",
  "flv",
  "m3u8",
] as const;

const DIRECT_AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "wav",
  "flac",
  "aac",
  "ogg",
  "opus",
  "aiff",
  "wma",
] as const;

export const DIRECT_MEDIA_EXTENSIONS = [
  ...DIRECT_VIDEO_EXTENSIONS,
  ...DIRECT_AUDIO_EXTENSIONS,
] as const;

const DIRECT_VIDEO_EXTENSION_SET = new Set<string>(DIRECT_VIDEO_EXTENSIONS);
const DIRECT_AUDIO_EXTENSION_SET = new Set<string>(DIRECT_AUDIO_EXTENSIONS);
const DIRECT_MEDIA_EXTENSION_SET = new Set<string>(DIRECT_MEDIA_EXTENSIONS);
const DIRECT_MEDIA_URL_PATTERN = new RegExp(
  `\\.(${DIRECT_MEDIA_EXTENSIONS.join("|")})(\\?|#|$)`,
  "i",
);

const DIRECT_MEDIA_TYPE_BY_EXTENSION = new Map<string, string>([
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["m4v", "video/mp4"],
  ["mkv", "video/x-matroska"],
  ["mpeg", "video/mpeg"],
  ["mpg", "video/mpeg"],
  ["avi", "video/x-msvideo"],
  ["wmv", "video/x-ms-wmv"],
  ["flv", "video/x-flv"],
  ["m3u8", "application/vnd.apple.mpegurl"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["aac", "audio/aac"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["aiff", "audio/aiff"],
  ["wma", "audio/x-ms-wma"],
]);

export function normalizePathForExtension(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

export function resolveDirectMediaExtension(value: string): string | null {
  const match = normalizePathForExtension(value)
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/i);
  return match?.[1] ?? null;
}

export function isDirectMediaUrl(url: string): boolean {
  return DIRECT_MEDIA_URL_PATTERN.test(url);
}

export function isDirectMediaExtension(ext: string): boolean {
  const normalized = ext.trim().replace(/^\./, "").toLowerCase();
  return DIRECT_MEDIA_EXTENSION_SET.has(normalized);
}

export function inferDirectMediaKind(value: string): DirectMediaKind | null {
  const ext = resolveDirectMediaExtension(value);
  if (!ext) return null;
  if (DIRECT_VIDEO_EXTENSION_SET.has(ext)) return "video";
  if (DIRECT_AUDIO_EXTENSION_SET.has(ext)) return "audio";
  return null;
}

export function isDirectVideoInput(value: string): boolean {
  return inferDirectMediaKind(value) === "video";
}

export function resolveDirectMediaType(
  value: string,
  kindHint: DirectMediaKind | null = null,
): string | null {
  const ext = resolveDirectMediaExtension(value);
  if (ext === "webm") {
    return kindHint === "audio" ? "audio/webm" : "video/webm";
  }
  const detected = ext ? (DIRECT_MEDIA_TYPE_BY_EXTENSION.get(ext) ?? null) : null;
  if (detected) return detected;
  if (!kindHint) return null;
  return kindHint === "video" ? "video/mp4" : "audio/mpeg";
}
