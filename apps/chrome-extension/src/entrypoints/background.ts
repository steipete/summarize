import { defineBackground } from "wxt/utils/define-background";
import { createBrowserPanelCacheStore } from "../lib/browser-panel-cache";
import { bindNativeDaemonBridge, daemonFetch } from "../lib/daemon-fetch";
import { buildDaemonRequestBody, buildSummarizeRequestBody } from "../lib/daemon-payload";
import { createDaemonRecovery, isDaemonUnreachableError } from "../lib/daemon-recovery";
import { createDaemonStatusTracker } from "../lib/daemon-status";
import { logExtensionEvent } from "../lib/extension-logs";
import type { BgToPanel, PanelCachePayload, PanelToBg } from "../lib/panel-contracts";
import { loadSettings, patchSettings } from "../lib/settings";
import { transcribeBrowserMediaInTab } from "./background/browser-local-transcript";
import { runBrowserSlidesForTab, takeBrowserSlidesPayload } from "./background/browser-slides";
import { createBrowserSlidesRuntime } from "./background/browser-slides-runtime";
import {
  beginSlideFrameCaptureInTab,
  canSummarizeUrl,
  extractFromTab,
  getPrimaryMediaInfoInTab,
  prepareCurrentSlideFrameInTab,
  prepareSlideFrameInTab,
  restoreSlideFrameInTab,
  seekInTab,
} from "./background/content-script-bridge";
import { daemonHealth, daemonPing, friendlyFetchError } from "./background/daemon-client";
import { primeMediaHint, type CachedExtract } from "./background/extract-cache";
import { createHoverController, type HoverToBg } from "./background/hover-controller";
import { bindBackgroundListeners } from "./background/listeners";
import { createPanelCacheRuntime } from "./background/panel-cache-runtime";
import { createPanelChatRuntime } from "./background/panel-chat-runtime";
import { createPanelMessageRouter } from "./background/panel-message-router";
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
import {
  startYoutubeLocalTranscriptionRuntime,
  transcribeYoutubeAudioInTab,
} from "./background/youtube-local-transcript";
import { extractYouTubeTranscriptInTab } from "./background/youtube-transcript";

type BackgroundPanelSession = PanelSession<
  ReturnType<typeof createDaemonRecovery>,
  ReturnType<typeof createDaemonStatusTracker>
>;
export default defineBackground(() => {
  bindNativeDaemonBridge();
  void chrome.storage.managed
    ?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => undefined);
  if (import.meta.env.BROWSER === "chrome") {
    startYoutubeLocalTranscriptionRuntime();
  }
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
      daemonFetchImpl: daemonFetch,
      resolveLogLevel,
      transcribeMediaLocally:
        import.meta.env.BROWSER === "chrome" ? transcribeBrowserMediaInTab : undefined,
      transcribeYouTubeLocally:
        import.meta.env.BROWSER === "chrome" ? transcribeYoutubeAudioInTab : undefined,
    });
  const panelChatRuntime = createPanelChatRuntime<BackgroundPanelSession>({
    loadSettings,
    getActiveTab,
    canSummarizeUrl,
    panelSessionStore,
    send,
    sendStatus,
    extractFromTab,
    fetchImpl: (...args) => fetch(...args),
    daemonFetchImpl: daemonFetch,
    logExtract,
    friendlyFetchError,
  });
  const browserSlidesRuntime = createBrowserSlidesRuntime<BackgroundPanelSession>({
    loadSettings,
    getActiveTab,
    canSummarizeUrl,
    panelSessionStore,
    send,
    sendStatus,
    summarizeActiveTab,
    runBrowserSlidesForTab,
    extractYouTubeTranscriptInTab,
    beginSlideFrameCaptureInTab,
    prepareSlideFrameInTab,
    prepareCurrentSlideFrameInTab,
    restoreSlideFrameInTab,
    getPrimaryMediaInfoInTab,
    logExtensionEvent,
  });
  const maybeStartBrowserSlides = browserSlidesRuntime.start;
  const summarizeActiveTabWithBrowserSlides = browserSlidesRuntime.summarize;
  const panelCacheRuntime = createPanelCacheRuntime<BackgroundPanelSession>({
    panelSessionStore,
    getActiveTab,
    urlsMatch,
    send,
    startBrowserSlides: maybeStartBrowserSlides,
  });

  const handlePanelMessage = createPanelMessageRouter<BackgroundPanelSession>({
    ready: (session) => {
      handlePanelReady(session, {
        emitState: () => {
          void emitState(session, "");
        },
        summarizeActiveTab: (reason) => {
          summarizeActiveTabWithBrowserSlides(session, reason);
        },
      });
    },
    closed: (session) => {
      handlePanelClosed(session, {
        clearCachedExtractsForWindow: (windowId) =>
          panelSessionStore.clearCachedExtractsForWindow(windowId),
      });
    },
    summarize: (session, reason, options) => {
      summarizeActiveTabWithBrowserSlides(session, reason, options);
    },
    storeCache: (_session, message) => {
      panelCacheRuntime.store(message);
    },
    getCache: (session, message) => {
      void panelCacheRuntime.get(session, message);
    },
    agent: (session, message) => {
      void panelChatRuntime.handleAgent(session, message);
    },
    chatHistory: (session, message) => {
      void panelChatRuntime.handleHistory(session, message);
    },
    ping: (session) => {
      void emitState(session, "", { checkRecovery: true });
    },
    setAuto: (session, value) => {
      void handlePanelSetAuto({
        value,
        patchSettings,
        emitState: () => {
          void emitState(session, "");
        },
        summarizeActiveTab: (reason) => {
          summarizeActiveTabWithBrowserSlides(session, reason);
        },
      });
    },
    setLength: (session, value) => {
      void handlePanelSetLength({
        value,
        loadSettings,
        patchSettings,
        emitState: () => {
          void emitState(session, "");
        },
        summarizeActiveTab: (reason) => {
          summarizeActiveTabWithBrowserSlides(session, reason);
        },
      });
    },
    slidesContext: (session, message) => {
      if (!message.requestId) return;
      void handlePanelSlidesContextRequest({
        session,
        requestId: message.requestId,
        requestedUrl:
          typeof message.url === "string" && message.url.trim().length > 0
            ? message.url.trim()
            : null,
        loadSettings,
        getActiveTab,
        canSummarizeUrl,
        panelSessionStore,
        urlsMatch,
        send: (msg) => {
          void send(session, msg as BgToPanel);
        },
        fetchImpl: daemonFetch,
        resolveLogLevel,
      });
    },
    slidesLocal: (session, message) => {
      if (!message.requestId || !message.runId) return;
      const slides = takeBrowserSlidesPayload(message.runId);
      void send(session, {
        type: "slides:local",
        requestId: message.requestId,
        ok: Boolean(slides),
        slides: slides ?? undefined,
        error: slides ? undefined : "Local slides payload not found",
      });
    },
    slidesCapture: (session, message) => {
      void maybeStartBrowserSlides(session, {
        inputMode: "video",
        reason: message.manual ? "slides-capture" : "cache-restore",
      });
    },
    openOptions: (options) => {
      void openOptionsWindow(options?.tab);
    },
    seek: (session, seconds) => {
      void (async () => {
        const tab = await getActiveTab(session.windowId);
        if (!tab?.id) return;
        const result = await seekInTab(tab.id, seconds);
        if (!result.ok) {
          sendStatus(session, `Seek failed: ${result.error}`);
        }
      })();
    },
  });

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
