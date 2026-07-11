import { isOptionsTab } from "../../lib/options-tabs";

function getRequestedTab(tabIds: Set<string>): string | null {
  const searchTab = new URLSearchParams(window.location.search).get("tab");
  if (isOptionsTab(searchTab) && tabIds.has(searchTab)) return searchTab;
  const hashTab = window.location.hash.replace(/^#/, "");
  if (isOptionsTab(hashTab) && tabIds.has(hashTab)) return hashTab;
  return null;
}

function clearRequestedTab(tabIds: Set<string>) {
  const url = new URL(window.location.href);
  const searchTab = url.searchParams.get("tab");
  const hashTab = url.hash.replace(/^#/, "");
  const shouldClearSearch = isOptionsTab(searchTab) && tabIds.has(searchTab);
  const shouldClearHash = isOptionsTab(hashTab) && tabIds.has(hashTab);
  if (!shouldClearSearch && !shouldClearHash) return;

  if (shouldClearSearch) url.searchParams.delete("tab");
  if (shouldClearHash) url.hash = "";
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function createOptionsTabs({
  root,
  buttons,
  panels,
  storageKey,
  onTabActivated,
  onLogsActiveChange,
  onProcessesActiveChange,
}: {
  root: HTMLDivElement;
  buttons: HTMLButtonElement[];
  panels: HTMLElement[];
  storageKey: string;
  onTabActivated?: (tabId: string) => void;
  onLogsActiveChange: (active: boolean) => void;
  onProcessesActiveChange: (active: boolean) => void;
}) {
  const tabIds = new Set(
    buttons.map((button) => button.dataset.tab).filter((tab): tab is string => Boolean(tab)),
  );
  const requestedTab = getRequestedTab(tabIds);
  let consumedRequestedTab = requestedTab;

  const resolveActiveTab = (): string | null => {
    const active = buttons.find((button) => button.getAttribute("aria-selected") === "true");
    return active?.dataset.tab ?? null;
  };

  const setActiveTab = (tabId: string, options: { initial?: boolean } = {}) => {
    if (!tabIds.has(tabId)) return;
    for (const button of buttons) {
      const isActive = button.dataset.tab === tabId;
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.tabPanel !== tabId;
    }
    localStorage.setItem(storageKey, tabId);
    if (!options.initial && consumedRequestedTab && tabId !== consumedRequestedTab) {
      clearRequestedTab(tabIds);
      consumedRequestedTab = null;
    }
    onTabActivated?.(tabId);
    onLogsActiveChange(tabId === "logs");
    onProcessesActiveChange(tabId === "processes");
  };

  const storedTab = localStorage.getItem(storageKey);
  setActiveTab(requestedTab ?? (storedTab && tabIds.has(storedTab) ? storedTab : "general"), {
    initial: true,
  });

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tab;
      if (tabId) setActiveTab(tabId);
    });
  }

  root.addEventListener("keydown", (event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const activeIndex = buttons.findIndex(
      (button) => button.getAttribute("aria-selected") === "true",
    );
    if (activeIndex < 0) return;
    const lastIndex = buttons.length - 1;
    let nextIndex = activeIndex;
    if (event.key === "ArrowLeft") {
      nextIndex = activeIndex === 0 ? lastIndex : activeIndex - 1;
    } else if (event.key === "ArrowRight") {
      nextIndex = activeIndex === lastIndex ? 0 : activeIndex + 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }
    const nextButton = buttons[nextIndex];
    const tabId = nextButton?.dataset.tab;
    if (!nextButton || !tabId) return;
    setActiveTab(tabId);
    nextButton.focus();
  });

  return { resolveActiveTab, setActiveTab };
}
