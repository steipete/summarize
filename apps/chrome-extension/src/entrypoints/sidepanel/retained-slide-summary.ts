import { panelUrlsMatch } from "./session-policy";
import type { PanelState } from "./types";

const getSummaryScopeUrl = (panelState: PanelState) =>
  panelState.currentSource?.url ?? panelState.navigation.activeTabUrl ?? null;

export function retainRenderedSlideSummary(
  panelState: PanelState,

  markdown: string,
) {
  if (!markdown.trim()) return;
  panelState.retainedSlideSummary = {
    markdown,
    url: getSummaryScopeUrl(panelState),
  };
}

export function selectRetainedSlideSummaryMarkdown(panelState: PanelState) {
  const retained = panelState.retainedSlideSummary;
  if (!retained) return null;
  const currentUrl = getSummaryScopeUrl(panelState);
  if (retained.url && currentUrl && !panelUrlsMatch(retained.url, currentUrl)) return null;
  return retained.markdown;
}
