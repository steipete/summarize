import type {
  AgentMessage as Message,
  AgentToolCall as ToolCall,
  AgentToolResultMessage as ToolResultMessage,
} from "@steipete/summarize-core/runtime";
import { executeToolCall, getAutomationToolNames } from "../../automation/tools";
import { runChatAgentLoop } from "./chat-agent-loop";
import type { ChatController } from "./chat-controller";
import { buildEmptyUsage } from "./chat-history-store";
import { isPanelAutomationAvailable } from "./panel-capabilities";
import { patchPanelState } from "./panel-state-store";
import type { ChatMessage, PanelState } from "./types";

type AutomationNoticeAction = "extensions" | "options";

type AutomationChatSession = {
  isAbortRequested: () => boolean;
  requestAbort: (reason: string) => void;
  requestAgent: (
    messages: Message[],
    tools: string[],
    summary?: string | null,
    opts?: { onChunk?: (text: string) => void },
  ) => Promise<{ ok: boolean; assistant?: Message; error?: string }>;
};

type RuntimeMessageListener = (
  raw: unknown,
  sender: unknown,
  sendResponse?: (response: unknown) => void,
) => boolean | void;

export function createAutomationRuntime({
  panelState,

  automationNoticeActionBtn,
  automationNoticeEl,
  automationNoticeMessageEl,
  automationNoticeTitleEl,
  chatController,
  getActiveTabId,
  getChatSession,
  navigationRuntime,
  scrollToBottom,
  wrapMessage,
  eventTarget = window,
  addRuntimeMessageListener = (listener) => chrome.runtime.onMessage.addListener(listener),
}: {
  panelState: PanelState;

  automationNoticeActionBtn: HTMLButtonElement;
  automationNoticeEl: HTMLElement;
  automationNoticeMessageEl: HTMLElement;
  automationNoticeTitleEl: HTMLElement;
  chatController: Pick<
    ChatController,
    | "addMessage"
    | "buildRequestMessages"
    | "finishStreamingMessage"
    | "removeMessage"
    | "replaceMessage"
    | "updateStreamingMessage"
  >;
  getActiveTabId: () => number | null;
  getChatSession: () => AutomationChatSession;
  navigationRuntime: {
    markAgentNavigationIntent: (url: string | null | undefined) => void;
    markAgentNavigationResult: (details: unknown) => void;
  };
  scrollToBottom: (force?: boolean) => void;
  wrapMessage: (message: Message) => ChatMessage;
  eventTarget?: {
    addEventListener: (type: string, listener: EventListener) => void;
  };
  addRuntimeMessageListener?: (listener: RuntimeMessageListener) => void;
}) {
  const hideNotice = (options?: { force?: boolean }) => {
    if (panelState.panelSession.automationNoticeSticky && !options?.force) return;
    patchPanelState(panelState, "panelSession", { automationNoticeSticky: false });
    automationNoticeEl.classList.add("hidden");
  };

  const showNotice = ({
    title,
    message,
    ctaLabel,
    ctaAction,
    sticky,
  }: {
    title: string;
    message: string;
    ctaLabel?: string;
    ctaAction?: AutomationNoticeAction;
    sticky?: boolean;
  }) => {
    patchPanelState(panelState, "panelSession", { automationNoticeSticky: Boolean(sticky) });
    automationNoticeTitleEl.textContent = title;
    automationNoticeMessageEl.textContent = message;
    automationNoticeActionBtn.textContent = ctaLabel || "Open extension details";
    automationNoticeActionBtn.onclick = () => {
      if (ctaAction === "options") {
        void chrome.runtime.openOptionsPage();
        return;
      }
      void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    };
    automationNoticeEl.classList.remove("hidden");
  };

  eventTarget.addEventListener("summarize:automation-permissions", ((event: CustomEvent) => {
    const detail = event.detail as
      | {
          title?: string;
          message?: string;
          ctaLabel?: string;
          ctaAction?: AutomationNoticeAction;
        }
      | undefined;
    if (!detail?.message) return;
    showNotice({
      title: detail.title ?? "Automation permission required",
      message: detail.message,
      ctaLabel: detail.ctaLabel,
      ctaAction: detail.ctaAction,
      sticky: true,
    });
  }) as EventListener);

  const requestAbort = (reason: string) => {
    getChatSession().requestAbort(reason);
  };

  addRuntimeMessageListener((raw, _sender, sendResponse) => {
    if (!raw || typeof raw !== "object") return;
    if ((raw as { type?: string }).type !== "automation:abort-agent") return;
    requestAbort("Agent aborted");
    sendResponse?.({ ok: true });
    return true;
  });

  const hideReplOverlayForActiveTab = async () => {
    const activeTabId = getActiveTabId();
    if (!activeTabId) return;
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "automation:repl-overlay",
        action: "hide",
        message: null,
      });
    } catch {
      // Ignore tabs without the automation content script.
    }
  };

  const createStreamingAssistantMessage = (): ChatMessage => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai",
    model: "streaming",
    usage: buildEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const confirmToolCall = async (call: ToolCall) =>
    window.confirm(
      [
        "Summarize agent wants to run an automation tool.",
        "Only approve this if you expected the current task to control the browser or extension automation.",
        "",
        `${call.name}\n\n${call.arguments ? JSON.stringify(call.arguments, null, 2) : "{}"}`,
      ].join("\n"),
    );

  const runAgentLoop = async () => {
    await runChatAgentLoop({
      automationEnabled: isPanelAutomationAvailable(panelState),
      chatController,
      chatSession: getChatSession(),
      confirmToolCall,
      createStreamingAssistantMessage,
      executeToolCall: async (call) => (await executeToolCall(call)) as ToolResultMessage,
      getAutomationToolNames,
      hasDebuggerPermission: () => chrome.permissions.contains({ permissions: ["debugger"] }),
      markAgentNavigationIntent: navigationRuntime.markAgentNavigationIntent,
      markAgentNavigationResult: navigationRuntime.markAgentNavigationResult,
      scrollToBottom,
      summaryMarkdown: panelState.summaryMarkdown,
      wrapMessage,
    });
  };

  return {
    hideNotice,
    hideReplOverlayForActiveTab,
    requestAbort,
    runAgentLoop,
  };
}
