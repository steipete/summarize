import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  buildLanguageKey,
  buildLengthKey,
  buildSummaryCacheKey,
  hashJson,
  normalizeContentForHash,
  type CacheState,
} from "../cache.js";
import { resolveOutputLanguageSetting, resolveSummaryLength } from "../run/run-settings.js";
import { buildAgentPromptHash } from "./agent.js";

export type AgentCacheInput = {
  pageUrl: string;
  cacheContent: string;
  model: string | null;
  length: unknown;
  language: unknown;
  automationEnabled: boolean;
};

type ChatHistoryMessage = Extract<Message, { role: "user" | "assistant" | "toolResult" }>;

export function buildAgentCacheKey({
  pageUrl,
  cacheContent,
  model,
  length,
  language,
  automationEnabled,
}: AgentCacheInput): string {
  const contentHash = hashJson({
    pageUrl: pageUrl.trim(),
    content: normalizeContentForHash(cacheContent),
  });
  const promptHash = buildAgentPromptHash(automationEnabled);
  const { lengthArg } = resolveSummaryLength(length, "xl");
  const outputLanguage = resolveOutputLanguageSetting({
    raw: language,
    fallback: { kind: "auto" },
  });
  const modelKey = typeof model === "string" && model.trim() ? model.trim() : "auto";
  return buildSummaryCacheKey({
    contentHash,
    promptHash,
    model: modelKey,
    lengthKey: buildLengthKey(lengthArg),
    languageKey: buildLanguageKey(outputLanguage),
  });
}

function filterChatHistoryMessages(raw: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const message = item as Message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
      return [];
    }
    return [
      {
        ...message,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : now,
      } as ChatHistoryMessage,
    ];
  });
}

function resolveCacheStore(cacheState: CacheState) {
  return cacheState.mode === "default" ? cacheState.store : null;
}

export function readAgentHistory({
  cacheState,
  cacheInput,
}: {
  cacheState: CacheState;
  cacheInput: AgentCacheInput;
}): Message[] | null {
  const cacheStore = resolveCacheStore(cacheState);
  if (!cacheStore) return null;
  const cached = cacheStore.getJson<unknown>("chat", buildAgentCacheKey(cacheInput));
  if (!cached) return null;
  const rawMessages = Array.isArray(cached)
    ? cached
    : typeof cached === "object" &&
        cached &&
        Array.isArray((cached as { messages?: unknown }).messages)
      ? (cached as { messages: unknown[] }).messages
      : null;
  return rawMessages ? filterChatHistoryMessages(rawMessages) : null;
}

export function writeAgentHistory({
  cacheState,
  cacheInput,
  messages,
  assistant,
}: {
  cacheState: CacheState;
  cacheInput: AgentCacheInput;
  messages: unknown;
  assistant: AssistantMessage;
}): void {
  const cacheStore = resolveCacheStore(cacheState);
  if (!cacheStore) return;
  const history = filterChatHistoryMessages([
    ...(Array.isArray(messages) ? messages : []),
    assistant,
  ]);
  cacheStore.setJson(
    "chat",
    buildAgentCacheKey(cacheInput),
    { messages: history },
    cacheState.ttlMs,
  );
}
