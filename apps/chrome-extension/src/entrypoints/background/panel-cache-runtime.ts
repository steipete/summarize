import { isYouTubeVideoUrl } from "@steipete/summarize-core/content/url";
import type { BgToPanel, PanelCachePayload, PanelToBg } from "../../lib/panel-contracts";

type PanelCacheSession = {
  windowId: number;
  inflightUrl: string | null;
  activeSummaryRun: { run: { id: string; url: string } } | null;
};

type StoreCacheMessage = Extract<PanelToBg, { type: "panel:cache" }>;
type GetCacheMessage = Extract<PanelToBg, { type: "panel:get-cache" }>;

export function createPanelCacheRuntime<Session extends PanelCacheSession>(options: {
  panelSessionStore: {
    storePanelCache(payload: PanelCachePayload): void;
    getPanelCacheAsync(tabId: number, url?: string | null): Promise<PanelCachePayload | null>;
  };
  getActiveTab: (windowId?: number) => Promise<chrome.tabs.Tab | null>;
  urlsMatch: (left: string, right: string) => boolean;
  send: (session: Session, message: BgToPanel) => void;
  startBrowserSlides: (
    session: Session,
    options: { inputMode: "video"; reason: "cache-restore" },
  ) => void | Promise<void>;
}) {
  const { panelSessionStore, getActiveTab, urlsMatch, send, startBrowserSlides } = options;

  const store = (message: StoreCacheMessage) => {
    const payload = message.cache;
    if (!payload || typeof payload.tabId !== "number" || !payload.url) return;
    panelSessionStore.storePanelCache(payload);
  };

  const get = async (session: Session, message: GetCacheMessage) => {
    if (!message.requestId || !message.tabId || !message.url) return;
    const requestGeneration = generation(session);
    const cached = await panelSessionStore.getPanelCacheAsync(message.tabId, message.url);
    if (generation(session) !== requestGeneration) return;

    const activeTab = await getActiveTab(session.windowId);
    if (activeTab?.id !== message.tabId || activeTab.url !== message.url) return;

    const activeRun = session.activeSummaryRun?.run ?? null;
    const activeRunMatchesRequest =
      activeRun &&
      (activeRun.url.includes("#") || message.url.includes("#")
        ? activeRun.url === message.url
        : urlsMatch(activeRun.url, message.url));
    if (activeRunMatchesRequest && cached?.runId !== activeRun.id) return;

    send(session, {
      type: "ui:cache",
      requestId: message.requestId,
      ok: Boolean(cached),
      cache: cached ?? undefined,
    });
    if (
      cached?.summaryMarkdown &&
      !cached.slides?.slides.length &&
      cached.url &&
      isYouTubeVideoUrl(cached.url)
    ) {
      void startBrowserSlides(session, { inputMode: "video", reason: "cache-restore" });
    }
  };

  return { store, get };
}

function generation(session: PanelCacheSession): string {
  return `${session.activeSummaryRun?.run.id ?? ""}:${session.inflightUrl ?? ""}`;
}
