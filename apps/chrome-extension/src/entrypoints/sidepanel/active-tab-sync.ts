import { isPanelContentUrl, panelUrlsMatch } from "../../lib/panel-url";
import type { NavigationRuntime } from "./navigation-runtime";

export type PanelSource = { url: string; title: string | null };

type ActiveTab = {
  id?: number;
  title?: string;
  url?: string;
};

type ActiveTabSyncOptions = {
  navigationRuntime: Pick<NavigationRuntime, "isRecentAgentNavigation" | "notePreserveChatForUrl">;
  getCurrentSource: () => PanelSource | null;
  setCurrentSource: (source: PanelSource | null) => void;
  resetForNavigation: (preserveChat: boolean) => void;
  setBaseTitle: (title: string) => void;
  queryActiveTab?: () => Promise<ActiveTab | null>;
};

export async function syncNavigationWithActiveTab(options: ActiveTabSyncOptions) {
  const currentSource = options.getCurrentSource();
  if (!currentSource) return;

  try {
    const tab = options.queryActiveTab
      ? await options.queryActiveTab()
      : ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null);
    if (!tab?.url || !isPanelContentUrl(tab.url)) return;
    if (!panelUrlsMatch(tab.url, currentSource.url)) {
      const preserveChat = options.navigationRuntime.isRecentAgentNavigation(
        tab.id ?? null,
        tab.url,
      );
      if (preserveChat) options.navigationRuntime.notePreserveChatForUrl(tab.url);
      options.setCurrentSource(null);
      options.resetForNavigation(preserveChat);
      options.setBaseTitle(tab.title || tab.url || "Summarize");
      return;
    }
    if (tab.title && tab.title !== currentSource.title) {
      options.setCurrentSource({ ...currentSource, title: tab.title });
      options.setBaseTitle(tab.title);
    }
  } catch {
    // Ignore active-tab queries that fail during panel shutdown or navigation.
  }
}
