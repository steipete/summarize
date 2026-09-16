import { message as uiMessage, localizedErrorText, type LocalizedText } from "../../lib/i18n";
type ChatStreamRuntimeOpts = {
  chatEnabled: () => boolean;
  isChatStreaming: () => boolean;
  setChatStreaming: (value: boolean) => void;
  hasUserMessages: () => boolean;
  addUserMessage: (text: string) => void;
  dequeueQueuedMessage: () => { text: string } | undefined;
  getQueuedChatCount: () => number;
  renderChatQueue: () => void;
  focusInput: () => void;
  clearErrors: () => void;
  resetAbort: () => void;
  metricsSetChatMode: () => void;
  setLastActionChat: () => void;
  scrollToBottom: (force?: boolean) => void;
  persistChatHistory: () => void | Promise<void>;
  setStatus: (value: LocalizedText) => void;
  showInlineError: (message: LocalizedText) => void;
  executeAgentLoop: () => Promise<void>;
};

export function createChatStreamRuntime(opts: ChatStreamRuntimeOpts) {
  function finishStreamingMessage() {
    opts.setChatStreaming(false);
    opts.focusInput();
    void opts.persistChatHistory();
    maybeSendQueuedChat();
  }

  function startChatMessage(text: string) {
    const input = text.trim();
    if (!input || !opts.chatEnabled()) return;

    opts.clearErrors();
    opts.resetAbort();
    opts.addUserMessage(input);
    opts.setChatStreaming(true);
    opts.metricsSetChatMode();
    opts.setLastActionChat();
    opts.scrollToBottom(true);

    void (async () => {
      try {
        await opts.executeAgentLoop();
      } catch (err) {
        const message = localizedErrorText(err);
        opts.setStatus(
          typeof message === "string" ? uiMessage("error.message", { error: message }) : message,
        );
        opts.showInlineError(message);
      } finally {
        finishStreamingMessage();
      }
    })();
  }

  function maybeSendQueuedChat() {
    if (opts.isChatStreaming() || !opts.chatEnabled()) return;
    if (opts.getQueuedChatCount() === 0) {
      opts.renderChatQueue();
      return;
    }
    const next = opts.dequeueQueuedMessage();
    opts.renderChatQueue();
    if (next) startChatMessage(next.text);
  }

  function retryChat() {
    if (!opts.chatEnabled() || opts.isChatStreaming()) return;
    if (!opts.hasUserMessages()) return;

    opts.clearErrors();
    opts.resetAbort();
    opts.setChatStreaming(true);
    opts.metricsSetChatMode();
    opts.setLastActionChat();
    opts.scrollToBottom(true);

    void (async () => {
      try {
        await opts.executeAgentLoop();
      } catch (err) {
        const message = localizedErrorText(err);
        opts.setStatus(
          typeof message === "string" ? uiMessage("error.message", { error: message }) : message,
        );
        opts.showInlineError(message);
      } finally {
        finishStreamingMessage();
      }
    })();
  }

  return {
    finishStreamingMessage,
    maybeSendQueuedChat,
    retryChat,
    startChatMessage,
  };
}
