import type { Context } from "@earendil-works/pi-ai";
import { normalizeOpenAiUsage } from "../../usage.js";
import type { OpenAiClientConfig } from "../types.js";
import type { OpenAiTextCompletionResult, OpenAiTextRequest } from "./types.js";

export async function postOpenAiJson(
  {
    openaiConfig,
    fetchImpl,
    signal,
  }: Pick<OpenAiTextRequest, "openaiConfig" | "fetchImpl" | "signal">,
  url: URL,
  payload: Record<string, unknown>,
  headers = buildOpenAiRequestHeaders(openaiConfig),
): Promise<Response> {
  const requestUrl = String(url);
  const response = await fetchImpl(requestUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw createOpenAiHttpError({
      baseUrl: requestUrl,
      status: response.status,
      bodyText: await response.text(),
    });
  }
  return response;
}

export async function readOpenAiCompletion<Payload>(
  response: Response,
  modelId: string,
  extractText: (payload: Payload) => string,
): Promise<OpenAiTextCompletionResult> {
  const payload = JSON.parse(await response.text()) as Payload & { usage?: unknown };
  const text = extractText(payload);
  if (!text) throw new Error(`LLM returned an empty summary (model openai/${modelId}).`);
  return { text, usage: normalizeOpenAiUsage(payload.usage) };
}

export function isGitHubModelsBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host === "models.github.ai";
  } catch {
    return false;
  }
}

export function isApiOpenAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).host === "api.openai.com";
  } catch {
    return false;
  }
}

export function resolveOpenAiResponsesUrl(baseUrl: string): URL {
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

export function resolveOpenAiChatCompletionsUrl(baseUrl: string): URL {
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

export function contextToChatCompletionMessages(
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

export function contextToResponsesInput(context: Context): Array<{
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

export function buildOpenAiRequestHeaders(
  openaiConfig: OpenAiClientConfig,
): Record<string, string> {
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

export function createOpenAiHttpError({
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
