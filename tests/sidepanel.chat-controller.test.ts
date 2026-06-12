// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatController } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-controller";
import {
  createInitialPanelState,
  createPanelStateStore,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { ChatMessage } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function createHarness(options: { injectedDispatch?: boolean } = {}) {
  const panelState = createInitialPanelState();
  const store = createPanelStateStore(panelState);
  const messagesEl = document.createElement("div");
  const inputEl = document.createElement("textarea");
  const sendBtn = document.createElement("button");
  const contextEl = document.createElement("div");
  const scrollToBottom = vi.fn();
  const onNewContent = vi.fn();
  const dispatchPanelState = vi.fn(store.dispatch);
  const controller = new ChatController({
    messagesEl,
    inputEl,
    sendBtn,
    contextEl,
    markdown: {
      render: (value: string) =>
        `<p>${value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')}</p>`,
    } as never,
    limits: { maxMessages: 10, maxChars: 10 },
    panelState,
    dispatchPanelState: options.injectedDispatch ? dispatchPanelState : undefined,
    scrollToBottom,
    onNewContent,
  });
  return {
    contextEl,
    controller,
    dispatchPanelState,
    inputEl,
    messagesEl,
    onNewContent,
    panelState,
    scrollToBottom,
    sendBtn,
  };
}

function userMessage(id = "user-1", content = "Hello"): ChatMessage {
  return { id, role: "user", content, timestamp: 1 };
}

function assistantMessage(id = "assistant-1", content: ChatMessage["content"] = "Hi"): ChatMessage {
  return { id, role: "assistant", content, timestamp: 2 } as ChatMessage;
}

describe("sidepanel chat controller", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders messages while storing them only in panel state", () => {
    const harness = createHarness();
    const message = userMessage();

    harness.controller.addMessage(message);

    expect(harness.controller.getMessages()).toBe(harness.panelState.chat.messages);
    expect(harness.panelState.chat.messages).toEqual([message]);
    expect(harness.messagesEl.textContent).toBe("Hello");
    expect(harness.messagesEl.classList.contains("isHidden")).toBe(false);
    expect(harness.contextEl.textContent).toContain("Context 50%");
    expect(harness.controller.hasUserMessages()).toBe(true);
    expect(harness.controller.buildRequestMessages()).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("sets, replaces, appends missing replacements, and removes canonical messages", () => {
    const harness = createHarness({ injectedDispatch: true });
    const user = userMessage();
    const assistant = assistantMessage();

    harness.controller.setMessages([user], { scroll: false });
    harness.controller.replaceMessage(assistant, { scroll: false });
    harness.controller.replaceMessage(assistantMessage("assistant-1", "Updated"));
    harness.controller.removeMessage(user.id);
    harness.controller.removeMessage("missing");

    expect(harness.panelState.chat.messages).toEqual([assistantMessage("assistant-1", "Updated")]);
    expect(harness.messagesEl.textContent).toContain("Updated");
    expect(harness.dispatchPanelState).toHaveBeenCalled();
    expect(harness.onNewContent).toHaveBeenCalledOnce();
    expect(harness.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("supports default set scrolling, prepend, and replacement without rendered DOM", () => {
    const harness = createHarness();
    const user = userMessage("user-1", "1234567890");
    const assistant = assistantMessage();

    harness.controller.setMessages([user]);
    harness.controller.addMessage(assistant, { prepend: true, scroll: false });
    harness.messagesEl.replaceChildren();
    harness.controller.replaceMessage(assistantMessage("assistant-1", "Recreated"), {
      scroll: false,
    });

    expect(harness.messagesEl.textContent).toContain("Recreated");
    expect(harness.contextEl.dataset.state).toBe("warn");
    expect(harness.onNewContent).toHaveBeenCalledOnce();
    expect(harness.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("updates streaming content immutably and finalizes its rendered marker", () => {
    const harness = createHarness();
    const original = assistantMessage("assistant-1", "");
    harness.controller.addMessage(original);

    harness.controller.updateStreamingMessage("Answer [1:05]");

    const updated = harness.panelState.chat.messages[0];
    expect(updated).not.toBe(original);
    expect(original.content).toBe("");
    expect(updated?.content).toEqual([{ type: "text", text: "Answer [1:05]" }]);
    const rendered = harness.messagesEl.querySelector<HTMLElement>('[data-id="assistant-1"]');
    expect(rendered?.classList.contains("streaming")).toBe(true);
    expect(rendered?.querySelector("a")?.getAttribute("href")).toBe("timestamp:65");

    harness.controller.finishStreamingMessage();

    expect(rendered?.classList.contains("streaming")).toBe(false);
    expect(rendered?.hasAttribute("data-placeholder")).toBe(false);
  });

  it("handles empty streaming updates and ignores non-assistant tails", () => {
    const harness = createHarness();
    harness.controller.addMessage(assistantMessage("assistant-1", "Initial"));

    harness.controller.updateStreamingMessage("");

    const rendered = harness.messagesEl.querySelector<HTMLElement>('[data-id="assistant-1"]');
    expect(rendered?.hasAttribute("data-placeholder")).toBe(true);
    expect(rendered?.querySelector(".chatTyping")).not.toBeNull();

    harness.controller.addMessage(userMessage("user-2", "Follow-up"));
    harness.controller.updateStreamingMessage("Ignored");
    harness.controller.finishStreamingMessage();

    expect(harness.panelState.chat.messages.at(-1)?.content).toBe("Follow-up");
  });

  it("updates canonical streaming state even when its DOM node is absent", () => {
    const harness = createHarness();
    harness.panelState.chat.messages = [assistantMessage("assistant-1", "")];

    harness.controller.updateStreamingMessage("Recovered");
    harness.controller.finishStreamingMessage();

    expect(harness.panelState.chat.messages[0]?.content).toEqual([
      { type: "text", text: "Recovered" },
    ]);
  });

  it("renders assistant tool calls, placeholders, timestamp failures, and external links", () => {
    const harness = createHarness();
    harness.controller.addMessage(
      assistantMessage("assistant-tools", [
        { type: "text", text: "Visit [site](https://example.com) [1:99]" },
        { type: "toolCall", id: "call-1", name: "navigate", arguments: { url: "/next" } },
      ] as never),
      { scroll: false },
    );
    harness.controller.addMessage(
      assistantMessage("assistant-tool-only", [
        { type: "toolCall", id: "call-2", name: "debugger", arguments: {} },
      ] as never),
      { scroll: false },
    );
    harness.controller.addMessage(
      { id: "assistant-empty", role: "assistant", content: undefined, timestamp: 3 } as never,
      { scroll: false },
    );

    const external = harness.messagesEl.querySelector<HTMLAnchorElement>(
      '[data-id="assistant-tools"] a',
    );
    const empty = harness.messagesEl.querySelector<HTMLElement>('[data-id="assistant-empty"]');
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener noreferrer");
    expect(harness.messagesEl.textContent).toContain("navigate");
    expect(harness.messagesEl.textContent).toContain("debugger");
    expect(harness.messagesEl.textContent).toContain("[1:99]");
    expect(empty?.hasAttribute("data-placeholder")).toBe(true);
  });

  it("renders tool result errors and valid attachments", () => {
    const harness = createHarness();
    const createObjectURL = vi.fn(() => "blob:attachment");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    harness.controller.addMessage(
      {
        id: "tool-1",
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "download",
        content: [{ type: "text", text: "created" }],
        isError: true,
        timestamp: 4,
        details: {
          files: [
            null,
            "invalid",
            { fileName: "", contentBase64: "" },
            { fileName: "report.txt", mimeType: "", contentBase64: "aGk=" },
          ],
        },
      } as never,
      { scroll: false },
    );
    harness.messagesEl.querySelector<HTMLButtonElement>(".chatAttachment")?.click();

    const rendered = harness.messagesEl.querySelector<HTMLElement>('[data-id="tool-1"]');
    expect(rendered?.classList.contains("tool")).toBe(true);
    expect(rendered?.classList.contains("error")).toBe(true);
    expect(rendered?.textContent).toContain("Tool result: download (error)");
    expect(rendered?.textContent).toContain("report.txt (file)");
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();

    harness.controller.addMessage(
      {
        id: "tool-2",
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "noop",
        content: [],
        isError: false,
        timestamp: 5,
      } as never,
      { scroll: false },
    );
    expect(harness.messagesEl.textContent).toContain("Tool result: noop");
  });

  it("resets canonical chat and form UI together", () => {
    const harness = createHarness();
    harness.controller.addMessage(userMessage());
    harness.panelState.chat.streaming = true;
    harness.inputEl.value = "draft";
    harness.sendBtn.disabled = true;

    harness.controller.reset();

    expect(harness.panelState.chat).toEqual({ messages: [], streaming: false });
    expect(harness.messagesEl.children).toHaveLength(0);
    expect(harness.messagesEl.classList.contains("isHidden")).toBe(true);
    expect(harness.inputEl.value).toBe("");
    expect(harness.sendBtn.disabled).toBe(false);
    expect(harness.contextEl.classList.contains("isHidden")).toBe(true);
  });
});
