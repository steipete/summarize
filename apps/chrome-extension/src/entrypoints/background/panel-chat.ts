import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { readAgentResponse } from "../../lib/agent-response";
import { buildChatPageContent } from "../../lib/chat-context";
import {
  buildDirectAgentSystemPrompt,
  normalizeDirectMessages,
  resolveDirectTools,
} from "../../lib/direct-prompts";
import { streamDirectModel } from "../../lib/direct-provider";
import { resolveCapabilityExecution, resolveCapabilityModel } from "../../lib/model-routing";
import { getProviderSettings, type Settings } from "../../lib/settings";
import type { CachedExtract } from "./extract-cache";

type BackgroundChatSession = {
  agentController: AbortController | null;
};

type SendFn = (
  msg:
    | { type: "run:error"; message: string }
    | { type: "agent:chunk"; requestId: string; text: string }
    | {
        type: "agent:response";
        requestId: string;
        ok: boolean;
        assistant?: AssistantMessage;
        error?: string;
      }
    | {
        type: "chat:history";
        requestId: string;
        ok: boolean;
        messages?: Message[];
        error?: string;
      },
) => void;

function buildChatRequestContext({
  cachedExtract,
  settings,
  summaryText,
  slidesText,
}: {
  cachedExtract: CachedExtract;
  settings: Settings;
  summaryText: string;
  slidesText?: { count: number; text: string } | null;
}) {
  return {
    pageContent: buildChatPageContent({
      transcript: cachedExtract.transcriptTimedText ?? cachedExtract.text,
      summary: summaryText,
      summaryCap: settings.maxChars,
      ...(slidesText ? { slides: slidesText } : {}),
      metadata: {
        url: cachedExtract.url,
        title: cachedExtract.title,
        source: cachedExtract.source,
        extractionStrategy:
          cachedExtract.source === "page"
            ? "readability (content script)"
            : (cachedExtract.diagnostics?.strategy ?? null),
        markdownProvider: cachedExtract.diagnostics?.markdown?.used
          ? (cachedExtract.diagnostics?.markdown?.provider ?? "unknown")
          : null,
        firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
        transcriptSource: cachedExtract.transcriptSource,
        transcriptionProvider: cachedExtract.transcriptionProvider,
        transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
        attemptedTranscriptProviders:
          cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
        mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
        totalCharacters: cachedExtract.totalCharacters,
        wordCount: cachedExtract.wordCount,
        transcriptCharacters: cachedExtract.transcriptCharacters,
        transcriptWordCount: cachedExtract.transcriptWordCount,
        transcriptLines: cachedExtract.transcriptLines,
        transcriptHasTimestamps: Boolean(cachedExtract.transcriptTimedText),
        truncated: cachedExtract.truncated,
      },
    }),
    cacheContent: cachedExtract.transcriptTimedText ?? cachedExtract.text,
  };
}

