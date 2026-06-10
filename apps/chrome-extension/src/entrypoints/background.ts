import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import { defineBackground } from "wxt/utils/define-background";
import { createBrowserPanelCacheStore } from "../lib/browser-panel-cache";
import { buildDaemonRequestBody, buildSummarizeRequestBody } from "../lib/daemon-payload";
import { createDaemonRecovery, isDaemonUnreachableError } from "../lib/daemon-recovery";
import { createDaemonStatusTracker } from "../lib/daemon-status";
import { logExtensionEvent } from "../lib/extension-logs";
import type { BgToPanel, PanelCachePayload, PanelToBg } from "../lib/panel-contracts";
import { loadSettings, patchSettings } from "../lib/settings";
import { runBrowserSlidesForTab, takeBrowserSlidesPayload } from "./background/browser-slides";
import {
  beginSlideFrameCaptureInTab,
  canSummarizeUrl,
  extractFromTab,
  prepareCurrentSlideFrameInTab,
  prepareSlideFrameInTab,
  restoreSlideFrameInTab,
  seekInTab,
} from "./background/content-script-bridge";
import { daemonHealth, daemonPing, friendlyFetchError } from "./background/daemon-client";
import { ensureChatExtract, primeMediaHint, type CachedExtract } from "./background/extract-cache";
import { createHoverController, type HoverToBg } from "./background/hover-controller";
import { bindBackgroundListeners } from "./background/listeners";
import { handlePanelAgentRequest, handlePanelChatHistoryRequest } from "./background/panel-chat";
import { createBackgroundPanelRuntime } from "./background/panel-runtime";
import {
  handlePanelClosed,
  handlePanelReady,
  handlePanelSetAuto,
  handlePanelSetLength,
} from "./background/panel-session-actions";
import { createPanelSessionStore, type PanelSession } from "./background/panel-session-store";
import { handlePanelSlidesContextRequest } from "./background/panel-slides-context";
import { type PanelUiState } from "./background/panel-state";
import {
  buildSlidesText,
  getActiveTab,
  openOptionsWindow,
  type SlidesPayload,
  urlsMatch,
} from "./background/panel-utils";
import {
  createRuntimeActionsHandler,
  type ArtifactsRequest,
  type NativeInputRequest,
} from "./background/runtime-actions";
import { extractYouTubeTranscriptInTab } from "./background/youtube-transcript";

type BackgroundPanelSession = PanelSession<
  ReturnType<typeof createDaemonRecovery>,
  ReturnType<typeof createDaemonStatusTracker>
