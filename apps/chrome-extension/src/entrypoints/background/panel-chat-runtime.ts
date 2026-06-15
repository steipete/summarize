import { resolveCapabilityExecution } from "../../lib/model-routing";
import type { BgToPanel, PanelCachePayload, PanelToBg } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import { createCachedExtract, type CachedExtract } from "./cached-extract";
import { ensureChatExtract } from "./extract-cache";
import { handlePanelAgentRequest, handlePanelChatHistoryRequest } from "./panel-chat";
import { buildSlidesText } from "./panel-utils";

type PanelAgentRequest = Extract<PanelToBg, { type: "panel:agent" }>;
type PanelChatHistoryRequest = Extract<PanelToBg, { type: "panel:chat-history" }>;
type ChatExtractStore = Parameters<typeof ensureChatExtract>[0]["panelSessionStore"];
type ChatTab = chrome.tabs.Tab & { id: number; url: string };

type PanelChatSessionStore = ChatExtractStore & {
  getPanelCacheAsync(tabId: number, url?: string | null): Promise<PanelCachePayload | null>;
};

type PanelChatSession = {
  windowId: number;
  agentController: AbortController | null;
};

type ChatTarget = { ok: true; settings: Settings; tab: ChatTab } | { ok: false; error: string };

function createPanelCachedExtract({
  cache,
  tab,
  transcript,
}: {
  cache: PanelCachePayload;
  tab: ChatTab;
  transcript: string | null;
}): CachedExtract {
  const text = transcript ?? cache.summaryMarkdown ?? tab.title ?? cache.url ?? tab.url;
  return createCachedExtract({
    extracted: {
      url: cache.url,
      title: cache.title,
      text,
      truncated: false,
      media: {
        hasVideo: true,
        hasAudio: true,
        hasCaptions: Boolean(transcript),
      },
    },
    source: "url",
    title: cache.title,
    transcript:
      transcript === null
        ? null
        : {
            timedText: transcript,
            text: transcript,
            source: transcript ? "browser" : null,
          },
    slides: cache.slides,
  });
}

function mergePanelContext(
  cachedExtract: CachedExtract,
  panelCache: PanelCachePayload | null,
): CachedExtract {
  if (!panelCache?.slides && !panelCache?.transcriptTimedText) return cachedExtract;
  return {
    ...cachedExtract,
    slides: panelCache.slides ?? cachedExtract.slides,
    transcriptTimedText:
      cachedExtract.transcriptTimedText ?? panelCache.transcriptTimedText ?? null,
  };
}

