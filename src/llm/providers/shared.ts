import type { Api, AssistantMessage, Context, KnownProvider, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

export function resolveBaseUrlOverride(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function extractText(message: AssistantMessage): string {
  const text = message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return text.trim();
}

export function throwIfAssistantMessageFailed(message: AssistantMessage, modelId: string): void {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
  const detail = message.errorMessage?.trim();
  if (message.stopReason === "aborted") {
    throw new DOMException(detail || `LLM request aborted (model ${modelId}).`, "AbortError");
  }
  throw new Error(detail || `LLM request failed (model ${modelId}).`);
}

export function wantsImages(context: Context): boolean {
  for (const msg of context.messages) {
    if (msg.role === "user" || msg.role === "toolResult") {
      if (Array.isArray(msg.content) && msg.content.some((c) => c.type === "image")) return true;
    }
  }
  return false;
}

export function tryGetModel(provider: KnownProvider, modelId: string): Model<Api> | null {
  try {
    return getModel(provider, modelId as never) as unknown as Model<Api>;
  } catch {
    return null;
  }
}

export function createSyntheticModel({
  provider,
  modelId,
  api,
  baseUrl,
  allowImages,
  headers,
}: {
  provider: KnownProvider;
  modelId: string;
  api: Model<Api>["api"];
  baseUrl: string;
  allowImages: boolean;
  headers?: Record<string, string>;
}): Model<Api> {
  return {
    id: modelId,
    name: `${provider}/${modelId}`,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: allowImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(headers ? { headers } : {}),
  };
}
