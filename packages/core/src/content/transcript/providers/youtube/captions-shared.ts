import type { TranscriptSegment } from "../../../link-preview/types.js";

export interface YoutubeTranscriptContext {
  html: string;
  originalUrl: string;
  videoId: string;
}

export type TranscriptPayload = {
  text: string;
  segments: TranscriptSegment[] | null;
};

export const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export const INNERTUBE_API_KEY_REGEX =
  /"INNERTUBE_API_KEY":"([^"]+)"|INNERTUBE_API_KEY\\":\\"([^\\"]+)\\"/;

export const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export type YoutubePlayerContext = Record<string, unknown> & { client?: unknown };
export type CaptionsPayload = Record<string, unknown> & {
  captions?: unknown;
  playerCaptionsTracklistRenderer?: unknown;
};
export type CaptionListRenderer = Record<string, unknown> & {
  captionTracks?: unknown;
  automaticCaptions?: unknown;
};
