import type { ChatMessage } from "./types";

type ToggleableEl = {
  toggleAttribute: (qualifiedName: string, force?: boolean) => void;
};

type ClassListEl = {
  classList: {
    remove: (...tokens: string[]) => void;
    toggle?: (token: string, force?: boolean) => void;
  };
};

type ScrollEl = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
};

type InputEl = {
  focus: () => void;
};

type ResizeObserverCtor = new (callback: ResizeObserverCallback) => {
  observe: (target: Element) => void;
  disconnect: () => void;
};

export function createChatUiRuntime({
  mainEl,
  chatJumpBtn,
  chatInputEl,
  chatDockEl,
  chatContainerEl,
  chatDockContainerEl,
  renderEl,
  getChatEnabled,
  getActiveTabId,
  getSummaryMarkdown,
  clearMetrics,
  clearQueuedMessages,
  clearHistory,
  loadHistory,
  persistHistory,
  restoreHistory,
  resetChatController,
  resetChatSession,
  ResizeObserverImpl = globalThis.ResizeObserver,
}: {
  mainEl: ScrollEl;
  chatJumpBtn: ClassListEl & {
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => void;
  };
  chatInputEl: InputEl;
  chatDockEl: Element;
  chatContainerEl: ToggleableEl;
  chatDockContainerEl: ToggleableEl;
  renderEl: ClassListEl;
  getChatEnabled: () => boolean;
  getActiveTabId: () => number | null;
  getSummaryMarkdown: () => string | null;
  clearMetrics: () => void;
  clearQueuedMessages: () => void;
  clearHistory: (tabId: number | null) => Promise<void>;
  loadHistory: (tabId: number) => Promise<ChatMessage[] | null>;
  persistHistory: (tabId: number | null, chatEnabled: boolean) => Promise<void>;
  restoreHistory: (tabId: number | null, summaryMarkdown?: string | null) => Promise<void>;
  resetChatController: () => void;
  resetChatSession: () => void;
  ResizeObserverImpl?: ResizeObserverCtor;
}) {
  let autoScrollLocked = true;

  const isNearBottom = () => {
    const distance = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight;
    return distance < 32;
  };

  const updateAutoScrollLock = () => {
    autoScrollLocked = isNearBottom();
    chatJumpBtn.classList.toggle?.("isVisible", !autoScrollLocked);
  };

  const scrollToBottom = (force = false) => {
    if (force) autoScrollLocked = true;
    if (!force && !autoScrollLocked) return;
    mainEl.scrollTop = mainEl.scrollHeight;
    chatJumpBtn.classList.remove("isVisible");
  };

  const updateChatDockHeight = () => {
    const height = chatDockEl.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--chat-dock-height", `${height}px`);
  };

  const resetChatState = () => {
    resetChatController();
    clearQueuedMessages();
    chatJumpBtn.classList.remove("isVisible");
    resetChatSession();
  };

  const applyChatEnabled = () => {
    const chatEnabled = getChatEnabled();
    chatContainerEl.toggleAttribute("hidden", !chatEnabled);
    chatDockContainerEl.toggleAttribute("hidden", !chatEnabled);
    if (!chatEnabled) {
      chatJumpBtn.classList.remove("isVisible");
      clearMetrics();
      resetChatState();
      clearQueuedMessages();
    } else {
      renderEl.classList.remove("hidden");
    }
  };

  const clearChatHistoryForTab = async (tabId: number | null) => {
    await clearHistory(tabId);
  };

  const clearChatHistoryForActiveTab = async () => {
    await clearChatHistoryForTab(getActiveTabId());
  };

  const loadChatHistoryForTab = async (tabId: number) => loadHistory(tabId);

  const persistCurrentChatHistory = async () => {
    await persistHistory(getActiveTabId(), getChatEnabled());
  };

  const restoreCurrentChatHistory = async () => {
    await restoreHistory(getActiveTabId(), getSummaryMarkdown());
  };

  mainEl.addEventListener("scroll", updateAutoScrollLock, { passive: true });
  updateAutoScrollLock();

  chatJumpBtn.addEventListener("click", () => {
    scrollToBottom(true);
    chatInputEl.focus();
  });

  updateChatDockHeight();
  const chatDockObserver = ResizeObserverImpl
    ? new ResizeObserverImpl(() => updateChatDockHeight())
    : null;
  chatDockObserver?.observe(chatDockEl);

  return {
    applyChatEnabled,
    clearChatHistoryForActiveTab,
    clearChatHistoryForTab,
    dispose: () => {
      chatDockObserver?.disconnect();
    },
    loadChatHistory: loadChatHistoryForTab,
    persistChatHistory: persistCurrentChatHistory,
    resetChatState,
    restoreChatHistory: restoreCurrentChatHistory,
    scrollToBottom,
  };
}
