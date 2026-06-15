import type { Message } from "@earendil-works/pi-ai";
import type MarkdownIt from "markdown-it";
import type { BgToPanel, PanelToBg } from "../../lib/panel-contracts";
import { createAutomationRuntime } from "./automation-runtime";
import { ChatController } from "./chat-controller";
import { createChatHistoryRuntime } from "./chat-history-runtime";
import { createChatHistoryStore, normalizeStoredMessage } from "./chat-history-store";
import { createChatQueueRuntime } from "./chat-queue-runtime";
import { createChatSession } from "./chat-session";
import type { ChatHistoryLimits } from "./chat-state";
import { createChatStreamRuntime } from "./chat-stream-runtime";
import { createChatUiRuntime } from "./chat-ui-runtime";
import { isPanelChatAvailable } from "./panel-capabilities";
import type { PanelStateAction } from "./panel-state-store";
import { parseTimestampHref } from "./timestamp-links";
import type { ChatMessage, PanelState } from "./types";

const CHAT_LIMITS: ChatHistoryLimits = {
  maxMessages: 1000,
  maxChars: 160_000,
};
const MAX_CHAT_QUEUE = 10;

type NavigationRuntime = {
  markAgentNavigationIntent: (url: string | null | undefined) => void;
  markAgentNavigationResult: (details: unknown) => void;
};

