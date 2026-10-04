import { toOpenAiServiceTierParam, type ModelRequestOptions } from "../../model-options.js";
import { findOpenAiGpt6Entry } from "../../openai-catalog.js";
import type { OpenAiStructuredOutput } from "./types.js";

function stripOpenAiProviderPrefix(modelId: string): string {
  return modelId.trim().replace(/^openai\//i, "");
}

export function isOpenAiGpt6ModelId(modelId: string): boolean {
  return findOpenAiGpt6Entry(stripOpenAiProviderPrefix(modelId)) !== undefined;
}

export function openAiGpt6RequiresReasoning(modelId: string): boolean {
  return findOpenAiGpt6Entry(stripOpenAiProviderPrefix(modelId))?.requiresReasoning ?? false;
}

export function validateOpenAiReasoningEffort(
  provider: string,
  modelId: string,
  options: ModelRequestOptions | undefined,
): void {
  if (provider !== "openai") return;
  const entry = findOpenAiGpt6Entry(stripOpenAiProviderPrefix(modelId));
  if (options?.reasoningEffort === "max" && !entry) {
    throw new Error(
      `--thinking max is supported only for GPT-6 Astra, Sol, Luna, and GPT-6.1 Sol; received ${modelId}.`,
    );
  }
  if (options?.reasoningEffort !== "none" || !entry?.requiresReasoning) return;
  throw new Error(
    `${entry.name} requires reasoning: --thinking none is unsupported. Use low, medium, high, xhigh, or max, or choose GPT-6 Sol/Luna.`,
  );
}

export function isOpenAiResponsesTextModelId(modelId: string): boolean {
  const normalized = stripOpenAiProviderPrefix(modelId).toLowerCase();
  return (
    (normalized.startsWith("gpt-5") && normalized !== "gpt-5-chat") ||
    isOpenAiGpt6ModelId(normalized)
  );
}

export function buildOpenAiResponsesRequestOptions(
  requestOptions: ModelRequestOptions | undefined,
  structuredOutput?: OpenAiStructuredOutput,
): Record<string, unknown> {
  const serviceTier = toOpenAiServiceTierParam(requestOptions?.serviceTier);
  const text = {
    ...(requestOptions?.textVerbosity ? { verbosity: requestOptions.textVerbosity } : {}),
    ...(structuredOutput
      ? {
          format: {
            type: "json_schema",
            name: structuredOutput.name,
            strict: true,
            schema: structuredOutput.schema,
          },
        }
      : {}),
  };
  return {
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(requestOptions?.reasoningEffort
      ? { reasoning: { effort: requestOptions.reasoningEffort } }
      : {}),
    ...(Object.keys(text).length > 0 ? { text } : {}),
  };
}

export function buildOpenAiChatRequestOptions(
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
