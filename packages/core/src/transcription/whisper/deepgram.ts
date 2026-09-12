import { openAsBlob } from "node:fs";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { resolveDeepgramTranscriptionModel } from "./provider-setup.js";
import type { TranscriptionSegment } from "./types.js";
import { readErrorDetail, toArrayBuffer } from "./utils.js";

type Env = Record<string, string | undefined>;

const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1";

export type DeepgramTranscriptionResult = {
  text: string | null;
  segments: TranscriptionSegment[] | null;
};

type DeepgramOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  env?: Env;
  model?: string | null;
  timeoutMs?: number;
};

export async function transcribeWithDeepgram(
  bytes: Uint8Array,
  mediaType: string,
  apiKey: string,
  options: DeepgramOptions = {},
): Promise<DeepgramTranscriptionResult> {
  return await transcribeDeepgramBody(
    new Blob([toArrayBuffer(bytes)], { type: normalizeMediaType(mediaType) }),
    mediaType,
    apiKey,
    options,
  );
}

export async function transcribeFileWithDeepgram({
  filePath,
  mediaType,
  apiKey,
  ...options
}: {
  filePath: string;
  mediaType: string;
  apiKey: string;
} & DeepgramOptions): Promise<DeepgramTranscriptionResult> {
  return await transcribeDeepgramBody(
    await openAsBlob(filePath, { type: normalizeMediaType(mediaType) }),
    mediaType,
    apiKey,
    options,
  );
}

async function transcribeDeepgramBody(
  body: BodyInit,
  mediaType: string,
  apiKey: string,
  {
    fetchImpl = globalThis.fetch,
    baseUrl = DEEPGRAM_BASE_URL,
    env,
    model,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  }: DeepgramOptions,
): Promise<DeepgramTranscriptionResult> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/listen`);
  url.searchParams.set("model", model?.trim() || resolveDeepgramTranscriptionModel(env));
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("detect_language", "true");
  url.searchParams.set("utterances", "true");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Token ${apiKey}`,
      "content-type": normalizeMediaType(mediaType),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Deepgram transcription failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const payload = await response.json().catch(() => null);
  return parseDeepgramResponse(payload);
}

export function parseDeepgramResponse(payload: unknown): DeepgramTranscriptionResult {
  if (!payload || typeof payload !== "object") return { text: null, segments: null };
  const results = (payload as { results?: unknown }).results;
  if (!results || typeof results !== "object") return { text: null, segments: null };

  const channels = (results as { channels?: unknown }).channels;
  const firstChannel = Array.isArray(channels) ? channels[0] : null;
  const alternatives =
    firstChannel && typeof firstChannel === "object"
      ? (firstChannel as { alternatives?: unknown }).alternatives
      : null;
  const firstAlternative = Array.isArray(alternatives) ? alternatives[0] : null;
  const rawTranscript =
    firstAlternative && typeof firstAlternative === "object"
      ? (firstAlternative as { transcript?: unknown }).transcript
      : null;
  const text = typeof rawTranscript === "string" ? rawTranscript.trim() || null : null;

  const utterances = (results as { utterances?: unknown }).utterances;
  const segments = Array.isArray(utterances)
    ? utterances
        .map(parseDeepgramUtterance)
        .filter((segment): segment is TranscriptionSegment => segment !== null)
    : [];
  return { text, segments: segments.length > 0 ? segments : null };
}

function parseDeepgramUtterance(value: unknown): TranscriptionSegment | null {
  if (!value || typeof value !== "object") return null;
  const utterance = value as Record<string, unknown>;
  const text =
    typeof utterance.transcript === "string"
      ? utterance.transcript.replace(/\s+/g, " ").trim()
      : "";
  const startMs = secondsToMs(utterance.start);
  const endMs = secondsToMs(utterance.end);
  if (!text || startMs == null) return null;
  return { startMs, endMs, text };
}

function secondsToMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : null;
}

function normalizeMediaType(value: string): string {
  return value.trim() || "application/octet-stream";
}