export function createPanelChatRuntime<Session extends PanelChatSession>(options: {
  loadSettings: () => Promise<Settings>;
  getActiveTab: (windowId: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url: string | null | undefined) => boolean;
  panelSessionStore: PanelChatSessionStore;
  send: (session: Session, message: BgToPanel) => void;
  sendStatus: (session: Session, status: string) => void;
  extractFromTab: Parameters<typeof ensureChatExtract>[0]["extractFromTab"];
  fetchImpl: typeof fetch;
  logExtract: (windowId: number) => NonNullable<Parameters<typeof ensureChatExtract>[0]["log"]>;
  friendlyFetchError: Parameters<typeof handlePanelAgentRequest>[0]["friendlyFetchError"];
  ensureChatExtractImpl?: typeof ensureChatExtract;
  handlePanelAgentRequestImpl?: typeof handlePanelAgentRequest;
  handlePanelChatHistoryRequestImpl?: typeof handlePanelChatHistoryRequest;
  buildSlidesTextImpl?: typeof buildSlidesText;
}) {
  const {
    loadSettings,
    getActiveTab,
    canSummarizeUrl,
    panelSessionStore,
    send,
    sendStatus,
    extractFromTab,
    fetchImpl,
    logExtract,
    friendlyFetchError,
    ensureChatExtractImpl = ensureChatExtract,
    handlePanelAgentRequestImpl = handlePanelAgentRequest,
    handlePanelChatHistoryRequestImpl = handlePanelChatHistoryRequest,
    buildSlidesTextImpl = buildSlidesText,
  } = options;

  async function resolveChatTarget(session: Session): Promise<ChatTarget> {
    const settings = await loadSettings();
    if (!settings.chatEnabled) {
      return { ok: false, error: "Chat is disabled in settings" };
    }
    const capabilityExecution = resolveCapabilityExecution(settings);
    if (capabilityExecution === "unavailable") {
      return {
        ok: false,
        error: "Chat requires a configured direct provider or the daemon.",
      };
    }
    if (capabilityExecution === "daemon" && !settings.token.trim()) {
      return { ok: false, error: "Setup required (missing token)" };
    }

    const tab = await getActiveTab(session.windowId);
    if (!tab?.id || !canSummarizeUrl(tab.url)) {
      return { ok: false, error: "Cannot chat on this page" };
    }
    return { ok: true, settings, tab: tab as ChatTab };
  }

  const extractChatContext = (
    session: Session,
    tab: ChatTab,
    settings: Settings,
    onStatus: (status: string) => void,
  ) =>
    ensureChatExtractImpl({
      session,
      tab,
      settings,
      panelSessionStore,
      sendStatus: onStatus,
      extractFromTab,
      fetchImpl,
      log: logExtract(session.windowId),
    });

  async function handleAgent(session: Session, request: PanelAgentRequest): Promise<void> {
    const target = await resolveChatTarget(session);
    if (!target.ok) {
      send(session, { type: "run:error", message: target.error });
      return;
    }

    const { settings, tab } = target;
    const panelCache = await panelSessionStore.getPanelCacheAsync(tab.id, tab.url);
    const panelTranscript =
      panelCache?.transcriptTimedText ?? panelCache?.slides?.transcriptTimedText ?? null;
    let cachedExtract: CachedExtract;
    try {
      cachedExtract =
        settings.slideRuntime === "browser" && panelCache && (panelTranscript || panelCache.slides)
          ? createPanelCachedExtract({ cache: panelCache, tab, transcript: panelTranscript })
          : await extractChatContext(session, tab, settings, (status) =>
              sendStatus(session, status),
            );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(session, { type: "run:error", message });
      sendStatus(session, `Error: ${message}`);
      return;
    }

    const cachedExtractWithPanelContext = mergePanelContext(cachedExtract, panelCache);
    const slidesText = buildSlidesTextImpl(
      cachedExtractWithPanelContext.slides,
      settings.slidesOcrEnabled,
      settings.length,
    );
    await handlePanelAgentRequestImpl({
      session,
      requestId: request.requestId,
      messages: request.messages,
      tools: request.tools,
      summary: request.summary,
      settings,
      cachedExtract: cachedExtractWithPanelContext,
      slidesText,
      send: (message) => send(session, message),
      sendStatus: (status) => sendStatus(session, status),
      fetchImpl,
      friendlyFetchError,
    });
  }

  async function handleHistory(session: Session, request: PanelChatHistoryRequest): Promise<void> {
    const target = await resolveChatTarget(session);
    if (!target.ok) {
      send(session, {
        type: "chat:history",
        requestId: request.requestId,
        ok: false,
        error: target.error,
      });
      return;
    }

    const { settings, tab } = target;
    let cachedExtract: CachedExtract;
    try {
      cachedExtract = await extractChatContext(session, tab, settings, () => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(session, {
        type: "chat:history",
        requestId: request.requestId,
        ok: false,
        error: message,
      });
      return;
    }

    await handlePanelChatHistoryRequestImpl({
      requestId: request.requestId,
      summary: request.summary,
      settings,
      cachedExtract,
      send: (message) => send(session, message),
      fetchImpl,
      friendlyFetchError,
    });
  }

  return { handleAgent, handleHistory };
}
