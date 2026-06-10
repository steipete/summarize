import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { resolveOpenAiWhisperBaseUrl } from "../../openai/base-url.js";
import { MAX_ERROR_DETAIL_CHARS, TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { formatDiarizedTranscript, formatSpeakerLabel } from "./diarization-format.js";
import type { TranscriptionSegment, WhisperTranscriptionResult } from "./types.js";
import { ensureWhisperFilenameExtension, toArrayBuffer } from "./utils.js";

type Env = Record<string, string | undefined>;
export const OPENAI_DIARIZATION_MODEL = "gpt-4o-transcribe-diarize";

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
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`OpenAI transcription failed (${response.status})${suffix}`);
  }

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
  };
}): Promise<WhisperTranscriptionResult> {
  const form = new FormData();
  const file = await openAsBlob(filePath, { type: mediaType });
  form.append("file", file, filename?.trim() || basename(filePath));
  form.append("model", OPENAI_DIARIZATION_MODEL);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

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
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`OpenAI transcription failed (${response.status})${suffix}`);
  }

  const payload = (await response.json()) as { segments?: unknown };
  const segments = parseOpenAiDiarizedSegments(payload.segments);
  const text = formatDiarizedTranscript(segments);
  if (!text) {
    throw new Error("OpenAI transcription returned no speaker-labelled segments");
  }
  return { text, provider: "openai", error: null, notes: [], segments };
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

async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_ERROR_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
      : trimmed;
  } catch {
    return null;
  }
}
