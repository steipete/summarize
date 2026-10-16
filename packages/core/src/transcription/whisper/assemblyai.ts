import { openAsBlob } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { toArrayBuffer, wrapError } from "./utils.js";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
export const ASSEMBLYAI_DEFAULT_SPEECH_MODEL = "universal-2";
export const ASSEMBLYAI_DEFAULT_MODELS = [ASSEMBLYAI_DEFAULT_SPEECH_MODEL] as const;
export const ASSEMBLYAI_TRANSCRIPTION_MODEL_ID =
  `assemblyai/${ASSEMBLYAI_DEFAULT_SPEECH_MODEL}` as const;
const ASSEMBLYAI_POLL_INTERVAL_MS = 1_500;

type AssemblyAiOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  mediaType?: string | null;
};

type UploadResponse = {
  upload_url?: unknown;
};

type TranscriptResponse = {
  id?: unknown;
  status?: unknown;
  text?: unknown;
  error?: unknown;
};

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch;
}

function buildHeaders(apiKey: string, contentType?: string | null): Headers {
  const headers = new Headers({ authorization: apiKey });
  if (contentType?.trim()) headers.set("content-type", contentType.trim());
  return headers;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`AssemblyAI ${label} missing from response`);
}

function assemblyTimedOut(timeoutMs: number): Error {
  return new Error(`transcript polling timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function assemblyFetch(
  fetchImpl: typeof fetch | undefined,
  url: string,
  init: RequestInit & { duplex?: "half" },
  timeoutMs: number,
): Promise<Response> {
  try {
    return await resolveFetch(fetchImpl)(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw assemblyTimedOut(timeoutMs);
    throw error;
  }
}

async function readAssemblyBody<T>(
  read: () => Promise<T>,
  fallback: T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  try {
    return await read();
  } catch {
    if (signal?.aborted) throw assemblyTimedOut(timeoutMs);
    return fallback;
  }
}

async function uploadViaAssemblyAi(
  body: BodyInit,
  apiKey: string,
  {
    fetchImpl,
    baseUrl = ASSEMBLYAI_BASE_URL,
    mediaType,
    signal,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "mediaType"> & {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<string> {
  const res = await assemblyFetch(
    fetchImpl,
    `${baseUrl}/upload`,
    {
      method: "POST",
      headers: buildHeaders(apiKey, mediaType ?? "application/octet-stream"),
      body,
      duplex: "half",
      signal,
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await readAssemblyBody(() => res.text(), "", signal, timeoutMs);
    throw new Error(`upload failed (${res.status}): ${text.trim() || res.statusText}`);
  }
  const payload = (await readAssemblyBody(
    () => res.json(),
    null,
    signal,
    timeoutMs,
  )) as UploadResponse | null;
  return requireString(payload?.upload_url, "upload_url");
}

async function submitAssemblyAiTranscript(
  audioUrl: string,
  apiKey: string,
  {
    fetchImpl,
    baseUrl = ASSEMBLYAI_BASE_URL,
    signal,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl"> & {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ id: string; status: string; text: string | null }> {
  const res = await assemblyFetch(
    fetchImpl,
    `${baseUrl}/transcript`,
    {
      method: "POST",
      headers: buildHeaders(apiKey, "application/json"),
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: [...ASSEMBLYAI_DEFAULT_MODELS],
        punctuate: true,
        format_text: true,
      }),
      signal,
    },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await readAssemblyBody(() => res.text(), "", signal, timeoutMs);
    throw new Error(`transcript create failed (${res.status}): ${text.trim() || res.statusText}`);
  }
  const payload = (await readAssemblyBody(
    () => res.json(),
    null,
    signal,
    timeoutMs,
  )) as TranscriptResponse | null;
  return {
    id: requireString(payload?.id, "transcript id"),
    status: typeof payload?.status === "string" ? payload.status : "queued",
    text: typeof payload?.text === "string" && payload.text.trim() ? payload.text.trim() : null,
  };
}

async function pollAssemblyAiTranscript(
  id: string,
  apiKey: string,
  {
    fetchImpl,
    baseUrl = ASSEMBLYAI_BASE_URL,
    pollIntervalMs = ASSEMBLYAI_POLL_INTERVAL_MS,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
    signal,
  }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "pollIntervalMs" | "timeoutMs"> & {
    signal?: AbortSignal;
  },
): Promise<string | null> {
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted || Date.now() - startedAt > timeoutMs) {
      throw assemblyTimedOut(timeoutMs);
    }
    const res = await assemblyFetch(
      fetchImpl,
      `${baseUrl}/transcript/${encodeURIComponent(id)}`,
      {
        method: "GET",
        headers: buildHeaders(apiKey),
        signal,
      },
      timeoutMs,
    );
    if (!res.ok) {
      const text = await readAssemblyBody(() => res.text(), "", signal, timeoutMs);
      throw new Error(`transcript poll failed (${res.status}): ${text.trim() || res.statusText}`);
    }
    const payload = (await readAssemblyBody(
      () => res.json(),
      null,
      signal,
      timeoutMs,
    )) as TranscriptResponse | null;
    const status = typeof payload?.status === "string" ? payload.status.trim().toLowerCase() : "";
    if (status === "completed") {
      return typeof payload?.text === "string" && payload.text.trim() ? payload.text.trim() : null;
    }
    if (status === "error") {
      const message =
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "AssemblyAI transcription failed";
      throw new Error(message);
    }
    try {
      await delay(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) throw assemblyTimedOut(timeoutMs);
      throw error;
    }
  }
}

async function transcribeUploadedAudioWithAssemblyAi(
  body: BodyInit,
  apiKey: string,
  {
    fetchImpl,
    baseUrl,
    mediaType,
    pollIntervalMs,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  }: Pick<
    AssemblyAiOptions,
    "fetchImpl" | "baseUrl" | "mediaType" | "pollIntervalMs" | "timeoutMs"
  >,
): Promise<string | null> {
  const uploadUrl = await uploadViaAssemblyAi(body, apiKey, {
    fetchImpl,
    baseUrl,
    mediaType,
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
  });
  const started = await submitAssemblyAiTranscript(uploadUrl, apiKey, {
    fetchImpl,
    baseUrl,
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
  });
  if (started.status.trim().toLowerCase() === "completed") return started.text;
  return await pollAssemblyAiTranscript(started.id, apiKey, {
    fetchImpl,
    baseUrl,
    pollIntervalMs,
    timeoutMs,
    // Upload and submission must not consume the existing processing allowance.
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function transcribeWithAssemblyAi(
  bytes: Uint8Array,
  mediaType: string,
  apiKey: string,
  options: AssemblyAiOptions = {},
): Promise<string | null> {
  try {
    return await transcribeUploadedAudioWithAssemblyAi(
      new Blob([toArrayBuffer(bytes)], { type: mediaType }),
      apiKey,
      {
        mediaType,
        ...options,
      },
    );
  } catch (error) {
    throw wrapError("AssemblyAI transcription failed", error);
  }
}

export async function transcribeFileWithAssemblyAi({
  filePath,
  mediaType,
  apiKey,
  fetchImpl,
  baseUrl,
  pollIntervalMs,
  timeoutMs,
}: {
  filePath: string;
  mediaType: string;
  apiKey: string;
} & Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "pollIntervalMs" | "timeoutMs">): Promise<
  string | null
> {
  try {
    return await transcribeUploadedAudioWithAssemblyAi(
      await openAsBlob(filePath, { type: mediaType }),
      apiKey,
      {
        mediaType,
        fetchImpl,
        baseUrl,
        pollIntervalMs,
        timeoutMs,
      },
    );
  } catch (error) {
    throw wrapError("AssemblyAI transcription failed", error);
  }
}
