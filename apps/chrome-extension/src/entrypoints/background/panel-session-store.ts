export type PanelSession<Recovery, Status> = {
  windowId: number;
  port: chrome.runtime.Port;
  panelOpen: boolean;
  panelLastPingAt: number;
  lastSummarizedUrl: string | null;
  inflightUrl: string | null;
  inflightRequest: {
    url: string;
    inputMode: "page" | "video" | null;
    slides: boolean;
  } | null;
  activeSummaryRun: {
    run: {
      id: string;
      url: string;
      title: string | null;
      model: string;
      reason: string;
      slides?: boolean;
    };
    startedAt: number;
    inputMode: "page" | "video" | null;
    slides: boolean;
  } | null;
  runController: AbortController | null;
  agentController: AbortController | null;
  lastNavAt: number;
  daemonRecovery: Recovery;
  daemonStatus: Status;
};

type PersistentPanelCache<PanelCachePayload> = {
  getPanel: (url: string) => Promise<PanelCachePayload | null>;
  setPanel: (payload: PanelCachePayload) => Promise<void>;
  clear: () => Promise<unknown>;
  stats: () => Promise<unknown>;
};

export function createPanelSessionStore<
  CachedExtract extends { url: string },
  PanelCachePayload extends { tabId: number; url: string },
  Recovery,
  Status,
