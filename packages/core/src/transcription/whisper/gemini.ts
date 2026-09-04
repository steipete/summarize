import { promises as fs } from "node:fs";
import { MAX_ERROR_DETAIL_CHARS, TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { resolveGeminiTranscriptionModel } from "./provider-setup.js";
import {
  ensureWhisperFilenameExtension,
  readErrorDetail,
  toArrayBuffer,
  wrapError,
} from "./utils.js";

type Env = Record<string, string | undefined>;

type GeminiTranscriptionOptions = {
  env?: Env;
  model?: string | null;
};

type GeminiMediaPart =
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { mime_type: string; file_uri: string } };

const GEMINI_INLINE_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const TRANSCRIPTION_PROMPT =
  "Transcribe this audio or video into plain text. Return only the transcript text, preserving the spoken language. No timestamps, speaker labels, summaries, or markdown.";

type GeminiFileResource = {
  name?: string;
  uri?: string;
  state?: string;
  mimeType?: string;
  mime_type?: string;
};

export async function transcribeWithGemini(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | null,
  apiKey: string,
  options?: GeminiTranscriptionOptions,
): Promise<string | null> {
  if (bytes.byteLength <= GEMINI_INLINE_UPLOAD_BYTES) {
    return await generateTranscript({
      media: {
        inline_data: {
          mime_type: mediaType,
          data: Buffer.from(toArrayBuffer(bytes)).toString("base64"),
        },
      },
      apiKey,
      ...options,
    });
  }

  const upload = await uploadGeminiBytes({
    bytes,
    mediaType,
    filename,
    apiKey,
    env: options?.env,
  });
  try {
    const ready = await waitForGeminiFileActive(upload, apiKey, options?.env);
    const fileUri = typeof ready.uri === "string" ? ready.uri.trim() : "";
    if (!fileUri) {
      throw new Error("Gemini Files API did not return a file uri");
    }
    return await generateTranscript({
      media: {
        file_data: {
          mime_type: resolveGeminiMimeType(ready, mediaType),
          file_uri: fileUri,
        },
      },
      apiKey,
      ...options,
    });
  } finally {
    await deleteGeminiFile(upload, apiKey, options?.env).catch(() => {});
  }
}

export async function transcribeFileWithGemini({
  filePath,
  mediaType,
  filename,
  apiKey,
  ...options
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  apiKey: string;
} & GeminiTranscriptionOptions): Promise<string | null> {
  return transcribeWithGemini(await fs.readFile(filePath), mediaType, filename, apiKey, options);
}

async function generateTranscript({
  media,
  apiKey,
  env,
  model,
}: {
  media: GeminiMediaPart;
  apiKey: string;
} & GeminiTranscriptionOptions): Promise<string | null> {
  const response = await geminiJsonRequest({
    path: `v1beta/models/${resolveModelId(model, env)}:generateContent`,
    apiKey,
    env,
    body: {
      generationConfig: { temperature: 0 },
      contents: [
        {
          parts: [{ text: TRANSCRIPTION_PROMPT }, media],
        },
      ],
    },
  });

  return extractGeminiTranscript(response, resolveModelId(model, env));
}

async function uploadGeminiBytes({
  bytes,
  mediaType,
  filename,
  apiKey,
  env,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  apiKey: string;
  env?: Env;
}): Promise<GeminiFileResource> {
  const displayName = ensureWhisperFilenameExtension(filename?.trim() || "media", mediaType);
  const startUrl = new URL(`${resolveGeminiBaseUrl(env)}/upload/v1beta/files`);
  const start = await globalThis.fetch(startUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-upload-command": "start",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-header-content-length": String(bytes.byteLength),
      "x-goog-upload-header-content-type": mediaType,
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!start.ok) {
    const detail = await readErrorDetail(start);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Gemini file upload start failed (${start.status})${suffix}`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url")?.trim() || "";
  if (!uploadUrl) {
    throw new Error("Gemini file upload start response did not include x-goog-upload-url");
  }

  const upload = await globalThis.fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(bytes.byteLength),
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    body: new Blob([toArrayBuffer(bytes)], { type: mediaType }),
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!upload.ok) {
    const detail = await readErrorDetail(upload);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Gemini file upload failed (${upload.status})${suffix}`);
  }
  const payload = (await upload.json()) as { file?: GeminiFileResource };
  if (!payload.file) {
    throw new Error("Gemini file upload returned no file metadata");
  }
  return payload.file;
}

