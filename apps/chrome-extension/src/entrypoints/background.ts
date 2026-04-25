import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { defineBackground } from "wxt/utils/define-background";
import { buildDaemonRequestBody, buildSummarizeRequestBody } from "../lib/daemon-payload";
import { createDaemonRecovery, isDaemonUnreachableError } from "../lib/daemon-recovery";
import { createDaemonStatusTracker } from "../lib/daemon-status";
import { logExtensionEvent } from "../lib/extension-logs";
import type { BgToPanel, PanelCachePayload, PanelToBg } from "../lib/panel-contracts";
import { loadSettings, patchSettings } from "../lib/settings";
import { canSummarizeUrl, extractFromTab, seekInTab } from "./background/content-script-bridge";
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
  });
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >();
  // Tabs explicitly armed by the sidepanel for debugger-driven native input.
  // Prevents arbitrary pages from triggering trusted clicks via the
  // postMessage → content-script → runtime bridge.
  const nativeInputArmedTabs = new Set<number>();

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
    armedTabs: nativeInputArmedTabs,
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
            void summarizeActiveTab(session, reason);
          },
        });
        break;
      case "panel:closed":
        handlePanelClosed(session, {
          clearCachedExtractsForWindow: (windowId) =>
            panelSessionStore.clearCachedExtractsForWindow(windowId),
        });
        break;
      case "panel:summarize":
        void summarizeActiveTab(
          session,
          (raw as { refresh?: boolean }).refresh ? "refresh" : "manual",
          {
            refresh: Boolean((raw as { refresh?: boolean }).refresh),
            inputMode: (raw as { inputMode?: "page" | "video" }).inputMode,
          },
        );
        break;
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
        const cached = panelSessionStore.getPanelCache(payload.tabId, payload.url);
        void send(session, {
          type: "ui:cache",
          requestId: payload.requestId,
          ok: Boolean(cached),
          cache: cached ?? undefined,
        });
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

          let cachedExtract: CachedExtract;
          try {
            cachedExtract = await ensureChatExtract({
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
          const slidesContext = buildSlidesText(cachedExtract.slides, settings.slidesOcrEnabled);
          await handlePanelAgentRequest({
            session,
            requestId: agentPayload.requestId,
            messages: agentPayload.messages,
            tools: agentPayload.tools,
            summary: agentPayload.summary,
            settings,
            cachedExtract,
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
              void summarizeActiveTab(session, reason);
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
              void summarizeActiveTab(session, reason);
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
      session.daemonRecovery.clearPending();
      panelSessionStore.deletePanelSession(windowId);
      void panelSessionStore.clearCachedExtractsForWindow(windowId);
    },
    runtimeActionsHandler: (raw, sender, sendResponse) =>
      runtimeActionsHandler(raw as NativeInputRequest | ArtifactsRequest, sender, sendResponse),
    hoverRuntimeHandler: (raw, sender, sendResponse) =>
      hoverController.handleRuntimeMessage(raw as HoverToBg, sender, sendResponse),
    emitState: (session, status) => {
      void emitState(session, status);
    },
    summarizeActiveTab: (session, reason) => {
      void summarizeActiveTab(session, reason);
    },
    onTabRemoved: (tabId) => {
      hoverController.abortHoverForTab(tabId);
      nativeInputArmedTabs.delete(tabId);
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
