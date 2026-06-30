import type { Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
export {
  resolveOpenAiClientConfig,
  type OpenAiClientConfigInput,
} from "../openai-client-config.js";
import { normalizeTokenUsage } from "../usage.js";
import { resolveOpenAiModel } from "./models.js";
import { completeOpenAiChatText, streamOpenAiChatText } from "./openai/chat-completions.js";
import { completeGitHubModelsText } from "./openai/github-models.js";
import { isOpenAiResponsesTextModelId } from "./openai/request-options.js";
import { completeOpenAiResponsesText, streamOpenAiResponsesText } from "./openai/responses.js";
import { isApiOpenAiBaseUrl, isGitHubModelsBaseUrl } from "./openai/transport.js";
import type {
  OpenAiStructuredOutput,
  OpenAiTextCompletionResult,
  OpenAiTextStreamResult,
} from "./openai/types.js";
import { throwIfAssistantMessageFailed } from "./shared.js";
import type { OpenAiClientConfig } from "./types.js";

export { completeOpenAiDocument } from "./openai/responses.js";
export type { OpenAiStructuredOutput } from "./openai/types.js";

export async function completeOpenAiText({
  modelId,
  openaiConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
  fetchImpl = globalThis.fetch.bind(globalThis),
  structuredOutput,
}: {
  modelId: string;
  openaiConfig: OpenAiClientConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  structuredOutput?: OpenAiStructuredOutput;
}): Promise<OpenAiTextCompletionResult> {
  if (structuredOutput) {
    if (openaiConfig.isOpenRouter || isGitHubModelsBaseUrl(openaiConfig.baseURL)) {
      throw new Error(
        "Structured OpenAI Responses output requires an OpenAI-compatible Responses endpoint.",
      );
    }
    return completeOpenAiResponsesText({
      modelId,
      openaiConfig,
      context,
      temperature,
      maxOutputTokens,
      signal,
      fetchImpl,
      structuredOutput,
    });
  }
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
  throwIfAssistantMessageFailed(result, `openai/${modelId}`);
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
