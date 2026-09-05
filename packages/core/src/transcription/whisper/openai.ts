import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { resolveOpenAiWhisperBaseUrl } from "../../openai/base-url.js";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { formatDiarizedTranscript, formatSpeakerLabel } from "./diarization-format.js";
import type { TranscriptionSegment, WhisperTranscriptionResult } from "./types.js";
import { ensureWhisperFilenameExtension, readErrorDetail, toArrayBuffer } from "./utils.js";

type Env = Record<string, string | undefined>;
export const OPENAI_DIARIZATION_MODEL = "gpt-4o-transcribe-diarize";

export class OpenAiTranscriptionHttpError extends Error {
  override name = "OpenAiTranscriptionHttpError";
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null, detail: string | null) {
    super(`OpenAI transcription failed (${status})${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function transcribeWithOpenAi(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | null,
  apiKey: string,
  options?: {
    baseUrl?: string | null;
    env?: Env;
  },
): Promise<string | null> {
  const form = new FormData();
  const providedName = filename?.trim() ? filename.trim() : "media";
  // Whisper sometimes relies on the filename extension for format detection; ensure a reasonable one.
  const safeName = ensureWhisperFilenameExtension(providedName, mediaType);
  form.append("file", new Blob([toArrayBuffer(bytes)], { type: mediaType }), safeName);
  form.append("model", "whisper-1");

  const response = await requestOpenAiTranscription(form, apiKey, options);
  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload?.text !== "string") return null;
  const trimmed = payload.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function transcribeFileWithOpenAiDiarization({
  filePath,
  mediaType,
  filename,
  apiKey,
  options,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  apiKey: string;
  options?: {
    baseUrl?: string | null;
    env?: Env;
    allowEmpty?: boolean;
  };
}): Promise<WhisperTranscriptionResult> {
  const form = new FormData();
  const file = await openAsBlob(filePath, { type: mediaType });
  form.append("file", file, filename?.trim() || basename(filePath));
  form.append("model", OPENAI_DIARIZATION_MODEL);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

  const response = await requestOpenAiTranscription(form, apiKey, options);
  const payload = (await response.json()) as { segments?: unknown; text?: unknown };
  if (!Array.isArray(payload.segments)) {
    throw new Error("OpenAI transcription returned an invalid diarized segment payload");
  }
  const segments = parseOpenAiDiarizedSegments(payload.segments);
  const meaningfulSegmentCount = payload.segments.filter(
    (segment) => !isIgnorableEmptyDiarizedSegment(segment),
  ).length;
  if (segments.length !== meaningfulSegmentCount) {
    throw new Error("OpenAI transcription returned malformed diarized segments");
  }
  const text = formatDiarizedTranscript(segments);
  if (!text) {
    if (options?.allowEmpty) {
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        throw new Error("OpenAI transcription returned transcript text without diarized segments");
      }
      return {
        text: null,
        provider: "openai",
        error: null,
        notes: ["OpenAI diarization: chunk contained no speech"],
        segments: [],
      };
    }
    throw new Error("OpenAI transcription returned no speaker-labelled segments");
  }
  return { text, provider: "openai", error: null, notes: [], segments };
}

function isIgnorableEmptyDiarizedSegment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return (
    typeof segment.text === "string" &&
    segment.text.trim().length === 0 &&
    typeof segment.speaker === "string" &&
    segment.speaker.trim().length > 0 &&
    typeof segment.start === "number" &&
    Number.isFinite(segment.start) &&
    segment.start >= 0
  );
}

export function parseOpenAiDiarizedSegments(segments: unknown): TranscriptionSegment[] {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((entry): TranscriptionSegment | null => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
      const speaker = typeof item.speaker === "string" ? item.speaker.trim() : "";
      const startMs = parseSecondsToMs(item.start);
      const endMs = parseSecondsToMs(item.end);
      if (!text || !speaker || startMs == null) return null;
      return {
        startMs,
        endMs,
        text,
        speaker: formatSpeakerLabel(speaker),
      };
    })
    .filter((segment): segment is TranscriptionSegment => segment !== null);
}

function parseSecondsToMs(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 1000) : null;
}

export function shouldRetryOpenAiViaFfmpeg(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("unrecognized file format") ||
    msg.includes("could not be decoded") ||
    msg.includes("format is not supported")
  );
}

function resolveRetryAfterMs(
  headers: Headers,
  status: number,
  detail: string | null,
): number | null {
  const retryAfterMs = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  if (status !== 429) return null;
  const tokenReset = parseRateLimitDurationMs(headers.get("x-ratelimit-reset-tokens"));
  const requestReset = parseRateLimitDurationMs(headers.get("x-ratelimit-reset-requests"));
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens");
  const remainingRequests = headers.get("x-ratelimit-remaining-requests");
  const exhaustedResets = [
    remainingTokens !== null && Number(remainingTokens) === 0 ? tokenReset : null,
    remainingRequests !== null && Number(remainingRequests) === 0 ? requestReset : null,
  ].filter((value): value is number => value !== null);
  if (exhaustedResets.length > 0) return Math.max(...exhaustedResets);
  const normalizedDetail = detail?.toLowerCase() ?? "";
  if (/tokens per|\btpm\b|token rate/.test(normalizedDetail) && tokenReset !== null) {
    return tokenReset;
  }
  if (/requests per|\brpm\b|request rate/.test(normalizedDetail) && requestReset !== null) {
    return requestReset;
  }
  const availableResets = [tokenReset, requestReset].filter(
    (value): value is number => value !== null,
  );
  return availableResets.length > 0 ? Math.max(...availableResets) : null;
}

function parseRateLimitDurationMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1_000;
  const unitPattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = "";
  for (const match of trimmed.matchAll(unitPattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    consumed += match[0];
    total +=
      amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return consumed === trimmed && total >= 0 ? total : null;
}

async function requestOpenAiTranscription(
  form: FormData,
  apiKey: string,
  options?: { baseUrl?: string | null; env?: Env },
): Promise<Response> {
  const effectiveBaseUrl = resolveOpenAiWhisperBaseUrl({
    explicitBaseUrl: options?.baseUrl,
    env: options?.env,
  });
  const transcriptionUrl = `${effectiveBaseUrl.replace(/\/+$/, "")}/audio/transcriptions`;

  const response = await globalThis.fetch(transcriptionUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new OpenAiTranscriptionHttpError(
      response.status,
      resolveRetryAfterMs(response.headers, response.status, detail),
      detail,
    );
  }

  return response;
}
