import type { Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { isOpenRouterBaseUrl, normalizeBaseUrl } from "@steipete/summarize-core";
import type { Attachment } from "../attachments.js";
import { createUnsupportedFunctionalityError } from "../errors.js";
import { toOpenAiServiceTierParam, type ModelRequestOptions } from "../model-options.js";
import type { LlmTokenUsage } from "../types.js";
import { normalizeOpenAiUsage, normalizeTokenUsage } from "../usage.js";
import { resolveOpenAiModel } from "./models.js";
import { bytesToBase64 } from "./shared.js";
import type { OpenAiClientConfig } from "./types.js";

export type OpenAiClientConfigInput = {
  apiKeys: {
    openaiApiKey: string | null;
    openrouterApiKey: string | null;
  };
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
};

type OpenAiTextCompletionResult = {
  text: string;
  usage: LlmTokenUsage | null;
  resolvedModelId?: string;
};

type OpenAiTextStreamResult = {
  textStream: AsyncIterable<string>;
  usage: Promise<LlmTokenUsage | null>;
  resolvedModelId?: string;
};

function isGitHubModelsBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host === "models.github.ai";
  } catch {
    return false;
  }
}

function isApiOpenAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).host === "api.openai.com";
  } catch {
    return false;
  }
}

export function resolveOpenAiClientConfig({
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
  requestOptions,
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
    ...(requestOptions ? { requestOptions } : {}),
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

function resolveOpenAiChatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, "");
  if (url.host === "models.github.ai") {
    if (/\/chat\/completions$/.test(path)) {
      url.pathname = path;
      return url;
    }
    url.pathname = `${path}/chat/completions`;
    return url;
  }
  if (/\/chat\/completions$/.test(path)) {
    url.pathname = path;
    return url;
  }
  if (/\/v1$/.test(path)) {
    url.pathname = `${path}/chat/completions`;
    return url;
  }
  url.pathname = `${path}/v1/chat/completions`;
  return url;
}

function stripOpenAiProviderPrefix(modelId: string): string {
  return modelId.trim().replace(/^openai\//i, "");
}

function isOpenAiResponsesTextModelId(modelId: string): boolean {
  const normalized = stripOpenAiProviderPrefix(modelId).toLowerCase();
  return normalized.startsWith("gpt-5") && normalized !== "gpt-5-chat";
}

function buildOpenAiResponsesRequestOptions(
  requestOptions: ModelRequestOptions | undefined,
): Record<string, unknown> {
  if (!requestOptions) return {};
  const serviceTier = toOpenAiServiceTierParam(requestOptions.serviceTier);
  return {
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(requestOptions.reasoningEffort
      ? { reasoning: { effort: requestOptions.reasoningEffort } }
      : {}),
    ...(requestOptions.textVerbosity ? { text: { verbosity: requestOptions.textVerbosity } } : {}),
  };
}

function buildOpenAiChatRequestOptions(
  requestOptions: ModelRequestOptions | undefined,
): Record<string, unknown> {
  if (!requestOptions) return {};
  const serviceTier = toOpenAiServiceTierParam(requestOptions.serviceTier);
  return {
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(requestOptions.reasoningEffort ? { reasoning_effort: requestOptions.reasoningEffort } : {}),
    ...(requestOptions.textVerbosity ? { verbosity: requestOptions.textVerbosity } : {}),
  };
}

function resolveGitHubModelsCompatFallbackModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized.startsWith("openai/gpt-5") || normalized === "openai/gpt-5-chat") {
    return null;
  }
  return "openai/gpt-5-chat";
}