>;
export default defineBackground(() => {
  const panelSessionStore = createPanelSessionStore<
    CachedExtract,
    PanelCachePayload,
    ReturnType<typeof createDaemonRecovery>,
    ReturnType<typeof createDaemonStatusTracker>
  >({
    createDaemonRecovery,
    createDaemonStatus: createDaemonStatusTracker,
    persistentPanelCache: createBrowserPanelCacheStore(),
    shouldUsePersistentPanelCache: async (payload) => {
      const settings = await loadSettings();
      if (settings.slideRuntime !== "browser") return false;
      const tab = await chrome.tabs.get(payload.tabId).catch(() => null);
      return tab?.incognito === false;
    },
  });
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >();
  // Tabs explicitly armed by the sidepanel for debugger-driven native input.
  // Prevents arbitrary pages from triggering trusted clicks via the
  // postMessage → content-script → runtime bridge.
  const nativeInputArmedTabs = new Map<number, string>();
  const artifactsArmedTabs = new Set<number>();
  const browserSlidesInFlightByWindowId = new Map<
    number,
    { key: string; userInitiated: boolean }
  >();
  const browserSlidesRetryByWindowId = new Map<
    number,
    { inputMode?: "page" | "video"; reason?: string }
  >();

  function resolveLogLevel(event: string) {
    const normalized = event.toLowerCase();
    if (normalized.includes("error") || normalized.includes("failed")) return "error";
    if (normalized.includes("warn")) return "warn";
    return "verbose";
  }
  const logExtract = (windowId: number) => (event: string, detail?: Record<string, unknown>) => {
    const detailPayload = detail ? { windowId, ...detail } : { windowId };
    logExtensionEvent({
      event,
      detail: detailPayload,
      scope: "extractor",
      level: resolveLogLevel(event),
    });
    console.debug("[summarize][extractor]", { event, ...detailPayload });
  };
  const runtimeActionsHandler = createRuntimeActionsHandler({
    nativeInputArmedTabs,
    artifactsArmedTabs,
  });
  const hoverController = createHoverController({
    hoverControllersByTabId,
    buildDaemonRequestBody,
    resolveLogLevel,
  });

  const { send, sendStatus, emitState, summarizeActiveTab } =
    createBackgroundPanelRuntime<BackgroundPanelSession>({
      panelSessionStore,
      loadSettings,
      getActiveTab,
      daemonHealth,
      daemonPing,
      canSummarizeUrl,
      urlsMatch,
      primeMediaHint,
      extractFromTab,
      buildSummarizeRequestBody,
      friendlyFetchError,
      isDaemonUnreachableError,
      fetchImpl: (...args) => fetch(...args),
      resolveLogLevel,
    });

  async function maybeStartBrowserSlides(
    session: BackgroundPanelSession,
    opts: { inputMode?: "page" | "video"; reason?: string },
  ) {
    const setBrowserSlidesDebug = (value: unknown) => {
      (
        globalThis as typeof globalThis & {
          __summarizeBrowserSlidesLastResult?: unknown;
        }
      ).__summarizeBrowserSlidesLastResult = value;
    };
    const tab = await getActiveTab(session.windowId);
    const tabUrl = tab?.url ?? "";
    const inputMode =
      opts.inputMode ?? (shouldPreferUrlMode(tabUrl) || isYouTubeVideoUrl(tabUrl) ? "video" : null);
    const canAttemptBrowserCapture =
      isYouTubeVideoUrl(tabUrl) || opts.inputMode === "video" || opts.reason === "slides-capture";
    if (inputMode !== "video") {
      return;
    }
    if (!canAttemptBrowserCapture) {
      setBrowserSlidesDebug({ ok: false, error: "skipped: browser capture requires video" });
      return;
    }
    const settings = await loadSettings();
    const isUserInitiatedCapture =
      opts.reason === "manual" ||
      opts.reason === "refresh" ||
      opts.reason === "length-change" ||
      opts.reason === "slides-capture";
    if (!isUserInitiatedCapture && opts.reason !== "cache-restore" && !settings.autoSummarize) {
      setBrowserSlidesDebug({ ok: false, error: "skipped: auto summarize disabled" });
      return;
    }
    if (!settings.slidesEnabled) {
      setBrowserSlidesDebug({ ok: false, error: "skipped: slides disabled" });
      return;
    }
    if (settings.slideRuntime !== "browser") {
      setBrowserSlidesDebug({ ok: false, error: "skipped: daemon runtime selected" });
      return;
    }
    if (!tab?.id || !canSummarizeUrl(tab.url)) {
      setBrowserSlidesDebug({ ok: false, error: "skipped: no capturable active tab" });
      return;
    }
    const cachedPanel = panelSessionStore.getPanelCache(tab.id, tab.url ?? null);
    if (!isUserInitiatedCapture && cachedPanel?.slides?.slides?.length) {
      setBrowserSlidesDebug({ ok: false, error: "skipped: slides already cached" });
      return;
    }
    const captureKey = tab.url ?? String(tab.id);
    const activeCaptureKey = browserSlidesInFlightByWindowId.get(session.windowId);
    if (activeCaptureKey) {
      if (
        activeCaptureKey.key !== captureKey ||
        (isUserInitiatedCapture && !activeCaptureKey.userInitiated)
      ) {
        browserSlidesRetryByWindowId.set(session.windowId, {
          inputMode: opts.inputMode,
          reason: opts.reason,
        });
      }
      return;
    }
    browserSlidesInFlightByWindowId.set(session.windowId, {
      key: captureKey,
      userInitiated: isUserInitiatedCapture,
    });
    sendStatus(session, "Capturing slides in browser...");
    const result = await (async () => {
      try {
        const transcript =
          isYouTubeVideoUrl(tabUrl) && tab.id
            ? await extractYouTubeTranscriptInTab(tab.id, settings.maxChars)
            : null;
        return await runBrowserSlidesForTab({
          tab,
          windowId: session.windowId,
          beginFrameCapture: beginSlideFrameCaptureInTab,
          prepareFrame: prepareSlideFrameInTab,
          prepareCurrentFrame: prepareCurrentSlideFrameInTab,
          restoreFrame: restoreSlideFrameInTab,
          transcriptTimedText: transcript?.ok ? transcript.transcriptTimedText : null,
          captureMode: isUserInitiatedCapture ? "seek" : "current",
        });
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (browserSlidesInFlightByWindowId.get(session.windowId)?.key === captureKey) {
          browserSlidesInFlightByWindowId.delete(session.windowId);
        }
      }
    })();
    const retry = browserSlidesRetryByWindowId.get(session.windowId) ?? null;
    if (retry) {
      browserSlidesRetryByWindowId.delete(session.windowId);
    }
    setBrowserSlidesDebug(result);
    if (!result.ok) {
      if (retry) {
        void maybeStartBrowserSlides(session, retry);
        return;
      }
      void send(session, { type: "slides:run", ok: false, error: result.error });
      sendStatus(session, `Slides failed: ${result.error}`);
      return;
    }
    void send(session, {
      type: "slides:run",
      ok: true,
      runId: result.runId,
      url: result.slides.sourceUrl,
      local: true,
    });
    sendStatus(session, "");
    if (retry) {
      void maybeStartBrowserSlides(session, retry);
    }
  }

  function summarizeActiveTabWithBrowserSlides(
    session: BackgroundPanelSession,
    reason: string,
    opts?: { refresh?: boolean; inputMode?: "page" | "video" },
  ) {
    void summarizeActiveTab(session, reason, opts);
    void maybeStartBrowserSlides(session, {
      inputMode: opts?.inputMode,
      reason,
    });
  }

  const handlePanelMessage = (session: BackgroundPanelSession, raw: PanelToBg) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }
    const type = raw.type;
    if (type !== "panel:closed") {
      session.panelOpen = true;
    }
    if (type === "panel:ping") session.panelLastPingAt = Date.now();

    switch (type) {
      case "panel:ready":
        handlePanelReady(session, {
          emitState: () => {
            void emitState(session, "");
          },
          summarizeActiveTab: (reason) => {
            summarizeActiveTabWithBrowserSlides(session, reason);
          },
        });
        break;
      case "panel:closed":
        handlePanelClosed(session, {
          clearCachedExtractsForWindow: (windowId) =>
            panelSessionStore.clearCachedExtractsForWindow(windowId),
        });
        break;
      case "panel:summarize": {
        const refresh = Boolean((raw as { refresh?: boolean }).refresh);
        summarizeActiveTabWithBrowserSlides(session, refresh ? "refresh" : "manual", {
          refresh,
          inputMode: (raw as { inputMode?: "page" | "video" }).inputMode,
        });
        break;
      }
      case "panel:cache": {
        const payload = (raw as { cache?: PanelCachePayload }).cache;
        if (!payload || typeof payload.tabId !== "number" || !payload.url) return;
        panelSessionStore.storePanelCache(payload);
        break;
      }
      case "panel:get-cache": {
        const payload = raw as { requestId: string; tabId: number; url: string };
        if (!payload.requestId || !payload.tabId || !payload.url) {
          return;
        }
        const requestGeneration = `${session.activeSummaryRun?.run.id ?? ""}:${session.inflightUrl ?? ""}`;
        void (async () => {
          const cached = await panelSessionStore.getPanelCacheAsync(payload.tabId, payload.url);
          const currentGeneration = `${session.activeSummaryRun?.run.id ?? ""}:${session.inflightUrl ?? ""}`;
          if (currentGeneration !== requestGeneration) return;
          const activeTab = await getActiveTab(session.windowId);
          if (activeTab?.id !== payload.tabId || activeTab.url !== payload.url) return;
          const activeRun = session.activeSummaryRun?.run ?? null;
          const activeRunMatchesRequest =
            activeRun &&
            (activeRun.url.includes("#") || payload.url.includes("#")
              ? activeRun.url === payload.url
              : urlsMatch(activeRun.url, payload.url));
          if (activeRunMatchesRequest && cached?.runId !== activeRun.id) return;
          void send(session, {
            type: "ui:cache",
            requestId: payload.requestId,
            ok: Boolean(cached),
            cache: cached ?? undefined,
          });
          if (
            cached?.summaryMarkdown &&
            !cached.slides?.slides.length &&
            cached.url &&
            isYouTubeVideoUrl(cached.url)
          ) {
            void maybeStartBrowserSlides(session, { inputMode: "video", reason: "cache-restore" });
          }
        })();
        break;
      }
      case "panel:agent":
        void (async () => {
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, { type: "run:error", message: "Chat is disabled in settings" });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, { type: "run:error", message: "Setup required (missing token)" });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, { type: "run:error", message: "Cannot chat on this page" });
            return;
          }

          const latestPanelCache = await panelSessionStore.getPanelCacheAsync(tab.id, tab.url);
          const panelTranscript =
            latestPanelCache?.transcriptTimedText ??
            latestPanelCache?.slides?.transcriptTimedText ??
            null;
          const panelCacheText =
            panelTranscript ??
            latestPanelCache?.summaryMarkdown ??
            tab.title ??
            latestPanelCache?.url ??
            tab.url;
          let cachedExtract: CachedExtract;
          try {
            cachedExtract =
              settings.slideRuntime === "browser" &&
              latestPanelCache &&
              (panelTranscript || latestPanelCache.slides)
                ? {
                    url: latestPanelCache.url,
                    title: latestPanelCache.title,
                    text: panelCacheText,
                    source: "url",
                    truncated: false,
                    totalCharacters: panelCacheText.length,
                    wordCount: panelCacheText.split(/\s+/).filter(Boolean).length,
                    media: {
                      hasVideo: true,
                      hasAudio: true,
                      hasCaptions: Boolean(panelTranscript),
                    },
                    transcriptSource: panelTranscript ? "browser" : null,
                    transcriptionProvider: null,
                    transcriptCharacters: panelTranscript?.length ?? null,
                    transcriptWordCount:
                      panelTranscript?.split(/\s+/).filter(Boolean).length ?? null,
                    transcriptLines: panelTranscript?.split(/\r?\n/).filter(Boolean).length ?? null,
                    transcriptTimedText: panelTranscript,
                    mediaDurationSeconds: null,
                    slides: latestPanelCache.slides,
                    diagnostics: null,
                  }
                : await ensureChatExtract({
                    session,
                    tab,
                    settings,
                    panelSessionStore,
                    sendStatus: (status) => sendStatus(session, status),
                    extractFromTab,
                    fetchImpl: fetch,
                    log: logExtract(session.windowId),
                  });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, { type: "run:error", message });
            sendStatus(session, `Error: ${message}`);
            return;
          }

          const agentPayload = raw as {
            requestId: string;
            messages: Message[];
            tools: string[];
            summary?: string | null;
          };
          const cachedExtractWithPanelSlides =
            latestPanelCache?.slides || latestPanelCache?.transcriptTimedText
              ? {
                  ...cachedExtract,
                  slides: latestPanelCache.slides ?? cachedExtract.slides,
                  transcriptTimedText:
                    cachedExtract.transcriptTimedText ??
                    latestPanelCache.transcriptTimedText ??
                    null,
                }
              : cachedExtract;
          const slidesContext = buildSlidesText(
            cachedExtractWithPanelSlides.slides,
            settings.slidesOcrEnabled,
            settings.length,
          );
          await handlePanelAgentRequest({
            session,
            requestId: agentPayload.requestId,
            messages: agentPayload.messages,
            tools: agentPayload.tools,
            summary: agentPayload.summary,
            settings,
            cachedExtract: cachedExtractWithPanelSlides,
            slidesText: slidesContext,
            send: (msg) => {
              void send(session, msg as BgToPanel);
            },
            sendStatus: (status) => sendStatus(session, status),
            fetchImpl: fetch,
            friendlyFetchError,
          });
        })();
        break;
      case "panel:chat-history":
        void (async () => {
          const payload = raw as { requestId: string; summary?: string | null };
          const settings = await loadSettings();
          if (!settings.chatEnabled) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Chat is disabled in settings",
            });
            return;
          }
          if (!settings.token.trim()) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Setup required (missing token)",
            });
            return;
          }

          const tab = await getActiveTab(session.windowId);
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: "Cannot chat on this page",
            });
            return;
          }

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
              session,
              tab,
              settings,
              panelSessionStore,
              sendStatus: () => {},
              extractFromTab,
              fetchImpl: fetch,
              log: logExtract(session.windowId),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void send(session, {
              type: "chat:history",
              requestId: payload.requestId,
              ok: false,
              error: message,
            });
            return;
          }

          await handlePanelChatHistoryRequest({
            requestId: payload.requestId,
            summary: payload.summary,
            settings,
            cachedExtract,
            send: (msg) => {
              void send(session, msg as BgToPanel);
            },
            fetchImpl: fetch,
            friendlyFetchError,
          });
        })();
        break;
      case "panel:ping":
        void emitState(session, "", { checkRecovery: true });
        break;
      case "panel:rememberUrl":
        session.lastSummarizedUrl = (raw as { url: string }).url;
        session.inflightUrl = null;
        break;
      case "panel:setAuto":
        void (async () => {
          await handlePanelSetAuto({
            value: (raw as { value: boolean }).value,
            patchSettings,
            emitState: () => {
              void emitState(session, "");
            },
            summarizeActiveTab: (reason) => {
              summarizeActiveTabWithBrowserSlides(session, reason);
            },
          });
        })();
        break;
      case "panel:setLength":
        void (async () => {
          await handlePanelSetLength({
            value: (raw as { value: string }).value,
            loadSettings,
            patchSettings,
            emitState: () => {
              void emitState(session, "");
            },
            summarizeActiveTab: (reason) => {
              summarizeActiveTabWithBrowserSlides(session, reason);
            },
          });
        })();
        break;
      case "panel:slides-context":
        void (async () => {
          const payload = raw as { requestId?: string; url?: string };
          const requestId = payload.requestId;
          if (!requestId) return;
          await handlePanelSlidesContextRequest({
            session,
            requestId,
            requestedUrl:
              typeof payload.url === "string" && payload.url.trim().length > 0
                ? payload.url.trim()
                : null,
            loadSettings,
            getActiveTab,
            canSummarizeUrl,
            panelSessionStore,
            urlsMatch,
            send: (msg) => {
              void send(session, msg as BgToPanel);
            },
            fetchImpl: fetch,
            resolveLogLevel,
          });
        })();
        break;
      case "panel:slides-local": {
        const payload = raw as { requestId?: string; runId?: string };
        if (!payload.requestId || !payload.runId) return;
        const slides = takeBrowserSlidesPayload(payload.runId);
        void send(session, {
          type: "slides:local",
          requestId: payload.requestId,
          ok: Boolean(slides),
          slides: slides ?? undefined,
          error: slides ? undefined : "Local slides payload not found",
        });
        break;
      }
      case "panel:slides-capture":
        void maybeStartBrowserSlides(session, {
          inputMode: "video",
          reason: raw.manual ? "slides-capture" : "cache-restore",
        });
        break;
      case "panel:openOptions":
        void openOptionsWindow();
        break;
      case "panel:seek":
        void (async () => {
          const seconds = (raw as { seconds?: number }).seconds;
          if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
            return;
          }
          const tab = await getActiveTab(session.windowId);
          if (!tab?.id) return;
          const result = await seekInTab(tab.id, Math.floor(seconds));
          if (!result.ok) {
            sendStatus(session, `Seek failed: ${result.error}`);
          }
        })();
        break;
    }
  };

  (
    globalThis as typeof globalThis & {
      __summarizeDispatchPanelMessage?: (windowId: number, raw: PanelToBg) => boolean;
    }
  ).__summarizeDispatchPanelMessage = (windowId, raw) => {
    const session = panelSessionStore.getPanelSession(windowId);
    if (!session) return false;
    handlePanelMessage(session, raw);
    return true;
  };

  bindBackgroundListeners({
    panelSessionStore,
    handlePanelMessage: (session, msg) => {
      handlePanelMessage(session, msg as PanelToBg);
    },
    onPanelDisconnect: (session, port, windowId) => {
      if (session.port !== port) return;
      session.runController?.abort();
      session.runController = null;
      session.panelOpen = false;
      session.panelLastPingAt = 0;
      session.lastSummarizedUrl = null;
      session.inflightUrl = null;
      session.inflightRequest = null;
      session.activeSummaryRun = null;
      session.daemonRecovery.clearPending();
      panelSessionStore.deletePanelSession(windowId);
      void panelSessionStore.clearCachedExtractsForWindow(windowId);
    },
    runtimeActionsHandler: (raw, sender, sendResponse) => {
      if (
        raw &&
        typeof raw === "object" &&
        (raw as { type?: unknown }).type === "browser-cache:stats"
      ) {
        void panelSessionStore.getPersistentPanelCacheStats().then((stats) => {
          sendResponse({ ok: Boolean(stats), stats });
        });
        return true;
      }
      if (
        raw &&
        typeof raw === "object" &&
        (raw as { type?: unknown }).type === "browser-cache:clear"
      ) {
        void panelSessionStore.clearPersistentPanelCache().then((stats) => {
          if (stats) {
            for (const panelSession of panelSessionStore.getPanelSessions()) {
              void send(panelSession, { type: "ui:cache-cleared" });
            }
          }
          sendResponse({ ok: Boolean(stats), stats });
        });
        return true;
      }
      return runtimeActionsHandler(
        raw as NativeInputRequest | ArtifactsRequest,
        sender,
        sendResponse,
      );
    },
    hoverRuntimeHandler: (raw, sender, sendResponse) =>
      hoverController.handleRuntimeMessage(raw as HoverToBg, sender, sendResponse),
    emitState: (session, status) => {
      void emitState(session, status);
    },
    summarizeActiveTab: (session, reason) => {
      summarizeActiveTabWithBrowserSlides(session, reason);
    },
    onTabRemoved: (tabId) => {
      hoverController.abortHoverForTab(tabId);
      nativeInputArmedTabs.delete(tabId);
      artifactsArmedTabs.delete(tabId);
    },
  });

  // Chrome: Auto-open side panel on toolbar icon click
  if (import.meta.env.BROWSER === "chrome") {
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  }

  // Firefox: Toggle sidebar on toolbar icon click
  // Firefox supports sidebarAction.toggle() for programmatic control
  if (import.meta.env.BROWSER === "firefox") {
    chrome.action.onClicked.addListener(() => {
      // @ts-expect-error - sidebarAction API exists in Firefox but not in Chrome types
      if (typeof browser?.sidebarAction?.toggle === "function") {
        // @ts-expect-error - Firefox-specific API
        void browser.sidebarAction.toggle();
      }
    });
  }
});
