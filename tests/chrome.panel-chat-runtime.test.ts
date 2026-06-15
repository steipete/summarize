import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CachedExtract,
  ensureChatExtract,
} from "../apps/chrome-extension/src/entrypoints/background/extract-cache.js";
import { createPanelChatRuntime } from "../apps/chrome-extension/src/entrypoints/background/panel-chat-runtime.js";
import type {
  handlePanelAgentRequest,
  handlePanelChatHistoryRequest,
} from "../apps/chrome-extension/src/entrypoints/background/panel-chat.js";
import type { PanelCachePayload } from "../apps/chrome-extension/src/lib/panel-contracts.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const productionCollaborators = vi.hoisted(() => ({
  buildSlidesText: vi.fn(),
  ensureChatExtract: vi.fn(),
  handlePanelAgentRequest: vi.fn(),
  handlePanelChatHistoryRequest: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/background/extract-cache", () => ({
  ensureChatExtract: productionCollaborators.ensureChatExtract,
}));

vi.mock("../apps/chrome-extension/src/entrypoints/background/panel-chat", () => ({
  handlePanelAgentRequest: productionCollaborators.handlePanelAgentRequest,
  handlePanelChatHistoryRequest: productionCollaborators.handlePanelChatHistoryRequest,
}));

vi.mock("../apps/chrome-extension/src/entrypoints/background/panel-utils", () => ({
  buildSlidesText: productionCollaborators.buildSlidesText,
}));

const tab = {
  id: 7,
  url: "https://example.com/video",
  title: "Example video",
} as chrome.tabs.Tab;

const baseExtract: CachedExtract = {
  url: tab.url ?? "",
  title: tab.title ?? null,
  text: "page extract",
  source: "page",
  truncated: false,
  totalCharacters: 12,
  wordCount: 2,
  media: null,
  transcriptSource: null,
  transcriptionProvider: null,
  transcriptCharacters: null,
  transcriptWordCount: null,
  transcriptLines: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  slides: null,
  diagnostics: null,
};

function panelCache(overrides: Partial<PanelCachePayload> = {}): PanelCachePayload {
  return {
    tabId: tab.id ?? 0,
    url: tab.url ?? "",
    title: tab.title ?? null,
    runId: "run-1",
    slidesRunId: null,
    summaryMarkdown: "cached summary",
    summaryFromCache: true,
    slidesSummaryMarkdown: null,
    slidesSummaryComplete: null,
    slidesSummaryModel: null,
    lastMeta: {
      inputSummary: null,
      model: null,
      modelLabel: null,
    },
    slides: null,
    transcriptTimedText: null,
    ...overrides,
  };
}

function createHarness({
  settings = { ...defaultSettings, token: "secret", summaryRuntime: "daemon" as const },
  activeTab = tab,
  cache = null as PanelCachePayload | null,
  extract = baseExtract,
}: {
  settings?: typeof defaultSettings;
  activeTab?: chrome.tabs.Tab | null;
  cache?: PanelCachePayload | null;
  extract?: CachedExtract;
} = {}) {
  const send = vi.fn();
  const sendStatus = vi.fn();
  const ensureChatExtractImpl = vi.fn(async (options: Parameters<typeof ensureChatExtract>[0]) => {
    options.sendStatus("Extracting chat context");
    return extract;
  });
  const handlePanelAgentRequestImpl = vi.fn(
    async (options: Parameters<typeof handlePanelAgentRequest>[0]) => {
      options.send({
        type: "agent:chunk",
        requestId: options.requestId,
        text: "chunk",
      });
      options.sendStatus("Sending to AI");
    },
  );
  const handlePanelChatHistoryRequestImpl = vi.fn(
    async (options: Parameters<typeof handlePanelChatHistoryRequest>[0]) => {
      options.send({
        type: "chat:history",
        requestId: options.requestId,
        ok: true,
        messages: [],
      });
    },
  );
  const buildSlidesTextImpl = vi.fn(() => ({ count: 1, text: "slide context" }));
  const panelSessionStore = {
    getPanelCacheAsync: vi.fn(async () => cache),
    getCachedExtract: vi.fn(() => null),
    setCachedExtract: vi.fn(),
    getLastMediaProbe: vi.fn(() => null),
    rememberMediaProbe: vi.fn(),
  };
  const runtime = createPanelChatRuntime({
    loadSettings: vi.fn(async () => settings),
    getActiveTab: vi.fn(async () => activeTab),
    canSummarizeUrl: (url) => Boolean(url?.startsWith("http")),
    panelSessionStore,
    send,
    sendStatus,
    extractFromTab: vi.fn() as never,
    fetchImpl: vi.fn() as never,
    logExtract: () => vi.fn(),
    friendlyFetchError: (error) => String(error),
    ensureChatExtractImpl,
    handlePanelAgentRequestImpl,
    handlePanelChatHistoryRequestImpl,
    buildSlidesTextImpl,
  });
  const session = { windowId: 3, agentController: null };

  return {
    runtime,
    session,
    send,
    sendStatus,
    ensureChatExtractImpl,
    handlePanelAgentRequestImpl,
    handlePanelChatHistoryRequestImpl,
    buildSlidesTextImpl,
    panelSessionStore,
  };
}

