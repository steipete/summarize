import type { Context } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Attachment } from "../attachments.js";
import type { LlmTokenUsage } from "../types.js";
import { normalizeGoogleUsage, normalizeTokenUsage } from "../usage.js";
import { resolveGoogleModel } from "./models.js";
import { bytesToBase64, resolveBaseUrlOverride } from "./shared.js";

type GoogleAssistantLike = {
  stopReason?: string;
  errorMessage?: string;
};

type GoogleContentBlockLike = {
  type: string;
  text?: string;
};

function extractGoogleErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const nested = extractGoogleErrorMessage(parsed);
      if (nested) return nested;
    } catch {}
    return trimmed;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    extractGoogleErrorMessage(record.error) ??
    extractGoogleErrorMessage(record.message) ??
    extractGoogleErrorMessage(record.details)
  );
}

export function normalizeGoogleAssistantError(
  response: GoogleAssistantLike | null | undefined,
  modelId: string,
): Error | null {
  const raw = typeof response?.errorMessage === "string" ? response.errorMessage : "";
  if (!raw.trim() && response?.stopReason !== "error") return null;
  const message = extractGoogleErrorMessage(raw) ?? `Google request failed for model "${modelId}".`;
  if (/not found|not supported|Call ListModels/i.test(message)) {
    return new Error(`Google API rejected model "${modelId}": ${message}`);
  }
  return new Error(`Google request failed for model "${modelId}": ${message}`);
}

function extractGoogleResponseText(content: GoogleContentBlockLike[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

export async function completeGoogleText({
  modelId,
  apiKey,
  context,
  temperature,
  maxOutputTokens,
  signal,
  googleBaseUrlOverride,
}: {
  modelId: string;
  apiKey: string;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  googleBaseUrlOverride?: string | null;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const model = resolveGoogleModel({ modelId, context, googleBaseUrlOverride });
  const result = await completeSimple(model, context, {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
    apiKey,
    signal,
  });
  const normalizedError = normalizeGoogleAssistantError(result, modelId);
  if (normalizedError) throw normalizedError;
  const text = extractGoogleResponseText(result.content as GoogleContentBlockLike[]);
  if (!text) throw new Error(`LLM returned an empty summary (model google/${modelId}).`);
  return { text, usage: normalizeTokenUsage(result.usage) };
}

export async function completeGoogleDocument({
  modelId,
  apiKey,
  promptText,
  document,
  maxOutputTokens,
  temperature,
  timeoutMs,
  fetchImpl,
  googleBaseUrlOverride,
}: {
  modelId: string;
  apiKey: string;
  promptText: string;
  document: Attachment;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  googleBaseUrlOverride?: string | null;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  if (document.kind !== "document") {
    throw new Error("Internal error: expected a document attachment for Google.");
  }
  const baseUrl =
    resolveBaseUrlOverride(googleBaseUrlOverride) ??
    "https://generativelanguage.googleapis.com/v1beta";
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models/${modelId}:generateContent`);
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const generationConfig: Record<string, unknown> = {};
  if (typeof maxOutputTokens === "number") generationConfig.maxOutputTokens = maxOutputTokens;
  if (typeof temperature === "number") generationConfig.temperature = temperature;
  const payload: Record<string, unknown> = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: document.mediaType,
              data: bytesToBase64(document.bytes),
            },
          },
          { text: promptText },
        ],
      },
    ],
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const detail = extractGoogleErrorMessage(bodyText);
      const hint = detail ? `: ${detail}` : "";
      const error = new Error(`Google API error (${response.status})${hint}.`);
      (error as { statusCode?: number }).statusCode = response.status;
      (error as { responseBody?: string }).responseBody = bodyText;
      throw error;
    }

    const data = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const text = (data.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) {
      throw new Error(`LLM returned an empty summary (model google/${modelId}).`);
    }
    return { text, usage: normalizeGoogleUsage(data.usageMetadata) };
  } finally {
    clearTimeout(timeout);
  }
}
