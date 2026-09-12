import { patchPanelState } from "./panel-state-store";
import type { PanelState } from "./types";

type ChatQueueRuntimeOpts = {
  panelState: PanelState;

  chatQueueEl: HTMLElement;
  maxQueue: number;
  setStatus: (value: string) => void;
};

export function createChatQueueRuntime(opts: ChatQueueRuntimeOpts) {
  function normalizeQueueText(input: string) {
    return input.replace(/\s+/g, " ").trim();
  }

  function removeQueuedMessage(id: string) {
    patchPanelState(opts.panelState, "chat", {
      queue: opts.panelState.chat.queue.filter((item) => item.id !== id),
    });
    renderChatQueue();
  }

  function renderChatQueue() {
    const queue = opts.panelState.chat.queue;
    if (queue.length === 0) {
      opts.chatQueueEl.classList.add("isHidden");
      opts.chatQueueEl.replaceChildren();
      return;
    }
    opts.chatQueueEl.classList.remove("isHidden");
    opts.chatQueueEl.replaceChildren();

    for (const item of queue) {
      const row = document.createElement("div");
      row.className = "chatQueueItem";
      row.dataset.id = item.id;

      const text = document.createElement("div");
      text.className = "chatQueueText";
      text.textContent = item.text;
      text.title = item.text;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chatQueueRemove";
      remove.textContent = "x";
      remove.setAttribute("aria-label", "Remove queued message");
      remove.addEventListener("click", () => removeQueuedMessage(item.id));

      row.append(text, remove);
      opts.chatQueueEl.append(row);
    }
  }

  function enqueueChatMessage(input: string): boolean {
    const text = normalizeQueueText(input);
    if (!text) return false;
    const queue = opts.panelState.chat.queue;
    if (queue.length >= opts.maxQueue) {
      opts.setStatus(`Queue full (${opts.maxQueue}). Remove one to add more.`);
      return false;
    }
    patchPanelState(opts.panelState, "chat", {
      queue: [
        ...opts.panelState.chat.queue,
        { id: crypto.randomUUID(), text, createdAt: Date.now() },
      ],
    });
    renderChatQueue();
    return true;
  }

  function clearQueuedMessages() {
    if (opts.panelState.chat.queue.length === 0) return;
    patchPanelState(opts.panelState, "chat", { queue: [] });
    renderChatQueue();
  }

  function dequeueQueuedMessage() {
    const next = opts.panelState.chat.queue[0];
    if (next)
      patchPanelState(opts.panelState, "chat", {
        queue: opts.panelState.chat.queue.filter((item) => item.id !== next.id),
      });
    return next;
  }

  return {
    clearQueuedMessages,
    dequeueQueuedMessage,
    enqueueChatMessage,
    getQueueLength: () => opts.panelState.chat.queue.length,
    renderChatQueue,
  };
}
