import type { Context } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { isOpenRouterBaseUrl, normalizeBaseUrl } from "@steipete/summarize-core";
import type { Attachment } from "../attachments.js";
import type { LlmTokenUsage } from "../types.js";
import type { OpenAiClientConfig } from "./types.js";
import { createUnsupportedFunctionalityError } from "../errors.js";
import { normalizeOpenAiUsage, normalizeTokenUsage } from "../usage.js";
import { resolveOpenAiModel } from "./models.js";
import { bytesToBase64 } from "./shared.js";

export type OpenAiClientConfigInput = {
  apiKeys: {
    openaiApiKey: string | null;
    openrouterApiKey: string | null;
  };
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
};

export function resolveOpenAiClientConfig({
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
}: OpenAiClientConfigInput): OpenAiClientConfig {
  const baseUrlRaw =
    openaiBaseUrlOverride ??
    (typeof process !== "undefined" ? process.env.OPENAI_BASE_URL : undefined);
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const isOpenRouterViaBaseUrl = baseUrl ? isOpenRouterBaseUrl(baseUrl) : false;
  const hasOpenRouterKey = apiKeys.openrouterApiKey != null;
  const hasOpenAiKey = apiKeys.openaiApiKey != null;
  const isOpenRouter =
    Boolean(forceOpenRouter) ||
    isOpenRouterViaBaseUrl ||
    (hasOpenRouterKey && !baseUrl && !hasOpenAiKey);

  const apiKey = isOpenRouter
    ? (apiKeys.openrouterApiKey ?? apiKeys.openaiApiKey)
    : apiKeys.openaiApiKey;
  if (!apiKey) {
    throw new Error(
      isOpenRouter
        ? "Missing OPENROUTER_API_KEY (or OPENAI_API_KEY) for OpenRouter"
        : "Missing OPENAI_API_KEY for openai/... model",
    );
  }

  const baseURL = forceOpenRouter
    ? "https://openrouter.ai/api/v1"
    : (baseUrl ?? (isOpenRouter ? "https://openrouter.ai/api/v1" : undefined));

  const isCustomBaseURL = (() => {
    if (!baseURL) return false;
    try {
      const url = new URL(baseURL);
      return url.host !== "api.openai.com" && url.host !== "openrouter.ai";
    } catch {
      return false;
    }
  })();

  const useChatCompletions = Boolean(forceChatCompletions) || isOpenRouter || isCustomBaseURL;
  return {
    apiKey,
    baseURL: baseURL ?? undefined,
    useChatCompletions,
    isOpenRouter,
  };
}

function resolveOpenAiResponsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, "");
  if (/\/responses$/.test(path)) {
    url.pathname = path;
    return url;
  }
  if (/\/v1$/.test(path)) {
    url.pathname = `${path}/responses`;
    return url;
  }
  url.pathname = `${path}/v1/responses`;
  return url;
}

function extractOpenAiResponseText(payload: {
  output_text?: unknown;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}): string {
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const output = Array.isArray(payload.output) ? payload.output : [];
  const text = output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  return text;
}

function extractPiAiErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const value = (result as { errorMessage?: unknown }).errorMessage;
  if (typeof value !== "string") return null;
  const message = value.trim();
  return message.length > 0 ? message : null;
}

export async function completeOpenAiText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const model = resolveOpenAiModel({ modelId, context, openaiConfig });
  const result = await completeSimple(model, context, {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
    apiKey: openaiConfig.apiKey,
    signal,
  });
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!text) {
    const providerError = extractPiAiErrorMessage(result);
    if (providerError) throw new Error(`${providerError} (model openai/${modelId}).`);
    throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
  }
  return { text, usage: normalizeTokenUsage(result.usage) };
}

export async function completeOpenAiDocument({
  modelId,
  openaiConfig,
  promptText,
  document,
  maxOutputTokens,
  temperature,
  timeoutMs,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  promptText: string;
  document: Attachment;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  if (document.kind !== "document") {
    throw new Error("Internal error: expected a document attachment for OpenAI.");
  }
  if (openaiConfig.isOpenRouter) {
    throw createUnsupportedFunctionalityError(
      "OpenRouter does not support PDF attachments for openai/... models",
    );
  }
  const baseUrl = openaiConfig.baseURL ?? "https://api.openai.com/v1";
  const host = new URL(baseUrl).host;
  if (host !== "api.openai.com") {
    throw createUnsupportedFunctionalityError(
      `Document attachments require api.openai.com; got ${host}`,
    );
  }

  const url = resolveOpenAiResponsesUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const filename = document.filename?.trim() || "document.pdf";
  const payload = {
    model: modelId,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename,
            file_data: `data:${document.mediaType};base64,${bytesToBase64(document.bytes)}`,
          },
          { type: "input_text", text: promptText },
        ],
      },
    ],
    ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiConfig.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenAI API error (${response.status}).`);
      (error as { statusCode?: number }).statusCode = response.status;
      (error as { responseBody?: string }).responseBody = bodyText;
      throw error;
    }

    const data = JSON.parse(bodyText) as {
      output_text?: unknown;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: unknown;
    };
    const text = extractOpenAiResponseText(data);
    if (!text) {
      throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
    }
    return { text, usage: normalizeOpenAiUsage(data.usage) };
  } finally {
    clearTimeout(timeout);
  }
}
