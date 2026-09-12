import { panelUrlsMatch } from "../../lib/panel-url";
import type { NavigationPolicyState } from "./types";

export type NavigationRuntime = {
  markAgentNavigationIntent: (url: string | null | undefined) => void;
  markAgentNavigationResult: (details: unknown) => void;
  getLastAgentNavigationUrl: () => string | null;
  isRecentAgentNavigation: (tabId: number | null, url: string | null) => boolean;
  notePreserveChatForUrl: (url: string | null) => void;
  shouldPreserveChatForRun: (url: string) => boolean;
};

type NavigationRuntimeOptions = {
  getState: () => NavigationPolicyState;
  updateState: (value: Partial<NavigationPolicyState>) => void;
  ttlMs?: number;
};

export function createNavigationRuntime(options: NavigationRuntimeOptions): NavigationRuntime {
  const { ttlMs = 20_000 } = options;

  const isRecentAgentNavigation = (tabId: number | null, url: string | null) => {
    const { lastAgentNavigation } = options.getState();
    if (!lastAgentNavigation) return false;
    if (Date.now() - lastAgentNavigation.at > ttlMs) {
      options.updateState({ lastAgentNavigation: null });
      return false;
    }
    if (tabId != null && lastAgentNavigation.tabId != null && tabId === lastAgentNavigation.tabId) {
      return true;
    }
    if (url && lastAgentNavigation.url && panelUrlsMatch(url, lastAgentNavigation.url)) {
      return true;
    }
    return false;
  };

  const notePreserveChatForUrl = (url: string | null) => {
    if (!url) return;
    options.updateState({ pendingPreserveChatForUrl: { url, at: Date.now() } });
  };

  const shouldPreserveChatForRun = (url: string) => {
    const pending = options.getState().pendingPreserveChatForUrl;
    if (pending && Date.now() - pending.at < ttlMs && panelUrlsMatch(url, pending.url)) {
      options.updateState({ pendingPreserveChatForUrl: null });
      return true;
    }
    return isRecentAgentNavigation(null, url);
  };

  return {
    markAgentNavigationIntent(url) {
      const trimmed = typeof url === "string" ? url.trim() : "";
      if (!trimmed) return;
      options.updateState({
        lastAgentNavigation: { url: trimmed, tabId: null, at: Date.now() },
      });
    },
    markAgentNavigationResult(details) {
      if (!details || typeof details !== "object") return;
      const obj = details as { finalUrl?: unknown; tabId?: unknown };
      const finalUrl = typeof obj.finalUrl === "string" ? obj.finalUrl.trim() : "";
      const tabId = typeof obj.tabId === "number" ? obj.tabId : null;
      if (!finalUrl && tabId == null) return;
      options.updateState({
        lastAgentNavigation: {
          url: finalUrl || options.getState().lastAgentNavigation?.url || "",
          tabId,
          at: Date.now(),
        },
      });
    },
    getLastAgentNavigationUrl() {
      return options.getState().lastAgentNavigation?.url ?? null;
    },
    isRecentAgentNavigation,
    notePreserveChatForUrl,
    shouldPreserveChatForRun,
  };
}