async function waitForGeminiFileActive(
  file: GeminiFileResource,
  apiKey: string,
  env?: Env,
): Promise<GeminiFileResource> {
  const name = typeof file.name === "string" ? file.name.trim() : "";
  if (!name) return file;

  let current = file;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = normalizeFileState(current.state);
    if (!state || state === "ACTIVE") return current;
    if (state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${name}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    current = await getGeminiFile(name, apiKey, env);
  }

  throw new Error(`Gemini file processing timed out for ${name}`);
}

async function getGeminiFile(name: string, apiKey: string, env?: Env): Promise<GeminiFileResource> {
  const response = await geminiJsonRequest({
    path: `v1beta/${name}`,
    apiKey,
    env,
    method: "GET",
  });
  if (response && typeof response === "object" && "file" in response) {
    const payload = response as { file?: GeminiFileResource };
    if (payload.file) return payload.file;
  }
  return response as GeminiFileResource;
}

async function deleteGeminiFile(
  file: GeminiFileResource,
  apiKey: string,
  env?: Env,
): Promise<void> {
  const name = typeof file.name === "string" ? file.name.trim() : "";
  if (!name) return;
  const url = new URL(`${resolveGeminiBaseUrl(env)}/v1beta/${name}`);
  const response = await globalThis.fetch(url, {
    method: "DELETE",
    headers: { "x-goog-api-key": apiKey },
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Gemini file delete failed (${response.status})`);
  }
}

async function geminiJsonRequest({
  path,
  apiKey,
  env,
  method = "POST",
  body,
}: {
  path: string;
  apiKey: string;
  env?: Env;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<unknown> {
  const url = new URL(`${resolveGeminiBaseUrl(env)}/${path.replace(/^\/+/, "")}`);
  const response = await globalThis.fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const suffix = text.trim() ? `: ${truncate(text)}` : "";
    throw new Error(`Gemini request failed (${response.status})${suffix}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw wrapError("Gemini returned invalid JSON", error);
  }
}

function extractGeminiTranscript(payload: unknown, modelId: string): string | null {
  const candidates = Array.isArray((payload as { candidates?: unknown[] })?.candidates)
    ? ((payload as { candidates: unknown[] }).candidates as Array<Record<string, unknown>>)
    : [];

  const text = candidates
    .flatMap((candidate) => {
      const content = candidate.content;
      if (!content || typeof content !== "object") return [];
      const parts = (content as { parts?: unknown[] }).parts;
      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const textValue = (part as { text?: unknown }).text;
      return typeof textValue === "string" ? textValue : "";
    })
    .join("")
    .trim();
  if (text) return text;

  const finishReason = candidates
    .map((candidate) => {
      const value = candidate.finishReason;
      return typeof value === "string" ? value.trim() : "";
    })
    .find(Boolean);
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini transcription stopped with ${finishReason} (model ${modelId})`);
  }
  return null;
}

function resolveGeminiBaseUrl(env?: Env): string {
  const source = env ?? process.env;
  return (
    source.GOOGLE_BASE_URL?.trim() ||
    source.GEMINI_BASE_URL?.trim() ||
    DEFAULT_GEMINI_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveModelId(model: string | null | undefined, env?: Env): string {
  const explicit = model?.trim();
  if (explicit) return explicit;
  return resolveGeminiTranscriptionModel(env);
}

function normalizeFileState(state: string | undefined): string | null {
  const normalized = state?.trim().toUpperCase() || "";
  return normalized.length > 0 ? normalized : null;
}

function resolveGeminiMimeType(file: GeminiFileResource, fallback: string): string {
  const fromFile =
    (typeof file.mimeType === "string" ? file.mimeType : null) ??
    (typeof file.mime_type === "string" ? file.mime_type : null);
  return fromFile?.trim() || fallback;
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_ERROR_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : trimmed;
}
