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
  const tabIds = new Set(buttons.map((button) => button.dataset.tab).filter(Boolean));

  const resolveActiveTab = (): string | null => {
    const active = buttons.find((button) => button.getAttribute("aria-selected") === "true");
    return active?.dataset.tab ?? null;
  };

  const setActiveTab = (tabId: string) => {
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
    onTabActivated?.(tabId);
    onLogsActiveChange(tabId === "logs");
    onProcessesActiveChange(tabId === "processes");
  };

  const storedTab = localStorage.getItem(storageKey);
  setActiveTab(storedTab && tabIds.has(storedTab) ? storedTab : "general");

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
