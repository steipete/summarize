import type { Context, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Attachment } from "../attachments.js";
import type { OpenAiReasoningEffort } from "../model-options.js";
import type { LlmTokenUsage } from "../types.js";
import { normalizeAnthropicUsage, normalizeTokenUsage } from "../usage.js";
import { resolveAnthropicModel } from "./models.js";
import {
  bytesToBase64,
  extractText,
  resolveBaseUrlOverride,
  throwIfAssistantMessageFailed,
} from "./shared.js";

function effortToThinkingLevel(
  effort: OpenAiReasoningEffort | undefined,
): ThinkingLevel | undefined {
  if (!effort || effort === "none") return undefined;
  return effort;
}

/**
 * Decide the model and `reasoning` option to pass into the pi-ai Anthropic
 * adapter. Shared by non-streaming and streaming text dispatch.
 *
 * pi-ai enables extended thinking whenever the caller passes a `reasoning`
 * option (provided `model.reasoning` is true). So:
 *
 * - Registered models with `reasoning: true` (Claude 4+): forward `reasoning`.
 *   Registered Claude 4.x models also carry `compat.forceAdaptiveThinking`, so
 *   pi-ai emits the adaptive thinking form their backends expect.
 * - Registered models with `reasoning: false` (Claude 3 / 3.5): drop
 *   `reasoning` entirely; forwarding it would have pi-ai send a `thinking`
 *   block to an API that rejects it.
 * - Synthetic custom-gateway models (registry miss plus explicit
 *   `ANTHROPIC_BASE_URL` in front of newer Claude versions):
 *   `createSyntheticModel` hard-codes `reasoning: false` and sets no `compat`,
 *   so we flip a copy to `reasoning: true` AND set
 *   `compat.forceAdaptiveThinking`. Without the latter, pi-ai sends
 *   `thinking: { type: "enabled", budget_tokens }`, which Anthropic-on-Bedrock
 *   gateways reject (they require `thinking: { type: "adaptive" }` +
 *   `output_config.effort`). Setting it makes the synthetic model emit the same
 *   adaptive form that registered Claude 4.x models already do.
 */
export function prepareAnthropicReasoning({
  baseModel,
  isSyntheticCustomGateway,
  reasoningEffort,
}: {
  baseModel: Model<Api>;
  isSyntheticCustomGateway: boolean;
  reasoningEffort?: OpenAiReasoningEffort;
}): { model: Model<Api>; reasoning?: ThinkingLevel } {
  const reasoning = effortToThinkingLevel(reasoningEffort);
  if (!reasoning) return { model: baseModel };
  if (!baseModel.reasoning) {
    if (isSyntheticCustomGateway) {
      return {
        model: {
          ...baseModel,
          reasoning: true,
          compat: { ...baseModel.compat, forceAdaptiveThinking: true },
        },
        reasoning,
      };
    }
    // Registered but flagged unsupported (e.g. Claude 3/3.5): drop reasoning
    // so pi-ai does not enable thinking on a model the API rejects it for.
    return { model: baseModel };
  }
  return { model: baseModel, reasoning };
}

function parseAnthropicErrorPayload(
  responseBody: string,
): { type: string; message: string } | null {
  try {
    const parsed = JSON.parse(responseBody) as {
      type?: unknown;
      error?: { type?: unknown; message?: unknown };
    };
    if (parsed?.type !== "error") return null;
    const error = parsed.error;
    if (!error || typeof error !== "object") return null;
    const errorType = typeof error.type === "string" ? error.type : null;
    const errorMessage = typeof error.message === "string" ? error.message : null;
    if (!errorType || !errorMessage) return null;
    return { type: errorType, message: errorMessage };
  } catch {
    return null;
  }
}

export function normalizeAnthropicModelAccessError(error: unknown, modelId: string): Error | null {
  if (!error || typeof error !== "object") return null;
  const maybe = error as Record<string, unknown>;
  const statusCode = typeof maybe.statusCode === "number" ? maybe.statusCode : null;
  const responseBody = typeof maybe.responseBody === "string" ? maybe.responseBody : null;
  const payload = responseBody ? parseAnthropicErrorPayload(responseBody) : null;
  const payloadType = payload?.type ?? null;
  const payloadMessage = payload?.message ?? null;
  const message = typeof maybe.message === "string" ? maybe.message : "";
  const combinedMessage = (payloadMessage ?? message).trim();

  const hasModelMessage = /^model:\s*\S+/i.test(combinedMessage);
  const isAccessStatus = statusCode === 401 || statusCode === 403 || statusCode === 404;
  const isAccessType =
    payloadType === "not_found_error" ||
    payloadType === "permission_error" ||
    payloadType === "authentication_error";

  if (!hasModelMessage && !isAccessStatus && !isAccessType) return null;

  const modelLabel = hasModelMessage ? combinedMessage.replace(/^model:\s*/i, "").trim() : modelId;
  const hint = `Anthropic API rejected model "${modelLabel}". Your ANTHROPIC_API_KEY likely lacks access to this model or it is unavailable for your account. Try another anthropic/... model or request access.`;
  return new Error(hint, { cause: error instanceof Error ? error : undefined });
}

export async function completeAnthropicText({
  modelId,
  apiKey,
  context,
  temperature,
  maxOutputTokens,
  reasoningEffort,
  signal,
  anthropicBaseUrlOverride,
}: {
  modelId: string;
  apiKey: string;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  signal: AbortSignal;
  anthropicBaseUrlOverride?: string | null;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const { model: baseModel, isSyntheticCustomGateway } = resolveAnthropicModel({
    modelId,
    context,
    anthropicBaseUrlOverride,
  });
  const { model, reasoning } = prepareAnthropicReasoning({
    baseModel,
    isSyntheticCustomGateway,
    reasoningEffort,
  });
  const result = await completeSimple(model, context, {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
    apiKey,
    signal,
  });
  throwIfAssistantMessageFailed(result, `anthropic/${modelId}`);
  const text = extractText(result);
  if (!text) throw new Error(`LLM returned an empty summary (model anthropic/${modelId}).`);
  return { text, usage: normalizeTokenUsage(result.usage) };
}

export async function completeAnthropicDocument({
  modelId,
  apiKey,
  promptText,
  document,
  system,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  anthropicBaseUrlOverride,
}: {
  modelId: string;
  apiKey: string;
  promptText: string;
  document: Attachment;
  system?: string;
  maxOutputTokens?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  anthropicBaseUrlOverride?: string | null;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  if (document.kind !== "document") {
    throw new Error("Internal error: expected a document attachment for Anthropic.");
  }
  const baseUrl = resolveBaseUrlOverride(anthropicBaseUrlOverride) ?? "https://api.anthropic.com";
  const url = new URL("/v1/messages", baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const payload = {
    model: modelId,
    max_tokens: maxOutputTokens ?? 4096,
    ...(system ? { system } : {}),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: document.mediaType,
              data: bytesToBase64(document.bytes),
            },
          },
          { type: "text", text: promptText },
        ],
      },
    ],
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error(`Anthropic API error (${response.status}).`);
      (error as { statusCode?: number }).statusCode = response.status;
      (error as { responseBody?: string }).responseBody = bodyText;
      throw error;
    }

    const data = JSON.parse(bodyText) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: unknown;
    };
    const text = Array.isArray(data.content)
      ? data.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
          .trim()
      : "";
    if (!text) {
      throw new Error(`LLM returned an empty summary (model anthropic/${modelId}).`);
    }
    return { text, usage: normalizeAnthropicUsage(data.usage) };
  } finally {
    clearTimeout(timeout);
  }
}
