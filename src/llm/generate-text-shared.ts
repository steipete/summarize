import type { Context, Message } from "@earendil-works/pi-ai";
import type { Prompt } from "./prompt.js";
import { userTextAndImageMessage } from "./prompt.js";
import type { LlmTokenUsage } from "./types.js";
import { normalizeTokenUsage } from "./usage.js";

export function formatLlmRetryNotice(
  modelId: string,
  notice: { attempt: number; maxRetries: number; delayMs: number; error?: unknown },
): string {
  const message =
    typeof notice.error === "string"
      ? notice.error
      : notice.error instanceof Error
        ? notice.error.message
        : typeof (notice.error as { message?: unknown } | null)?.message === "string"
          ? String((notice.error as { message?: unknown }).message)
          : "";
  const reason = /empty summary/i.test(message)
    ? "empty output"
    : /timed out/i.test(message)
      ? "timeout"
      : "error";
  return `LLM ${reason} for ${modelId}; retry ${notice.attempt}/${notice.maxRetries} in ${notice.delayMs}ms.`;
}

export function promptToContext(prompt: Prompt): Context {
  const attachments = prompt.attachments ?? [];
  if (attachments.some((attachment) => attachment.kind === "document")) {
    throw new Error("Internal error: document prompt cannot be converted to context.");
  }
  if (attachments.length === 0) {
    return {
      systemPrompt: prompt.system,
      messages: [{ role: "user", content: prompt.userText, timestamp: Date.now() }],
    };
  }
  if (attachments.length !== 1 || attachments[0]?.kind !== "image") {
    throw new Error("Internal error: only single image attachments are supported for prompts.");
  }
  const attachment = attachments[0];
  const messages: Message[] = [
    userTextAndImageMessage({
      text: prompt.userText,
      imageBytes: attachment.bytes,
      mimeType: attachment.mediaType,
    }),
  ];
  return { systemPrompt: prompt.system, messages };
}

export function resolveLlmErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const record = error as { message?: unknown; errorMessage?: unknown };
  if (typeof record.message === "string" && record.message) return record.message;
  if (typeof record.errorMessage === "string") return record.errorMessage;
  return typeof record.message === "string" ? record.message : "";
}

function normalizeHttpStatus(value: unknown): number | null {
  const normalized =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(normalized) && normalized >= 100 && normalized <= 599 ? normalized : null;
}

function errorStatusCode(error: unknown, depth = 0): number | null {
  if (!error || depth > 2) return null;
  const record =
    typeof error === "object"
      ? (error as {
          status?: unknown;
          statusCode?: unknown;
          response?: { status?: unknown };
          cause?: unknown;
        })
      : null;
  if (record) {
    for (const value of [record.statusCode, record.status, record.response?.status]) {
      const statusCode = normalizeHttpStatus(value);
      if (statusCode !== null) return statusCode;
    }
  }
  const message = resolveLlmErrorMessage(error);
  const match =
    /\b(?:api|http)\s+(?:request\s+)?error\s*\((\d{3})\)/i.exec(message) ??
    /\bstatus(?: code)?\s*[:=]?\s*(\d{3})\b/i.exec(message) ??
    /\bhttp\s+(\d{3})\b/i.exec(message) ??
    /\brequest (?:failed|error)\b[^:\n]*:\s*(\d{3})\b/i.exec(message) ??
    /^\s*(\d{3})\b/.exec(message);
  if (match?.[1]) return Number(match[1]);
  return !record || record.cause === error ? null : errorStatusCode(record.cause, depth + 1);
}

const retryableErrorCodes = new Set([
  "DEADLINE_EXCEEDED",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "NETWORK_ERROR",
  "OVERLOADED_ERROR",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "SERVER_ERROR",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_SOCKET",
  "UNAVAILABLE",
  "VECTOR_STORE_TIMEOUT",
]);

