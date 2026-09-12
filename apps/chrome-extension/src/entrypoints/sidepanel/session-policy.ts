import { isPanelContentUrl as isMatchablePanelUrl, panelUrlsMatch } from "../../lib/panel-url";

export function shouldIgnoreTransientPanelTabState({
  nextTabUrl,
  activeTabUrl,
  currentSourceUrl,
}: {
  nextTabUrl: string | null;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  if (isMatchablePanelUrl(nextTabUrl)) return false;
  return isMatchablePanelUrl(currentSourceUrl) || isMatchablePanelUrl(activeTabUrl);
}

export type PanelNavigationDecision = {
  kind: "none" | "tab" | "url";
  preserveChat: boolean;
  shouldAbortChatStream: boolean;
  shouldClearChat: boolean;
  shouldMigrateChat: boolean;
  nextInputMode: "page" | "video" | null;
  resetInputModeOverride: boolean;
};

export function resolvePanelNavigationDecision({
  activeTabId,
  activeTabUrl,
  nextTabId,
  nextTabUrl,
  hasActiveChat,
  chatEnabled,
  preserveChat,
  preferUrlMode,
  inputModeOverride,
}: {
  activeTabId: number | null;
  activeTabUrl: string | null;
  nextTabId: number | null;
  nextTabUrl: string | null;
  hasActiveChat: boolean;
  chatEnabled: boolean;
  preserveChat: boolean;
  preferUrlMode: boolean;
  inputModeOverride: "page" | "video" | null;
}): PanelNavigationDecision {
  const tabChanged = nextTabId !== activeTabId;
  const urlChanged =
    !tabChanged && nextTabUrl && (!activeTabUrl || !panelUrlsMatch(nextTabUrl, activeTabUrl));

  if (!tabChanged && !urlChanged) {
    return {
      kind: "none",
      preserveChat,
      shouldAbortChatStream: false,
      shouldClearChat: false,
      shouldMigrateChat: false,
      nextInputMode: null,
      resetInputModeOverride: false,
    };
  }

  if (tabChanged) {
    return {
      kind: "tab",
      preserveChat,
      shouldAbortChatStream: !preserveChat,
      shouldClearChat: !preserveChat,
      shouldMigrateChat: preserveChat,
      nextInputMode: preferUrlMode ? "video" : "page",
      resetInputModeOverride: true,
    };
  }

  return {
    kind: "url",
    preserveChat,
    shouldAbortChatStream: false,
    shouldClearChat: !preserveChat && chatEnabled && hasActiveChat,
    shouldMigrateChat: false,
    nextInputMode: inputModeOverride ? null : preferUrlMode ? "video" : "page",
    resetInputModeOverride: false,
  };
}

export function shouldAcceptRunForCurrentPage({
  runUrl,
  activeTabUrl,
  currentSourceUrl,
}: {
  runUrl: string;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  const expectedUrl = resolveExpectedPageUrl(activeTabUrl, currentSourceUrl);
  if (!expectedUrl) return true;
  return panelUrlsMatch(runUrl, expectedUrl);
}

export function shouldAcceptSlidesForCurrentPage({
  targetUrl,
  activeTabUrl,
  currentSourceUrl,
}: {
  targetUrl: string | null;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  if (!targetUrl) return true;
  const expectedUrl = resolveExpectedPageUrl(activeTabUrl, currentSourceUrl);
  if (!expectedUrl) return true;
  return panelUrlsMatch(targetUrl, expectedUrl);
}

function resolveExpectedPageUrl(activeTabUrl: string | null, currentSourceUrl: string | null) {
  const activeUrl = isMatchablePanelUrl(activeTabUrl) ? activeTabUrl : null;
  const sourceUrl = isMatchablePanelUrl(currentSourceUrl) ? currentSourceUrl : null;

  if (activeUrl && sourceUrl && !panelUrlsMatch(activeUrl, sourceUrl)) return activeUrl;
  return sourceUrl ?? activeUrl;
}

export function shouldInvalidateCurrentSource({
  stateTabUrl,
  currentSourceUrl,
}: {
  stateTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  if (!stateTabUrl || !currentSourceUrl) return false;
  return !panelUrlsMatch(stateTabUrl, currentSourceUrl);
}
