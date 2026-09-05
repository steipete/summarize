import type { PanelCachePayload } from "../../lib/panel-contracts";
import type { PanelState } from "./types";

export type { PanelCachePayload } from "../../lib/panel-contracts";

export type PanelCacheResponse = {
  requestId: string;
  ok: boolean;
  cache?: PanelCachePayload;
};

export type PanelCacheRequest = {
  requestId: string;
  tabId: number;
  url: string;
};

export type PanelCacheResult = {
  tabId: number;
  url: string;
  preserveChat: boolean;
  cache: PanelCachePayload | null;
};

export type PanelCacheController = {
  resolve: (tabId: number, url: string) => PanelCachePayload | null;
  scheduleSync: (delayMs?: number) => void;
  syncNow: () => void;
  request: (tabId: number, url: string, preserveChat: boolean) => PanelCacheRequest;
  consumeResponse: (response: PanelCacheResponse) => PanelCacheResult | null;
  clear: () => void;
};

export type PanelCacheControllerOptions = {
  getSnapshot: () => PanelCachePayload | null;
  sendCache: (payload: PanelCachePayload) => void;
  sendRequest: (request: PanelCacheRequest) => void;
};

export function buildPanelCachePayload(panelState: PanelState): PanelCachePayload | null {
  const tabId = panelState.activeRun.tabId ?? panelState.navigation.activeTabId;
  const url = panelState.currentSource?.url ?? panelState.navigation.activeTabUrl;
  if (!tabId || !url) return null;
  const slidesSummary = panelState.slidesSummary;
  const hasSlidesSummaryState = Boolean(slidesSummary.runId || slidesSummary.markdown.trim());
  return {
    tabId,
    url,
    title: panelState.currentSource?.title ?? null,
    runId: panelState.runId ?? null,
    slidesRunId: panelState.slidesRunId ?? null,
    summaryMarkdown: panelState.summaryMarkdown ?? null,
    summaryFromCache: panelState.summaryFromCache ?? null,
    slidesSummaryMarkdown: slidesSummary.markdown || null,
    slidesSummaryComplete: hasSlidesSummaryState ? slidesSummary.complete : null,
    slidesSummaryModel: hasSlidesSummaryState ? slidesSummary.model : null,
    lastMeta: panelState.lastMeta,
    slides: panelState.slides ?? null,
    transcriptTimedText: panelState.slidesText.transcriptTimedText,
  };
}

export function createPanelCacheController(
  options: PanelCacheControllerOptions,
): PanelCacheController {
  const { getSnapshot, sendCache, sendRequest } = options;
  const cacheByKey = new Map<string, PanelCachePayload>();
  let syncTimer: ReturnType<typeof globalThis.setTimeout> | 0 = 0;
  let requestCounter = 0;
  let pendingRequest: {
    requestId: string;
    tabId: number;
    url: string;
    preserveChat: boolean;
  } | null = null;

  const buildKey = (tabId: number, url: string) => `${tabId}:${url}`;

  const store = (payload: PanelCachePayload) => {
    for (const key of cacheByKey.keys()) {
      if (key.startsWith(`${payload.tabId}:`) && key !== buildKey(payload.tabId, payload.url)) {
        cacheByKey.delete(key);
      }
    }
    cacheByKey.set(buildKey(payload.tabId, payload.url), payload);
  };

  const resolve = (tabId: number, url: string) => cacheByKey.get(buildKey(tabId, url)) ?? null;

  const syncNow = () => {
    const snapshot = getSnapshot();
    if (!snapshot) return;
    store(snapshot);
    sendCache(snapshot);
  };

  const scheduleSync = (delayMs = 800) => {
    const snapshot = getSnapshot();
    if (snapshot) {
      store(snapshot);
    }
    if (syncTimer) globalThis.clearTimeout(syncTimer);
    syncTimer = globalThis.setTimeout(() => {
      syncTimer = 0;
      syncNow();
    }, delayMs);
  };

  const request = (tabId: number, url: string, preserveChat: boolean): PanelCacheRequest => {
    const requestId = `cache-${++requestCounter}`;
    pendingRequest = { requestId, tabId, url, preserveChat };
    const payload = { requestId, tabId, url };
    sendRequest(payload);
    return payload;
  };

  const consumeResponse = (response: PanelCacheResponse): PanelCacheResult | null => {
    if (!pendingRequest || response.requestId !== pendingRequest.requestId) return null;
    const pending = pendingRequest;
    pendingRequest = null;
    if (!response.ok || !response.cache) {
      return {
        tabId: pending.tabId,
        url: pending.url,
        preserveChat: pending.preserveChat,
        cache: null,
      };
    }
    store(response.cache);
    return {
      tabId: pending.tabId,
      url: pending.url,
      preserveChat: pending.preserveChat,
      cache: response.cache,
    };
  };

  const clear = () => {
    cacheByKey.clear();
    pendingRequest = null;
    if (syncTimer) {
      globalThis.clearTimeout(syncTimer);
      syncTimer = 0;
    }
  };

  return { resolve, scheduleSync, syncNow, request, consumeResponse, clear };
}