>({
  createDaemonRecovery,
  createDaemonStatus,
  persistentPanelCache,
  shouldUsePersistentPanelCache,
}: {
  createDaemonRecovery: () => Recovery;
  createDaemonStatus: () => Status;
  persistentPanelCache?: PersistentPanelCache<PanelCachePayload> | null;
  shouldUsePersistentPanelCache?:
    | ((payload: Pick<PanelCachePayload, "tabId" | "url">) => Promise<boolean>)
    | ((payload: Pick<PanelCachePayload, "tabId" | "url">) => boolean);
}) {
  const panelSessions = new Map<number, PanelSession<Recovery, Status>>();
  const lastMediaProbeByTab = new Map<number, string>();
  const cachedExtracts = new Map<number, CachedExtract>();
  const panelCacheByTabId = new Map<number, PanelCachePayload>();
  const panelCacheWriteGenerationByUrl = new Map<string, number>();
  const panelCacheGenerationByTabId = new Map<number, number>();
  let panelCacheWriteGeneration = 0;
  let panelCacheGeneration = 0;
  let persistentCacheEpoch = 0;

  const getPanelCache = (tabId: number, url?: string | null) => {
    const cached = panelCacheByTabId.get(tabId) ?? null;
    if (!cached) return null;
    if (url && cached.url !== url) return null;
    return cached;
  };

  const getPanelPortMap = () => {
    const global = globalThis as typeof globalThis & {
      __summarizePanelPorts?: Map<number, chrome.runtime.Port>;
    };
    if (!global.__summarizePanelPorts) {
      global.__summarizePanelPorts = new Map();
    }
    return global.__summarizePanelPorts;
  };

  return {
    isPanelOpen(session: PanelSession<Recovery, Status>) {
      if (!session.panelOpen) return false;
      if (session.panelLastPingAt === 0) return true;
      return Date.now() - session.panelLastPingAt < 45_000;
    },
    getPanelSession(windowId: number) {
      return panelSessions.get(windowId) ?? null;
    },
    getPanelSessions() {
      return panelSessions.values();
    },
    registerPanelSession(windowId: number, port: chrome.runtime.Port) {
      const existing = panelSessions.get(windowId);
      if (existing && existing.port !== port) {
        existing.runController?.abort();
        existing.agentController?.abort();
      }
      const session: PanelSession<Recovery, Status> = existing ?? {
        windowId,
        port,
        panelOpen: false,
        panelLastPingAt: 0,
        lastSummarizedUrl: null,
        inflightUrl: null,
        inflightRequest: null,
        activeSummaryRun: null,
        runController: null,
        agentController: null,
        lastNavAt: 0,
        daemonRecovery: createDaemonRecovery(),
        daemonStatus: createDaemonStatus(),
      };
      session.port = port;
      panelSessions.set(windowId, session);
      getPanelPortMap().set(windowId, port);
      return session;
    },
    deletePanelSession(windowId: number) {
      panelSessions.delete(windowId);
      getPanelPortMap().delete(windowId);
    },
    getCachedExtract(tabId: number, url?: string | null) {
      const cached = cachedExtracts.get(tabId) ?? null;
      if (!cached) return null;
      if (url && cached.url !== url) {
        cachedExtracts.delete(tabId);
        return null;
      }
      return cached;
    },
    setCachedExtract(tabId: number, payload: CachedExtract) {
      cachedExtracts.set(tabId, payload);
    },
    rememberMediaProbe(tabId: number, url: string) {
      lastMediaProbeByTab.set(tabId, url);
    },
    getLastMediaProbe(tabId: number) {
      return lastMediaProbeByTab.get(tabId) ?? null;
    },
    storePanelCache(payload: PanelCachePayload) {
      panelCacheByTabId.set(payload.tabId, payload);
      panelCacheGeneration += 1;
      panelCacheGenerationByTabId.set(payload.tabId, panelCacheGeneration);
      const cacheKey = payload.url;
      panelCacheWriteGeneration += 1;
      const writeGeneration = panelCacheWriteGeneration;
      panelCacheWriteGenerationByUrl.set(cacheKey, writeGeneration);
      void (async () => {
        const epoch = persistentCacheEpoch;
        if (shouldUsePersistentPanelCache && !(await shouldUsePersistentPanelCache(payload)))
          return;
        if (epoch !== persistentCacheEpoch) return;
        if (panelCacheWriteGenerationByUrl.get(cacheKey) !== writeGeneration) return;
        await persistentPanelCache?.setPanel(payload);
      })().catch(() => null);
    },
    getPanelCache(tabId: number, url?: string | null) {
      return getPanelCache(tabId, url);
    },
    async getPanelCacheAsync(tabId: number, url?: string | null) {
      const cached = getPanelCache(tabId, url);
      if (cached || !url) return cached;
      const epoch = persistentCacheEpoch;
      const tabGeneration = panelCacheGenerationByTabId.get(tabId) ?? 0;
      if (shouldUsePersistentPanelCache && !(await shouldUsePersistentPanelCache({ tabId, url })))
        return null;
      const persistent = (await persistentPanelCache?.getPanel(url).catch(() => null)) ?? null;
      if (epoch !== persistentCacheEpoch) return null;
      if (!persistent) return null;
      const freshCached = getPanelCache(tabId, url);
      if (freshCached) return freshCached;
      if ((panelCacheGenerationByTabId.get(tabId) ?? 0) !== tabGeneration) return null;
      panelCacheByTabId.set(tabId, { ...persistent, tabId });
      return panelCacheByTabId.get(tabId) ?? null;
    },
    async getPersistentPanelCacheStats() {
      return (await persistentPanelCache?.stats().catch(() => null)) ?? null;
    },
    async clearPersistentPanelCache() {
      persistentCacheEpoch += 1;
      panelCacheByTabId.clear();
      panelCacheWriteGenerationByUrl.clear();
      panelCacheGenerationByTabId.clear();
      return (await persistentPanelCache?.clear().catch(() => null)) ?? null;
    },
    async clearCachedExtractsForWindow(windowId: number) {
      try {
        const tabs = await chrome.tabs.query({ windowId });
        for (const tab of tabs) {
          if (!tab.id) continue;
          cachedExtracts.delete(tab.id);
          lastMediaProbeByTab.delete(tab.id);
        }
      } catch {
        // ignore
      }
    },
    clearTab(tabId: number) {
      cachedExtracts.delete(tabId);
      lastMediaProbeByTab.delete(tabId);
      panelCacheByTabId.delete(tabId);
      panelCacheGeneration += 1;
      panelCacheGenerationByTabId.set(tabId, panelCacheGeneration);
    },
  };
}
