import { hasDirectProviderCredentials } from "../../lib/model-routing";
import type { UiState as PanelUiState } from "../../lib/panel-contracts";

export type { PanelUiState };

type CachedExtractLike = {
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  wordCount: number | null;
  mediaDurationSeconds: number | null;
};

type SessionLike = {
  windowId: number;
  runController: AbortController | null;
  agentController: AbortController | null;
  inflightUrl: string | null;
  daemonRecovery: {
    getPendingUrl: () => string | null;
    maybeRecover: (args: {
      isReady: boolean;
      currentUrlMatches: boolean;
      isIdle: boolean;
    }) => boolean;
    updateStatus: (isReady: boolean) => void;
  };
  daemonStatus: {
    resolve: (
      state: { ok: boolean; authed: boolean; error?: string },
      options: { keepReady: boolean },
    ) => { ok: boolean; authed: boolean; error?: string };
  };
};

type SettingsLike = {
  token: string;
  autoSummarize: boolean;
  hoverSummaries: boolean;
  chatEnabled: boolean;
  automationEnabled: boolean;
  slidesEnabled: boolean;
  slidesParallel: boolean;
  slidesOcrEnabled: boolean;
  slidesLayout: "strip" | "gallery";
  slideRuntime: "browser" | "daemon";
  summaryRuntime: "direct" | "daemon";
  provider: string;
  providerApiKeys: Record<string, string | undefined>;
  daemonAllowed?: boolean;
  daemonManaged?: boolean;
  daemonHintDismissed: boolean;
  fontSize: number;
  lineHeight: number;
  model: string;
  length: string;
};

export async function resolvePanelState({
  session,
  status,
  checkRecovery,
  loadSettings,
  getActiveTab,
  daemonHealth,
  daemonPing,
  panelSessionStore,
  urlsMatch,
  canSummarizeUrl,
}: {
  session: SessionLike;
  status: string;
  checkRecovery?: boolean;
  loadSettings: () => Promise<SettingsLike>;
  getActiveTab: (windowId: number) => Promise<chrome.tabs.Tab | null>;
  daemonHealth: () => Promise<{ ok: boolean; error?: string }>;
  daemonPing: (token: string) => Promise<{ ok: boolean; error?: string }>;
  panelSessionStore: {
    isPanelOpen: (session: SessionLike) => boolean;
    getCachedExtract: (tabId: number, url?: string | null) => CachedExtractLike | null;
  };
  urlsMatch: (a: string, b: string) => boolean;
  canSummarizeUrl: (url: string) => boolean;
}): Promise<{
  state: PanelUiState;
  shouldRecover: boolean;
  shouldClearPending: boolean;
  shouldPrimeMedia: {
    tabId: number;
    url: string;
    title: string | null;
  } | null;
}> {
  const settings = await loadSettings();
  const tab = await getActiveTab(session.windowId);
  const token = settings.token.trim();
  const [health, authed] = token
    ? await Promise.all([daemonHealth(), daemonPing(token)])
    : [{ ok: false }, { ok: false }];
  const daemonReady = health.ok && authed.ok;
  const pendingUrl = session.daemonRecovery.getPendingUrl();
  const currentUrlMatches = Boolean(pendingUrl && tab?.url && urlsMatch(tab.url, pendingUrl));
  const isIdle = !session.runController && !session.inflightUrl;
  const cached = tab?.id ? panelSessionStore.getCachedExtract(tab.id, tab.url ?? null) : null;
  const shouldRecover = checkRecovery
    ? session.daemonRecovery.maybeRecover({
        isReady: daemonReady,
        currentUrlMatches,
        isIdle,
      })
    : (session.daemonRecovery.updateStatus(daemonReady), false);
  const daemon = session.daemonStatus.resolve(
    { ok: health.ok, authed: authed.ok, error: health.error ?? authed.error },
    {
      keepReady: Boolean(session.runController || session.agentController || session.inflightUrl),
    },
  );

  return {
    state: {
      panelOpen: panelSessionStore.isPanelOpen(session),
      daemon,
      tab: { id: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null },
      media: cached?.media ?? null,
      stats: {
        pageWords: typeof cached?.wordCount === "number" ? cached.wordCount : null,
        videoDurationSeconds:
          typeof cached?.mediaDurationSeconds === "number" ? cached.mediaDurationSeconds : null,
      },
      settings: {
        autoSummarize: settings.autoSummarize,
        hoverSummaries: settings.hoverSummaries,
        chatEnabled: settings.chatEnabled,
        automationEnabled: settings.automationEnabled,
        slidesEnabled: settings.slidesEnabled,
        slidesParallel: settings.slidesParallel,
        slidesOcrEnabled: settings.slidesOcrEnabled,
        slidesLayout: settings.slidesLayout,
        slideRuntime: settings.slideRuntime,
        summaryRuntime: settings.summaryRuntime,
        providerConfigured: hasDirectProviderCredentials(settings),
        daemonAllowed: settings.daemonAllowed !== false,
        daemonManaged: settings.daemonManaged === true,
        daemonHintDismissed: settings.daemonHintDismissed,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        model: settings.model,
        length: settings.length,
        tokenPresent: Boolean(settings.token.trim()),
      },
      status,
    },
    shouldRecover,
    shouldClearPending: Boolean(pendingUrl && tab?.url && !currentUrlMatches),
    shouldPrimeMedia:
      tab?.id && tab.url && canSummarizeUrl(tab.url)
        ? {
            tabId: tab.id,
            url: tab.url,
            title: tab.title ?? null,
          }
        : null,
  };
}