export async function handlePanelAgentRequest({
  session,
  requestId,
  messages,
  tools,
  summary,
  settings,
  cachedExtract,
  slidesText,
  send,
  sendStatus,
  fetchImpl,
  friendlyFetchError,
}: {
  session: BackgroundChatSession;
  requestId: string;
  messages: Message[];
  tools: string[];
  summary?: string | null;
  settings: Settings;
  cachedExtract: CachedExtract;
  slidesText?: { count: number; text: string } | null;
  send: SendFn;
  sendStatus: (status: string) => void;
  fetchImpl: typeof fetch;
  friendlyFetchError: (error: unknown, fallback: string) => string;
}) {
  session.agentController?.abort();
  const agentController = new AbortController();
  session.agentController = agentController;
  const isStillActive = () =>
    session.agentController === agentController && !agentController.signal.aborted;

  const summaryText = typeof summary === "string" ? summary.trim() : "";
  const { pageContent, cacheContent } = buildChatRequestContext({
    cachedExtract,
    settings,
    summaryText,
    slidesText,
  });

  sendStatus("Sending to AI…");
  const capabilityExecution = resolveCapabilityExecution(settings);
  const capabilityModel = resolveCapabilityModel(settings.model);

  try {
    if (capabilityExecution === "direct") {
      let sawAssistant = false;
      for await (const event of streamDirectModel({
        model: capabilityModel,
        providerSettings: getProviderSettings(settings),
        system: buildDirectAgentSystemPrompt({
          pageUrl: cachedExtract.url,
          pageTitle: cachedExtract.title,
          pageContent,
          automationEnabled: settings.automationEnabled,
        }),
        messages: normalizeDirectMessages(messages),
        tools: resolveDirectTools(settings.automationEnabled, tools),
        maxTokens: 4096,
        signal: agentController.signal,
        fetchImpl,
      })) {
        if (!isStillActive()) return;
        if (event.type === "text") {
          send({ type: "agent:chunk", requestId, text: event.text });
        } else {
          sawAssistant = true;
          send({
            type: "agent:response",
            requestId,
            ok: true,
            assistant: event.assistant,
          });
        }
      }
      if (!sawAssistant) throw new Error("Provider stream ended without a response.");
      sendStatus("");
      return;
    }

    const res = await fetchImpl("http://127.0.0.1:8787/v1/agent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        url: cachedExtract.url,
        title: cachedExtract.title,
        pageContent,
        cacheContent,
        messages,
        model: capabilityModel,
        length: settings.length,
        language: settings.language,
        tools,
        automationEnabled: settings.automationEnabled,
      }),
      signal: agentController.signal,
    });
    if (!res.ok) {
      const rawText = await res.text().catch(() => "");
      const isMissingAgent = res.status === 404 || rawText.trim().toLowerCase() === "not found";
      const error = isMissingAgent
        ? "Daemon does not support /v1/agent. Restart the daemon after updating (summarize daemon restart)."
        : rawText.trim() || `${res.status} ${res.statusText}`;
      throw new Error(error);
    }

    let sawAssistant = false;
    for await (const event of readAgentResponse(res)) {
      if (!isStillActive()) return;
      if (event.type === "chunk") {
        send({ type: "agent:chunk", requestId, text: event.text });
      } else if (event.type === "assistant") {
        sawAssistant = true;
        send({ type: "agent:response", requestId, ok: true, assistant: event.assistant });
      }
    }

    if (!sawAssistant) {
      throw new Error("Agent stream ended without a response.");
    }

    sendStatus("");
  } catch (err) {
    if (agentController.signal.aborted) return;
    const message = friendlyFetchError(
      err,
      capabilityExecution === "direct"
        ? "Direct chat request failed"
        : "Daemon chat request failed",
    );
    send({ type: "agent:response", requestId, ok: false, error: message });
    sendStatus(`Error: ${message}`);
  } finally {
    if (session.agentController === agentController) {
      session.agentController = null;
    }
  }
}

export async function handlePanelChatHistoryRequest({
  requestId,
  summary,
  settings,
  cachedExtract,
  send,
  fetchImpl,
  friendlyFetchError,
}: {
  requestId: string;
  summary?: string | null;
  settings: Settings;
  cachedExtract: CachedExtract;
  send: SendFn;
  fetchImpl: typeof fetch;
  friendlyFetchError: (error: unknown, fallback: string) => string;
}) {
  const capabilityExecution = resolveCapabilityExecution(settings);
  if (capabilityExecution === "direct") {
    send({ type: "chat:history", requestId, ok: true, messages: undefined });
    return;
  }
  const summaryText = typeof summary === "string" ? summary.trim() : "";
  const { pageContent, cacheContent } = buildChatRequestContext({
    cachedExtract,
    settings,
    summaryText,
  });

  try {
    const res = await fetchImpl("http://127.0.0.1:8787/v1/agent/history", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: cachedExtract.url,
        title: cachedExtract.title,
        pageContent,
        cacheContent,
        model: resolveCapabilityModel(settings.model),
        length: settings.length,
        language: settings.language,
        automationEnabled: settings.automationEnabled,
      }),
    });
    const rawText = await res.text();
    let json: { ok?: boolean; messages?: Message[]; error?: string } | null = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText) as typeof json;
      } catch {
        json = null;
      }
    }
    if (!res.ok || !json?.ok) {
      const error = json?.error ?? (rawText.trim() || `${res.status} ${res.statusText}`);
      throw new Error(error);
    }
    send({
      type: "chat:history",
      requestId,
      ok: true,
      messages: Array.isArray(json?.messages) ? json.messages : undefined,
    });
  } catch (err) {
    const message = friendlyFetchError(err, "Chat history request failed");
    send({ type: "chat:history", requestId, ok: false, error: message });
  }
}