function shouldRetryGitHubModelsCompat(error: unknown): boolean {
  const statusCode =
    typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? Number((error as { statusCode?: unknown }).statusCode)
      : null;
  return statusCode === 400 || statusCode === 404 || statusCode === 500 || statusCode === 502;
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

function extractChatCompletionText(payload: {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const content = choices[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

function extractOpenAiResponsesStreamUsage(payload: Record<string, unknown>): LlmTokenUsage | null {
  const response = payload.response;
  const usage =
    response && typeof response === "object"
      ? (response as Record<string, unknown>).usage
      : payload.usage;
  return normalizeOpenAiUsage(usage);
}

async function* parseOpenAiSseJsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentData = "";

  const flush = (): Record<string, unknown> | null => {
    const data = currentData.trim();
    currentData = "";
    if (!data || data === "[DONE]") return null;
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  };

  const processLine = (line: string): Record<string, unknown> | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    if (line.startsWith("data:")) {
      currentData += `${line.slice("data:".length).trimStart()}\n`;
    }
    return null;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const event = processLine(rawLine.replace(/\r$/, ""));
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const event = processLine(buffer.replace(/\r$/, ""));
    if (event) yield event;
  }
  const event = flush();
  if (event) yield event;
}

function createDeferredUsage() {
  let resolve: (value: LlmTokenUsage | null) => void = () => {};
  const promise = new Promise<LlmTokenUsage | null>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function contextToChatCompletionMessages(
  context: Context,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const systemPrompt = context.systemPrompt?.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const message of context.messages) {
    const content =
      typeof message.content === "string"
        ? message.content.trim()
        : Array.isArray(message.content)
          ? message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")
              .trim()
          : "";
    if (!content) continue;
    messages.push({ role: message.role, content });
  }
  return messages;
}

function contextToResponsesInput(context: Context): Array<{
  role: string;
  content: Array<{ type: "input_text"; text: string }>;
}> {
  return contextToChatCompletionMessages({
    systemPrompt: undefined,
    messages: context.messages,
  }).map((message) => ({
    role: message.role,
    content: [{ type: "input_text", text: message.content }],
  }));
}

function buildOpenAiRequestHeaders(openaiConfig: OpenAiClientConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${openaiConfig.apiKey}`,
    ...(openaiConfig.isOpenRouter
      ? {
          "HTTP-Referer": "https://github.com/steipete/summarize",
          "X-Title": "summarize",
        }
      : {}),
    ...(openaiConfig.extraHeaders ?? {}),
  };
}

function createOpenAiHttpError({
  baseUrl,
  status,
  bodyText,
}: {
  baseUrl: string;
  status: number;
  bodyText: string;
}): Error {
  const message =
    isGitHubModelsBaseUrl(baseUrl) && status === 429
      ? "GitHub Models rate limit exceeded (429). Try again later or use another model/token."
      : `OpenAI API error (${status}).`;
  const error = new Error(message);
  (error as { statusCode?: number }).statusCode = status;
  (error as { responseBody?: string }).responseBody = bodyText;
  return error;
}

async function completeOpenAiChatText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<OpenAiTextCompletionResult> {
  const baseUrl = openaiConfig.baseURL ?? "https://api.openai.com/v1";
  const response = await fetchImpl(String(resolveOpenAiChatCompletionsUrl(baseUrl)), {
    method: "POST",
    headers: buildOpenAiRequestHeaders(openaiConfig),
    body: JSON.stringify({
      model: modelId,
      messages: contextToChatCompletionMessages(context),
      ...buildOpenAiChatRequestOptions(openaiConfig.requestOptions),
      ...(typeof maxOutputTokens === "number" ? { max_tokens: maxOutputTokens } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    }),
    signal,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw createOpenAiHttpError({ baseUrl, status: response.status, bodyText });
  }

  const data = JSON.parse(bodyText) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: unknown;
  };
  const text = extractChatCompletionText(data);
  if (!text) throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
  return { text, usage: normalizeOpenAiUsage(data.usage), resolvedModelId: modelId };
}

async function completeOpenAiResponsesText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<OpenAiTextCompletionResult> {
  const baseUrl = openaiConfig.baseURL ?? "https://api.openai.com/v1";
  const response = await fetchImpl(String(resolveOpenAiResponsesUrl(baseUrl)), {
    method: "POST",
    headers: buildOpenAiRequestHeaders(openaiConfig),
    body: JSON.stringify({
      model: modelId,
      input: contextToResponsesInput(context),
      ...(context.systemPrompt?.trim() ? { instructions: context.systemPrompt.trim() } : {}),
      ...buildOpenAiResponsesRequestOptions(openaiConfig.requestOptions),
      ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    }),
    signal,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw createOpenAiHttpError({ baseUrl, status: response.status, bodyText });
  }

  const data = JSON.parse(bodyText) as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    usage?: unknown;
  };
  const text = extractOpenAiResponseText(data);
  if (!text) throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
  return { text, usage: normalizeOpenAiUsage(data.usage), resolvedModelId: modelId };
}

async function streamOpenAiResponsesText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<OpenAiTextStreamResult> {
  const baseUrl = openaiConfig.baseURL ?? "https://api.openai.com/v1";
  const response = await fetchImpl(String(resolveOpenAiResponsesUrl(baseUrl)), {
    method: "POST",
    headers: buildOpenAiRequestHeaders(openaiConfig),
    body: JSON.stringify({
      model: modelId,
      input: contextToResponsesInput(context),
      ...(context.systemPrompt?.trim() ? { instructions: context.systemPrompt.trim() } : {}),
      ...buildOpenAiResponsesRequestOptions(openaiConfig.requestOptions),
      stream: true,
      ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw createOpenAiHttpError({ baseUrl, status: response.status, bodyText });
  }
  if (!response.body) {
    throw new Error("OpenAI stream response was empty.");
  }

  const usage = createDeferredUsage();
  const textStream = {
    async *[Symbol.asyncIterator]() {
      let finalUsage: LlmTokenUsage | null = null;
      try {
        for await (const event of parseOpenAiSseJsonStream(response.body!)) {
          const type = typeof event.type === "string" ? event.type : "";
          if (type === "response.output_text.delta" && typeof event.delta === "string") {
            yield event.delta;
            continue;
          }
          if (type === "response.completed") {
            finalUsage = extractOpenAiResponsesStreamUsage(event);
            continue;
          }
          if (type === "response.failed" || type === "error") {
            const error = event.error;
            const message =
              error &&
              typeof error === "object" &&
              typeof (error as { message?: unknown }).message === "string"
                ? String((error as { message?: unknown }).message)
                : "OpenAI stream failed.";
            throw new Error(message);
          }
        }
      } finally {
        usage.resolve(finalUsage);
      }
    },
  };

  return { textStream, usage: usage.promise, resolvedModelId: modelId };
}

async function streamOpenAiChatText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<OpenAiTextStreamResult> {
  const baseUrl = openaiConfig.baseURL ?? "https://api.openai.com/v1";
  const response = await fetchImpl(String(resolveOpenAiChatCompletionsUrl(baseUrl)), {
    method: "POST",
    headers: buildOpenAiRequestHeaders(openaiConfig),
    body: JSON.stringify({
      model: modelId,
      messages: contextToChatCompletionMessages(context),
      ...buildOpenAiChatRequestOptions(openaiConfig.requestOptions),
      stream: true,
      stream_options: { include_usage: true },
      ...(typeof maxOutputTokens === "number" ? { max_tokens: maxOutputTokens } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw createOpenAiHttpError({ baseUrl, status: response.status, bodyText });
  }
  if (!response.body) {
    throw new Error("OpenAI stream response was empty.");
  }

  const usage = createDeferredUsage();
  const textStream = {
    async *[Symbol.asyncIterator]() {
      let finalUsage: LlmTokenUsage | null = null;
      try {
        for await (const event of parseOpenAiSseJsonStream(response.body!)) {
          if (event.error) {
            const error = event.error;
            const message =
              error &&
              typeof error === "object" &&
              typeof (error as { message?: unknown }).message === "string"
                ? String((error as { message?: unknown }).message)
                : "OpenAI stream failed.";
            throw new Error(message);
          }
          if (event.usage) finalUsage = normalizeOpenAiUsage(event.usage);
          const choices = Array.isArray(event.choices) ? event.choices : [];
          const delta = choices[0]?.delta;
          const content =
            delta && typeof delta === "object" ? (delta as { content?: unknown }).content : null;
          if (typeof content === "string") yield content;
        }
      } finally {
        usage.resolve(finalUsage);
      }
    },
  };

  return { textStream, usage: usage.promise, resolvedModelId: modelId };
}

async function completeGitHubModelsText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<OpenAiTextCompletionResult> {
  try {
    return await completeOpenAiChatText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  } catch (error) {
    const fallbackModelId = resolveGitHubModelsCompatFallbackModelId(modelId);
    if (!fallbackModelId || !shouldRetryGitHubModelsCompat(error)) {
      throw error;
    }
    return completeOpenAiChatText({
      modelId: fallbackModelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
}

export async function completeOpenAiText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<OpenAiTextCompletionResult> {
  if (isGitHubModelsBaseUrl(openaiConfig.baseURL)) {
    return completeGitHubModelsText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
  if (
    openaiConfig.useChatCompletions &&
    openaiConfig.requestOptions &&
    !openaiConfig.isOpenRouter &&
    isApiOpenAiBaseUrl(openaiConfig.baseURL)
  ) {
    return completeOpenAiChatText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
  if (openaiConfig.isOpenRouter && isOpenAiResponsesTextModelId(modelId)) {
    return completeOpenAiChatText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
  if (
    !openaiConfig.isOpenRouter &&
    isApiOpenAiBaseUrl(openaiConfig.baseURL) &&
    isOpenAiResponsesTextModelId(modelId)
  ) {
    return completeOpenAiResponsesText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
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
  if (!text) throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
  return { text, usage: normalizeTokenUsage(result.usage) };
}

export async function streamOpenAiText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<OpenAiTextStreamResult | null> {
  if (
    openaiConfig.useChatCompletions &&
    openaiConfig.requestOptions &&
    !openaiConfig.isOpenRouter &&
    isApiOpenAiBaseUrl(openaiConfig.baseURL)
  ) {
    return streamOpenAiChatText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
  if (
    !openaiConfig.isOpenRouter &&
    isApiOpenAiBaseUrl(openaiConfig.baseURL) &&
    isOpenAiResponsesTextModelId(modelId)
  ) {
    return streamOpenAiResponsesText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
    });
  }
  return null;
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
    ...buildOpenAiResponsesRequestOptions(openaiConfig.requestOptions),
    ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
  };

  try {
    const response = await fetchImpl(String(url), {
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
      throw createOpenAiHttpError({ baseUrl, status: response.status, bodyText });
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
