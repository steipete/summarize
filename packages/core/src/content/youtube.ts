import { extractInitialPlayerResponse } from "./transcript/providers/youtube/captions-player.js";

const ANDROID_VR_CLIENT_NAME = "ANDROID_VR";
const ANDROID_VR_CLIENT_ID = "28";
const ANDROID_VR_CLIENT_VERSION = "1.65.10";
const ANDROID_VR_USER_AGENT =
  "com.google.android.youtube/1.65.10 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";
const PLAYER_TIMEOUT_MS = 20_000;

export type YoutubeAudioFormat = {
  url: string;
  mimeType: string;
  bitrate: number | null;
  contentLength: number | null;
  durationSeconds: number | null;
  filename: string;
};

export type ResolvedYoutubeAudioFormat = YoutubeAudioFormat & {
  resolver: "watch-page" | "android-vr";
};

export type YoutubePlayerBootstrap = {
  apiKey: string;
  visitorData: string | null;
};

type RecordLike = Record<string, unknown>;

export function extractYoutubePlayerBootstrap(html: string): YoutubePlayerBootstrap | null {
  const apiKey =
    extractQuotedConfigValue(html, "INNERTUBE_API_KEY") ??
    extractEscapedConfigValue(html, "INNERTUBE_API_KEY");
  if (!apiKey) return null;

  const visitorData =
    extractQuotedConfigValue(html, "VISITOR_DATA") ??
    extractEscapedConfigValue(html, "VISITOR_DATA") ??
    extractQuotedConfigValue(html, "visitorData");
  return { apiKey, visitorData };
}

export async function resolveYoutubeAudioWithAndroidVr({
  fetchImpl,
  videoId,
  apiKey,
  visitorData = null,
  originalUrl = `https://www.youtube.com/watch?v=${videoId}`,
  preferredMimeTypes = [],
}: {
  fetchImpl: typeof fetch;
  videoId: string;
  apiKey: string;
  visitorData?: string | null;
  originalUrl?: string;
  preferredMimeTypes?: readonly string[];
}): Promise<YoutubeAudioFormat> {
  const client: RecordLike = {
    clientName: ANDROID_VR_CLIENT_NAME,
    clientVersion: ANDROID_VR_CLIENT_VERSION,
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    androidSdkVersion: 32,
    osName: "Android",
    osVersion: "12L",
    userAgent: ANDROID_VR_USER_AGENT,
    originalUrl,
    hl: "en",
    gl: "US",
  };
  if (visitorData) client.visitorData = visitorData;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Youtube-Client-Name": ANDROID_VR_CLIENT_ID,
    "X-Youtube-Client-Version": ANDROID_VR_CLIENT_VERSION,
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

  const response = await fetchImpl(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      credentials: "omit",
      headers,
      body: JSON.stringify({
        context: { client },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`YouTube Android VR player request failed (${response.status})`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("YouTube Android VR returned an invalid response");
  const playability = isRecord(payload.playabilityStatus) ? payload.playabilityStatus : null;
  const status = stringValue(playability?.status);
  if (status !== "OK") {
    const reason = stringValue(playability?.reason);
    throw new Error(
      `YouTube Android VR media unavailable${status ? ` (${status})` : ""}${reason ? `: ${reason}` : ""}`,
    );
  }

  const selected = selectAudioFormat(payload, preferredMimeTypes);
  if (!selected) {
    throw new Error("YouTube Android VR returned no direct audio format");
  }
  return selected;
}

export function extractYoutubeAudioFromWatchHtml(
  html: string,
  preferredMimeTypes: readonly string[] = [],
): YoutubeAudioFormat | null {
  const playerResponse = extractInitialPlayerResponse(html);
  return playerResponse ? selectAudioFormat(playerResponse, preferredMimeTypes) : null;
}

export async function resolveYoutubeAudio({
  fetchImpl,
  videoId,
  apiKey,
  visitorData = null,
  originalUrl = `https://www.youtube.com/watch?v=${videoId}`,
  preferredMimeTypes = [],
  watchHtml = null,
}: {
  fetchImpl: typeof fetch;
  videoId: string;
  apiKey: string;
  visitorData?: string | null;
  originalUrl?: string;
  preferredMimeTypes?: readonly string[];
  watchHtml?: string | null;
}): Promise<ResolvedYoutubeAudioFormat> {
  const embedded = watchHtml
    ? extractYoutubeAudioFromWatchHtml(watchHtml, preferredMimeTypes)
    : null;
  if (embedded) return { ...embedded, resolver: "watch-page" };

  return {
    ...(await resolveYoutubeAudioWithAndroidVr({
      fetchImpl,
      videoId,
      apiKey,
      visitorData,
      originalUrl,
      preferredMimeTypes,
    })),
    resolver: "android-vr",
  };
}

function selectAudioFormat(
  payload: RecordLike,
  preferredMimeTypes: readonly string[],
): YoutubeAudioFormat | null {
  const streamingData = isRecord(payload.streamingData) ? payload.streamingData : null;
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
    ? streamingData.adaptiveFormats
    : [];
  const candidates = adaptiveFormats
    .filter(isRecord)
    .map(parseAudioFormat)
    .filter((format): format is YoutubeAudioFormat => format !== null)
    .sort((left, right) => {
      const mimePreference =
        mimePreferenceIndex(left.mimeType, preferredMimeTypes) -
        mimePreferenceIndex(right.mimeType, preferredMimeTypes);
      return mimePreference || (right.bitrate ?? 0) - (left.bitrate ?? 0);
    });
  return candidates[0] ?? null;
}

function mimePreferenceIndex(mimeType: string, preferredMimeTypes: readonly string[]): number {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const index = preferredMimeTypes.findIndex(
    (preferred) => preferred.trim().toLowerCase() === normalized,
  );
  return index < 0 ? preferredMimeTypes.length : index;
}

function parseAudioFormat(value: RecordLike): YoutubeAudioFormat | null {
  const url = stringValue(value.url);
  const mimeType = stringValue(value.mimeType);
  if (!url || !mimeType?.toLowerCase().startsWith("audio/")) return null;

  const bitrate = numberValue(value.bitrate);
  const contentLength = numberValue(value.contentLength);
  const durationMs = numberValue(value.approxDurationMs);
  const durationSeconds = durationMs === null ? null : durationMs / 1000;
  return {
    url,
    mimeType,
    bitrate,
    contentLength,
    durationSeconds,
    filename: `youtube-${stringValue(value.itag) ?? "audio"}${extensionForMimeType(mimeType)}`,
  };
}

function extractQuotedConfigValue(html: string, key: string): string | null {
  const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`);
  return pattern.exec(html)?.[1] ?? null;
}

function extractEscapedConfigValue(html: string, key: string): string | null {
  const pattern = new RegExp(`${escapeRegExp(key)}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`);
  return pattern.exec(html)?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/webm") return ".webm";
  if (normalized === "audio/mp4") return ".m4a";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/ogg") return ".ogg";
  return ".bin";
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