describe("chrome panel chat runtime", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses production collaborators when no test overrides are supplied", async () => {
    const send = vi.fn();
    const session = { windowId: 3, agentController: null };
    const runtime = createPanelChatRuntime({
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "secret",
        chatEnabled: false,
      })),
      getActiveTab: vi.fn(async () => tab),
      canSummarizeUrl: () => true,
      panelSessionStore: {
        getPanelCacheAsync: vi.fn(async () => null),
        getCachedExtract: vi.fn(() => null),
        setCachedExtract: vi.fn(),
        getLastMediaProbe: vi.fn(() => null),
        rememberMediaProbe: vi.fn(),
      },
      send,
      sendStatus: vi.fn(),
      extractFromTab: vi.fn() as never,
      fetchImpl: vi.fn() as never,
      logExtract: () => vi.fn(),
      friendlyFetchError: (error) => String(error),
    });

    await runtime.handleAgent(session, {
      type: "panel:agent",
      requestId: "agent-defaults",
      messages: [],
      tools: [],
    });

    expect(send).toHaveBeenCalledWith(session, {
      type: "run:error",
      message: "Chat is disabled in settings",
    });
  });

  it("reports disabled chat through the agent protocol", async () => {
    const harness = createHarness({
      settings: { ...defaultSettings, token: "secret", chatEnabled: false },
    });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-1",
      messages: [],
      tools: [],
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "run:error",
      message: "Chat is disabled in settings",
    });
    expect(harness.ensureChatExtractImpl).not.toHaveBeenCalled();
  });

  it("reports missing credentials through the history protocol", async () => {
    const harness = createHarness({
      settings: { ...defaultSettings, token: " ", summaryRuntime: "daemon" },
    });

    await harness.runtime.handleHistory(harness.session, {
      type: "panel:chat-history",
      requestId: "history-1",
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "chat:history",
      requestId: "history-1",
      ok: false,
      error: "Setup required (missing token)",
    });
  });

  it("rejects an unsupported active tab before extraction", async () => {
    const harness = createHarness({
      activeTab: { id: 7, url: "chrome://settings" } as chrome.tabs.Tab,
    });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-2",
      messages: [],
      tools: [],
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "run:error",
      message: "Cannot chat on this page",
    });
    expect(harness.panelSessionStore.getPanelCacheAsync).not.toHaveBeenCalled();
  });

  it("uses browser slide cache as the agent context without extracting", async () => {
    const slides = {
      sourceUrl: tab.url ?? "",
      sourceId: "video-1",
      sourceKind: "video",
      ocrAvailable: false,
      transcriptTimedText: "0:01 intro\n0:05 details",
      slides: [{ index: 1, timestamp: 1 }],
    };
    const cache = panelCache({ slides });
    const harness = createHarness({ cache });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-3",
      messages: [],
      tools: ["read"],
      summary: "summary",
    });

    expect(harness.ensureChatExtractImpl).not.toHaveBeenCalled();
    expect(harness.buildSlidesTextImpl).toHaveBeenCalledWith(
      slides,
      defaultSettings.slidesOcrEnabled,
      defaultSettings.length,
    );
    expect(harness.handlePanelAgentRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "agent-3",
        tools: ["read"],
        summary: "summary",
        cachedExtract: expect.objectContaining({
          text: "0:01 intro\n0:05 details",
          source: "url",
          transcriptSource: "browser",
          transcriptTimedText: "0:01 intro\n0:05 details",
          slides,
        }),
        slidesText: { count: 1, text: "slide context" },
      }),
    );
  });

  it("merges panel slides into an extracted agent context", async () => {
    const slides = {
      sourceUrl: tab.url ?? "",
      sourceId: "video-2",
      sourceKind: "video",
      ocrAvailable: true,
      slides: [{ index: 1, timestamp: 2, ocrText: "diagram" }],
    };
    const cache = panelCache({
      slides,
      transcriptTimedText: "0:02 direct transcript",
    });
    const harness = createHarness({
      settings: {
        ...defaultSettings,
        token: "secret",
        summaryRuntime: "daemon",
        slideRuntime: "daemon",
      },
      cache,
    });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-4",
      messages: [],
      tools: [],
    });

    expect(harness.ensureChatExtractImpl).toHaveBeenCalledTimes(1);
    expect(harness.handlePanelAgentRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedExtract: expect.objectContaining({
          text: "page extract",
          transcriptTimedText: "0:02 direct transcript",
          slides,
        }),
      }),
    );
    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "agent:chunk",
      requestId: "agent-4",
      text: "chunk",
    });
    expect(harness.sendStatus).toHaveBeenCalledWith(harness.session, "Extracting chat context");
    expect(harness.sendStatus).toHaveBeenCalledWith(harness.session, "Sending to AI");
  });

  it("keeps an extracted context unchanged when no panel cache exists", async () => {
    const harness = createHarness();

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-no-cache",
      messages: [],
      tools: [],
    });

    expect(harness.handlePanelAgentRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedExtract: baseExtract,
      }),
    );
    expect(harness.buildSlidesTextImpl).toHaveBeenCalledWith(
      null,
      defaultSettings.slidesOcrEnabled,
      defaultSettings.length,
    );
  });

  it("preserves empty browser transcript metadata when slides exist", async () => {
    const slides = {
      sourceUrl: tab.url ?? "",
      sourceId: "video-3",
      sourceKind: "video",
      ocrAvailable: false,
      transcriptTimedText: "",
      slides: [{ index: 1, timestamp: 3 }],
    };
    const harness = createHarness({
      cache: panelCache({ slides, summaryMarkdown: "summary fallback" }),
    });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-summary",
      messages: [],
      tools: [],
    });

    expect(harness.handlePanelAgentRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedExtract: expect.objectContaining({
          text: "",
          transcriptSource: null,
          transcriptCharacters: 0,
          transcriptWordCount: 0,
          transcriptLines: 0,
        }),
      }),
    );
  });

  it("falls back to the cached summary when browser slides have no transcript", async () => {
    const slides = {
      sourceUrl: tab.url ?? "",
      sourceId: "video-4",
      sourceKind: "video",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 4 }],
    };
    const harness = createHarness({
      cache: panelCache({ slides, summaryMarkdown: "summary fallback" }),
    });

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-summary-fallback",
      messages: [],
      tools: [],
    });

    expect(harness.handlePanelAgentRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedExtract: expect.objectContaining({
          text: "summary fallback",
          transcriptCharacters: null,
          transcriptWordCount: null,
          transcriptLines: null,
        }),
      }),
    );
  });

  it("reports agent extraction failures with panel status", async () => {
    const harness = createHarness();
    harness.ensureChatExtractImpl.mockRejectedValueOnce(new Error("extract failed"));

    await harness.runtime.handleAgent(harness.session, {
      type: "panel:agent",
      requestId: "agent-5",
      messages: [],
      tools: [],
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "run:error",
      message: "extract failed",
    });
    expect(harness.sendStatus).toHaveBeenCalledWith(harness.session, "Error: extract failed");
    expect(harness.handlePanelAgentRequestImpl).not.toHaveBeenCalled();
  });

  it("normalizes thrown values for each protocol", async () => {
    const agentHarness = createHarness();
    agentHarness.ensureChatExtractImpl.mockRejectedValueOnce("agent failed");
    await agentHarness.runtime.handleAgent(agentHarness.session, {
      type: "panel:agent",
      requestId: "agent-string-error",
      messages: [],
      tools: [],
    });
    expect(agentHarness.send).toHaveBeenCalledWith(agentHarness.session, {
      type: "run:error",
      message: "agent failed",
    });

    const historyHarness = createHarness();
    historyHarness.ensureChatExtractImpl.mockRejectedValueOnce(new Error("history failed"));
    await historyHarness.runtime.handleHistory(historyHarness.session, {
      type: "panel:chat-history",
      requestId: "history-error",
    });
    expect(historyHarness.send).toHaveBeenCalledWith(historyHarness.session, {
      type: "chat:history",
      requestId: "history-error",
      ok: false,
      error: "history failed",
    });
  });

  it("loads history from an extracted page context", async () => {
    const harness = createHarness();

    await harness.runtime.handleHistory(harness.session, {
      type: "panel:chat-history",
      requestId: "history-2",
      summary: "summary",
    });

    expect(harness.ensureChatExtractImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        session: harness.session,
        tab,
        sendStatus: expect.any(Function),
      }),
    );
    expect(harness.handlePanelChatHistoryRequestImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "history-2",
        summary: "summary",
        cachedExtract: baseExtract,
      }),
    );
    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "chat:history",
      requestId: "history-2",
      ok: true,
      messages: [],
    });
    expect(harness.sendStatus).not.toHaveBeenCalled();
  });

  it("reports history extraction failures without changing panel status", async () => {
    const harness = createHarness();
    harness.ensureChatExtractImpl.mockRejectedValueOnce("history extract failed");

    await harness.runtime.handleHistory(harness.session, {
      type: "panel:chat-history",
      requestId: "history-3",
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "chat:history",
      requestId: "history-3",
      ok: false,
      error: "history extract failed",
    });
    expect(harness.sendStatus).not.toHaveBeenCalled();
    expect(harness.handlePanelChatHistoryRequestImpl).not.toHaveBeenCalled();
  });
});
