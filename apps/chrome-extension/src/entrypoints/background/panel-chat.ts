import type { AgentMessage as Message } from "@steipete/summarize-core/runtime";
import { readAgentResponse } from "../../lib/agent-response";
import { buildChatPageContent } from "../../lib/chat-context";
import { daemonOrigin } from "../../lib/daemon-url";
import {
  buildDirectAgentSystemPrompt,
  normalizeDirectMessages,
  resolveDirectTools,
} from "../../lib/direct-prompts";
import { streamDirectModel } from "../../lib/direct-provider";
import {
  LocalizedError,
  readLocalizedMessage,
  message as uiMessage,
  type LocalizedText,
} from "../../lib/i18n";
import { resolveCapabilityExecution, resolveCapabilityModel } from "../../lib/model-routing";
import type { BgToPanel } from "../../lib/panel-contracts";
import { getProviderSettings, type Settings } from "../../lib/settings";
import type { CachedExtract } from "./extract-cache";

type BackgroundChatSession = {
  agentController: AbortController | null;
};

type SendFn = (
  msg: Extract<
    BgToPanel,
    { type: "run:error" | "agent:chunk" | "agent:response" | "chat:history" }
  >,
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
  daemonFetchImpl = fetchImpl,
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
  sendStatus: (status: LocalizedText) => void;
  fetchImpl: typeof fetch;
  daemonFetchImpl?: typeof fetch;
  friendlyFetchError: typeof import("./daemon-client").friendlyFetchError;
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

  sendStatus(uiMessage("progress.sendingAi"));
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
      if (!sawAssistant) throw new LocalizedError(uiMessage("error.providerStreamEmpty"));
      sendStatus("");
      return;
    }

    const origin = daemonOrigin(settings.daemonPort);

    const res = await daemonFetchImpl(`${origin}/v1/agent`, {
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
      const isMissingAgent =
        res.status === 404 ||
        rawText.trim().toLowerCase() ===
          /* i18n-ignore: Legacy daemon HTTP response body. */ "not found";
      if (isMissingAgent) throw new LocalizedError(uiMessage("error.daemonAgentUnavailable"));
      let body: { localized?: unknown; error?: string } | null = null;
      try {
        body = JSON.parse(rawText);
      } catch {
        /* Non-JSON diagnostics remain opaque. */
      }
      const localized = readLocalizedMessage(body?.localized);
      if (localized) throw new LocalizedError(localized);
      const error = body?.error || rawText.trim() || `${res.status} ${res.statusText}`;
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
      throw new LocalizedError(uiMessage("error.agentStreamEmpty"));
    }

    sendStatus("");
  } catch (err) {
    if (agentController.signal.aborted) return;
    const { message, localized } = friendlyFetchError(
      err,
      capabilityExecution === "direct" ? "directChat" : "daemonChat",
    );
    send({ type: "agent:response", requestId, ok: false, error: message, localized });
    sendStatus(uiMessage("error.message", { error: localized }));
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
  daemonFetchImpl = fetchImpl,
  friendlyFetchError,
}: {
  requestId: string;
  summary?: string | null;
  settings: Settings;
  cachedExtract: CachedExtract;
  send: SendFn;
  fetchImpl: typeof fetch;
  daemonFetchImpl?: typeof fetch;
  friendlyFetchError: typeof import("./daemon-client").friendlyFetchError;
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

  const origin = daemonOrigin(settings.daemonPort);

  try {
    const res = await daemonFetchImpl(`${origin}/v1/agent/history`, {
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
    type HistoryResponse = {
      ok?: boolean;
      messages?: Message[];
      error?: string;
      localized?: unknown;
    };
    let json: HistoryResponse | null = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText) as HistoryResponse;
      } catch {
        json = null;
      }
    }
    if (!res.ok || !json?.ok) {
      const localized = readLocalizedMessage(json?.localized);
      if (localized) throw new LocalizedError(localized);
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
    const { message, localized } = friendlyFetchError(err, "chatHistory");
    send({ type: "chat:history", requestId, ok: false, error: message, localized });
  }
}