function hasRetryableErrorCode(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" ? (error as { code?: unknown }).code : null;
  if (typeof code === "string" && retryableErrorCodes.has(code.toUpperCase())) return true;

  const message = resolveLlmErrorMessage(error);
  const patterns = [
    /\b([a-z][a-z0-9_]+)\s*:/gi,
    /\bfinish_reason\s*:\s*([a-z][a-z0-9_]+)/gi,
    /\bgot status\s*:\s*([a-z][a-z0-9_]+)/gi,
    /"(?:code|type)"\s*:\s*"([a-z][a-z0-9_]+)"/gi,
  ];
  return patterns.some((pattern) =>
    [...message.matchAll(pattern)].some((match) =>
      retryableErrorCodes.has(String(match[1]).toUpperCase()),
    ),
  );
}

const retryableErrorMessages = [
  /\btimed out\b/i,
  /\bempty summary\b/i,
  /\bfetch failed\b/i,
  /\bnetwork(?: request)? (?:error|failed|unavailable)\b/i,
  /\bsocket (?:closed|error|hang up)\b/i,
  /\bconnection (?:closed|error|refused|reset|terminated)\b/i,
  /\bpremature close\b/i,
  /\b(?:websocket )?stream (?:closed|ended) before [a-z_.]+\b/i,
  /\bstream ended without finish_reason\b/i,
  /\bstream response was empty\b/i,
  /\bresponse with no body\b/i,
  /\bresponse body is empty\b/i,
  /\bincomplete json segment at the end\b/i,
  /\bunexpected end of json input\b/i,
  /^\s*terminated\s*\.?\s*$/i,
];

function hasRetryableTransportSignal(error: unknown, depth = 0): boolean {
  if (!error || depth > 2) return false;
  const message = resolveLlmErrorMessage(error);
  if (retryableErrorMessages.some((pattern) => pattern.test(message))) return true;
  if (
    error instanceof DOMException &&
    ["AbortError", "NetworkError", "TimeoutError"].includes(error.name)
  ) {
    return true;
  }
  if (hasRetryableErrorCode(error)) return true;
  if (typeof error !== "object") return false;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? false : hasRetryableTransportSignal(cause, depth + 1);
}

export function isRetryableLlmError(error: unknown): boolean {
  if (!error) return false;
  const statusCode = errorStatusCode(error);
  if (statusCode !== null) {
    return (
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      (statusCode >= 500 && statusCode <= 599)
    );
  }
  return hasRetryableTransportSignal(error);
}

export function computeRetryDelayMs(attempt: number): number {
  const base = 500;
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(2000, base * (attempt + 1) + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeoutFallback<T>({
  promise,
  timeoutMs,
  fallback,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  fallback: T;
}): Promise<T> {
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 30_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), effectiveTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function streamUsageWithTimeout({
  result,
  timeoutMs,
}: {
  result: Promise<{ usage?: unknown }>;
  timeoutMs: number;
}): Promise<LlmTokenUsage | null> {
  const normalized = result.then((msg) => normalizeTokenUsage(msg.usage)).catch(() => null);
  return withTimeoutFallback({
    promise: normalized,
    timeoutMs,
    fallback: null,
  });
}

export function isOpenAiGpt5Model(provider: string, model: string): boolean {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
  return (
    (provider === "openai" && /^gpt-5([-.].+)?$/i.test(normalized)) ||
    (provider === "github-copilot" && /^openai\/gpt-5([-.].+)?$/i.test(model))
  );
}

export function resolveEffectiveTemperature({
  provider,
  model,
  temperature,
}: {
  provider: string;
  model: string;
  temperature?: number;
}): number | undefined {
  if (typeof temperature !== "number") return undefined;
  if (isOpenAiGpt5Model(provider, model)) return undefined;
  return temperature;
}

export function shouldRetryGpt5WithoutTokenCap({
  provider,
  model,
  maxOutputTokens,
  error,
}: {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  error: unknown;
}): boolean {
  if (typeof maxOutputTokens !== "number") return false;
  if (!isOpenAiGpt5Model(provider, model)) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /empty summary/i.test(message);
}

export function resolveGoogleEmptyResponseFallbackModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized.startsWith("google/")) return null;
  const raw = normalized.slice("google/".length);
  if (!raw.includes("preview") && !raw.includes("exp")) return null;
  if (raw === "gemini-2.5-flash") return null;
  return "google/gemini-2.5-flash";
}

export function isGoogleEmptySummaryError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /empty summary/i.test(message);
}
