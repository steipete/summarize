import type { Attachment } from "../../attachments.js";
import { createUnsupportedFunctionalityError } from "../../errors.js";
import type { LlmTokenUsage } from "../../types.js";
import { normalizeOpenAiUsage } from "../../usage.js";
import { bytesToBase64 } from "../shared.js";
import type { OpenAiClientConfig } from "../types.js";
import { buildOpenAiResponsesRequestOptions } from "./request-options.js";
import { createOpenAiSseError, createOpenAiTextStream } from "./sse.js";
import {
  contextToResponsesInput,
  postOpenAiJson,
  readOpenAiCompletion,
  resolveOpenAiResponsesUrl,
} from "./transport.js";
import type {
  OpenAiStructuredOutput,
  OpenAiTextCompletionResult,
  OpenAiTextRequest,
  OpenAiTextStreamResult,
} from "./types.js";

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

function extractOpenAiResponsesStreamUsage(payload: Record<string, unknown>): LlmTokenUsage | null {
  const response = payload.response;
  const usage =
    response && typeof response === "object"
      ? (response as Record<string, unknown>).usage
      : payload.usage;
  return normalizeOpenAiUsage(usage);
}

type ResponsesTextRequest = OpenAiTextRequest & { structuredOutput?: OpenAiStructuredOutput };

function requestResponsesText(request: ResponsesTextRequest, stream = false) {
  const { modelId, context, openaiConfig, maxOutputTokens, temperature, structuredOutput } =
    request;
  const url = resolveOpenAiResponsesUrl(openaiConfig.baseURL ?? "https://api.openai.com/v1");
  return postOpenAiJson(request, url, {
    model: modelId,
    input: contextToResponsesInput(context),
    ...(context.systemPrompt?.trim() ? { instructions: context.systemPrompt.trim() } : {}),
    ...buildOpenAiResponsesRequestOptions(
      openaiConfig.requestOptions,
      stream ? undefined : structuredOutput,
    ),
    ...(stream ? { stream: true } : {}),
    ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
  });
}

export async function completeOpenAiResponsesText(
  request: ResponsesTextRequest,
): Promise<OpenAiTextCompletionResult> {
  const { modelId } = request;
  const response = await requestResponsesText(request);
  const result = await readOpenAiCompletion(response, modelId, extractOpenAiResponseText);
  return { ...result, resolvedModelId: modelId };
}

export async function streamOpenAiResponsesText(
  request: OpenAiTextRequest,
): Promise<OpenAiTextStreamResult> {
  const { modelId } = request;
  const response = await requestResponsesText(request, true);
  return createOpenAiTextStream(response, modelId, (event) => {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return { text: event.delta };
    }
    if (event.type === "response.completed") {
      return { usage: extractOpenAiResponsesStreamUsage(event) };
    }
    if (event.type === "response.failed" || event.type === "error")
      throw createOpenAiSseError(event);
    return null;
  });
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
    const response = await postOpenAiJson(
      { openaiConfig, fetchImpl, signal: controller.signal },
      url,
      payload,
      { "content-type": "application/json", authorization: `Bearer ${openaiConfig.apiKey}` },
    );
    return await readOpenAiCompletion(response, modelId, extractOpenAiResponseText);
  } finally {
    clearTimeout(timeout);
  }
}