export function createSidepanelChatRuntime({
  panelState,
  dispatchPanelState,
  markdown,
  mainEl,
  renderEl,
  chatContainerEl,
  chatContextStatusEl,
  chatDockEl,
  chatInputEl,
  chatJumpBtn,
  chatMessagesEl,
  chatQueueEl,
  chatSendBtn,
  automationNoticeActionBtn,
  automationNoticeEl,
  automationNoticeMessageEl,
  automationNoticeTitleEl,
  getActiveTabId,
  getActiveTabUrl,
  navigationRuntime,
  send,
  setStatus,
  clearErrors,
  showInlineError,
  clearChatMetrics,
  setChatMetricsMode,
  setLastActionChat,
  renderInlineSlides,
  seekToTimestamp,
}: {
  panelState: PanelState;
  dispatchPanelState: (action: PanelStateAction) => void;
  markdown: MarkdownIt;
  mainEl: HTMLElement;
  renderEl: HTMLElement;
  chatContainerEl: HTMLElement;
  chatContextStatusEl: HTMLDivElement;
  chatDockEl: HTMLDivElement;
  chatInputEl: HTMLTextAreaElement;
  chatJumpBtn: HTMLButtonElement;
  chatMessagesEl: HTMLDivElement;
  chatQueueEl: HTMLDivElement;
  chatSendBtn: HTMLButtonElement;
  automationNoticeActionBtn: HTMLButtonElement;
  automationNoticeEl: HTMLElement;
  automationNoticeMessageEl: HTMLElement;
  automationNoticeTitleEl: HTMLElement;
  getActiveTabId: () => number | null;
  getActiveTabUrl: () => string | null;
  navigationRuntime: NavigationRuntime;
  send: (message: PanelToBg) => Promise<void>;
  setStatus: (value: string) => void;
  clearErrors: () => void;
  showInlineError: (message: string) => void;
  clearChatMetrics: () => void;
  setChatMetricsMode: () => void;
  setLastActionChat: () => void;
  renderInlineSlides: () => void;
  seekToTimestamp: (seconds: number) => void;
}) {
  let chatUiRuntime: ReturnType<typeof createChatUiRuntime>;
  let automationRuntime: ReturnType<typeof createAutomationRuntime>;

  const wrapMessage = (message: Message): ChatMessage => ({
    ...message,
    id: crypto.randomUUID(),
  });

  const chatHistoryStore = createChatHistoryStore({ chatLimits: CHAT_LIMITS });
  const chatController = new ChatController({
    messagesEl: chatMessagesEl,
    inputEl: chatInputEl,
    sendBtn: chatSendBtn,
    contextEl: chatContextStatusEl,
    markdown,
    limits: CHAT_LIMITS,
    panelState,
    dispatchPanelState,
    scrollToBottom: () => chatUiRuntime.scrollToBottom(),
    onNewContent: renderInlineSlides,
  });

  const chatSession = createChatSession({
    hideReplOverlay: () => automationRuntime.hideReplOverlayForActiveTab(),
    send,
    setStatus,
  });

  const chatHistoryRuntime = createChatHistoryRuntime({
    chatController,
    chatHistoryStore,
    chatLimits: CHAT_LIMITS,
    normalizeStoredMessage,
    requestChatHistory: (summary) => chatSession.requestChatHistory(summary),
    getActiveUrl: getActiveTabUrl,
  });

  const chatQueueRuntime = createChatQueueRuntime({
    panelState,
    dispatchPanelState,
    chatQueueEl,
    maxQueue: MAX_CHAT_QUEUE,
    setStatus,
  });

  chatUiRuntime = createChatUiRuntime({
    mainEl,
    chatJumpBtn,
    chatInputEl,
    chatDockEl,
    chatContainerEl,
    chatDockContainerEl: chatDockEl,
    renderEl,
    getChatEnabled: () => isPanelChatAvailable(panelState),
    getActiveTabId,
    getSummaryMarkdown: () => panelState.summaryMarkdown,
    clearMetrics: clearChatMetrics,
    clearQueuedMessages: chatQueueRuntime.clearQueuedMessages,
    clearHistory: chatHistoryRuntime.clear,
    loadHistory: chatHistoryRuntime.load,
    persistHistory: chatHistoryRuntime.persist,
    restoreHistory: chatHistoryRuntime.restore,
    resetChatController: () => chatController.reset(),
    resetChatSession: () => chatSession.reset(),
  });

  automationRuntime = createAutomationRuntime({
    panelState,
    dispatchPanelState,
    automationNoticeActionBtn,
    automationNoticeEl,
    automationNoticeMessageEl,
    automationNoticeTitleEl,
    chatController,
    getActiveTabId,
    getChatSession: () => chatSession,
    navigationRuntime,
    scrollToBottom: chatUiRuntime.scrollToBottom,
    wrapMessage,
  });

  const chatStreamRuntime = createChatStreamRuntime({
    chatEnabled: () => isPanelChatAvailable(panelState),
    isChatStreaming: () => panelState.chat.streaming,
    setChatStreaming: (value) => {
      dispatchPanelState({ type: "chat-streaming", value });
    },
    hasUserMessages: () => chatController.hasUserMessages(),
    addUserMessage: (text) => {
      chatController.addMessage(
        wrapMessage({ role: "user", content: text, timestamp: Date.now() }),
      );
    },
    dequeueQueuedMessage: chatQueueRuntime.dequeueQueuedMessage,
    getQueuedChatCount: chatQueueRuntime.getQueueLength,
    renderChatQueue: chatQueueRuntime.renderChatQueue,
    focusInput: () => chatInputEl.focus(),
    clearErrors,
    resetAbort: () => chatSession.resetAbort(),
    metricsSetChatMode: setChatMetricsMode,
    setLastActionChat,
    scrollToBottom: chatUiRuntime.scrollToBottom,
    persistChatHistory: chatUiRuntime.persistChatHistory,
    setStatus,
    showInlineError,
    executeAgentLoop: automationRuntime.runAgentLoop,
  });

  chatMessagesEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest("a.chatTimestamp") as HTMLAnchorElement | null;
    const href = link?.getAttribute("href") ?? "";
    if (!href.startsWith("timestamp:")) return;
    event.preventDefault();
    event.stopPropagation();
    const seconds = parseTimestampHref(href);
    if (seconds == null) return;
    seekToTimestamp(seconds);
  });

  const migrateHistory = async (
    fromTabId: number | null,
    toTabId: number | null,
    toUrl: string | null,
  ) => {
    if (!fromTabId || !toTabId || fromTabId === toTabId) return;
    const messages = chatController.getMessages();
    if (messages.length === 0) return;
    await chatHistoryStore.persist(toTabId, messages, true, toUrl);
  };

  return {
    applyEnabled: chatUiRuntime.applyChatEnabled,
    clearHistoryForActiveTab: chatUiRuntime.clearChatHistoryForActiveTab,
    enqueueMessage: chatQueueRuntime.enqueueChatMessage,
    finishStreamingMessage: chatStreamRuntime.finishStreamingMessage,
    getQueueLength: chatQueueRuntime.getQueueLength,
    handleAgentChunk: (message: Extract<BgToPanel, { type: "agent:chunk" }>) => {
      chatSession.handleAgentChunk(message);
    },
    handleAgentResponse: (message: Extract<BgToPanel, { type: "agent:response" }>) => {
      chatSession.handleAgentResponse(message);
    },
    handleHistory: (message: Extract<BgToPanel, { type: "chat:history" }>) => {
      chatSession.handleChatHistoryResponse(message);
    },
    hideAutomationNotice: automationRuntime.hideNotice,
    maybeSendQueuedMessage: chatStreamRuntime.maybeSendQueuedChat,
    migrateHistory,
    persistHistory: chatUiRuntime.persistChatHistory,
    requestAbort: automationRuntime.requestAbort,
    reset: chatUiRuntime.resetChatState,
    restoreHistory: chatUiRuntime.restoreChatHistory,
    retry: chatStreamRuntime.retryChat,
    scrollToBottom: chatUiRuntime.scrollToBottom,
    startMessage: chatStreamRuntime.startChatMessage,
  };
}
