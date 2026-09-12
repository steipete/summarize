import { normalizeOpenAiUsage } from "../../usage.js";
import { buildOpenAiChatRequestOptions } from "./request-options.js";
import { createOpenAiSseError, createOpenAiTextStream } from "./sse.js";
import {
  contextToChatCompletionMessages,
  postOpenAiJson,
  readOpenAiCompletion,
  resolveOpenAiChatCompletionsUrl,
} from "./transport.js";
import type {
  OpenAiTextCompletionResult,
  OpenAiTextRequest,
  OpenAiTextStreamResult,
} from "./types.js";

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

function requestChatCompletion(request: OpenAiTextRequest, stream = false) {
  const { modelId, context, openaiConfig, maxOutputTokens, temperature } = request;
  const url = resolveOpenAiChatCompletionsUrl(openaiConfig.baseURL ?? "https://api.openai.com/v1");
  return postOpenAiJson(request, url, {
    model: modelId,
    messages: contextToChatCompletionMessages(context),
    ...buildOpenAiChatRequestOptions(openaiConfig.requestOptions),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(typeof maxOutputTokens === "number" ? { max_tokens: maxOutputTokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
  });
}

export async function completeOpenAiChatText(
  request: OpenAiTextRequest,
): Promise<OpenAiTextCompletionResult> {
  const { modelId } = request;
  const response = await requestChatCompletion(request);
  const result = await readOpenAiCompletion(response, modelId, extractChatCompletionText);
  return { ...result, resolvedModelId: modelId };
}

export async function streamOpenAiChatText(
  request: OpenAiTextRequest,
): Promise<OpenAiTextStreamResult> {
  const { modelId } = request;
  const response = await requestChatCompletion(request, true);
  return createOpenAiTextStream(response, modelId, (event) => {
    if (event.error) throw createOpenAiSseError(event);
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const delta = choices[0]?.delta;
    const content =
      delta && typeof delta === "object" ? (delta as { content?: unknown }).content : null;
    return {
      ...(event.usage ? { usage: normalizeOpenAiUsage(event.usage) } : {}),
      ...(typeof content === "string" ? { text: content } : {}),
    };
  });
}
