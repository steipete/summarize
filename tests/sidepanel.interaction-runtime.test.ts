import { describe, expect, it, vi } from "vitest";
import { createSidepanelInteractionRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/interaction-runtime";

function createHarness() {
  const state = {
    rawInput: "",
    cleared: 0,
    restored: "",
    height: "",
    queueLength: 0,
    chatStreaming: false,
    customHidden: false,
  };
  const spies = {
    enqueueChatMessage: vi.fn(() => true),
    maybeSendQueuedChat: vi.fn(),
    startChatMessage: vi.fn(),
    updateModelRowUI: vi.fn(),
    focusCustomModel: vi.fn(),
    blurCustomModel: vi.fn(),
  };
  const typographyController = {
    clampFontSize: vi.fn((value: number) => value),
    getCurrentFontSize: vi.fn(() => 14),
    apply: vi.fn(),
    setCurrentFontSize: vi.fn(),
    setCurrentLineHeight: vi.fn(),
    clampLineHeight: vi.fn((value: number) => value),
    getCurrentLineHeight: vi.fn(() => 1.4),
  };
  const patchSettings = vi.fn(async (value: Record<string, unknown>) => ({
    fontFamily: "IBM Plex Sans",
    fontSize: typeof value.fontSize === "number" ? value.fontSize : 15,
    lineHeight: typeof value.lineHeight === "number" ? value.lineHeight : 1.5,
  }));
  const runtime = createSidepanelInteractionRuntime({
    chatEnabled: vi.fn(() => true),
    getRawChatInput: vi.fn(() => state.rawInput),
    clearChatInput: vi.fn(() => {
      state.rawInput = "";
      state.cleared += 1;
    }),
    restoreChatInput: vi.fn((value: string) => {
      state.restored = value;
      state.rawInput = value;
    }),
    getChatInputScrollHeight: vi.fn(() => 180),
    setChatInputHeight: vi.fn((value: string) => {
      state.height = value;
    }),
    isChatStreaming: vi.fn(() => state.chatStreaming),
    getQueuedChatCount: vi.fn(() => state.queueLength),
    enqueueChatMessage: spies.enqueueChatMessage,
    maybeSendQueuedChat: spies.maybeSendQueuedChat,
    startChatMessage: spies.startChatMessage,
    typographyController,
    patchSettings,
    updateModelRowUI: spies.updateModelRowUI,
    isCustomModelHidden: vi.fn(() => state.customHidden),
    focusCustomModel: spies.focusCustomModel,
    blurCustomModel: spies.blurCustomModel,
    readCurrentModelValue: vi.fn(() => "openai/gpt-5.4"),
  });
  return { runtime, state, spies, typographyController, patchSettings };
}

describe("sidepanel interaction runtime", () => {
  it("starts chat immediately when idle", () => {
    const harness = createHarness();
    harness.state.rawInput = "  hello there  ";

    harness.runtime.sendChatMessage();

    expect(harness.state.cleared).toBe(1);
    expect(harness.spies.startChatMessage).toHaveBeenCalledWith("hello there");
  });

  it("restores chat input when queueing fails", () => {
    const harness = createHarness();
    harness.state.rawInput = "queued";
    harness.state.chatStreaming = true;
    harness.spies.enqueueChatMessage.mockReturnValueOnce(false);

    harness.runtime.sendChatMessage();

    expect(harness.state.restored).toBe("queued");
    expect(harness.state.height).toBe("120px");
    expect(harness.spies.maybeSendQueuedChat).not.toHaveBeenCalled();
  });

  it("kicks queued chat when not streaming but queue already has items", () => {
    const harness = createHarness();
    harness.state.rawInput = "queued";
    harness.state.queueLength = 1;

    harness.runtime.sendChatMessage();

    expect(harness.spies.enqueueChatMessage).toHaveBeenCalledWith("queued");
    expect(harness.spies.maybeSendQueuedChat).toHaveBeenCalledTimes(1);
  });

  it("updates typography and model settings", async () => {
    const harness = createHarness();

    harness.runtime.bumpFontSize(2);
    harness.runtime.bumpLineHeight(0.2);
    harness.runtime.persistCurrentModel({ focusCustom: true, blurCustom: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.patchSettings).toHaveBeenCalledWith({ fontSize: 16 });
    expect(harness.patchSettings).toHaveBeenCalledWith({ lineHeight: 1.5999999999999999 });
    expect(harness.patchSettings).toHaveBeenCalledWith({ model: "openai/gpt-5.4" });
    expect(harness.typographyController.apply).toHaveBeenCalled();
    expect(harness.spies.focusCustomModel).toHaveBeenCalledTimes(1);
    expect(harness.spies.blurCustomModel).toHaveBeenCalledTimes(1);
  });

  it("skips hidden custom model focus and disabled chat input", () => {
    const harness = createHarness();
    harness.state.customHidden = true;
    harness.runtime.persistCurrentModel({ focusCustom: true });
    harness.state.rawInput = "hello";
    const disabledRuntime = createSidepanelInteractionRuntime({
      chatEnabled: vi.fn(() => false),
      getRawChatInput: vi.fn(() => "hello"),
      clearChatInput: vi.fn(),
      restoreChatInput: vi.fn(),
      getChatInputScrollHeight: vi.fn(() => 40),
      setChatInputHeight: vi.fn(),
      isChatStreaming: vi.fn(() => false),
      getQueuedChatCount: vi.fn(() => 0),
      enqueueChatMessage: vi.fn(() => true),
      maybeSendQueuedChat: vi.fn(),
      startChatMessage: vi.fn(),
      typographyController: harness.typographyController,
      patchSettings: harness.patchSettings,
      updateModelRowUI: vi.fn(),
      isCustomModelHidden: vi.fn(() => true),
      focusCustomModel: vi.fn(),
      blurCustomModel: vi.fn(),
      readCurrentModelValue: vi.fn(() => "openai/gpt-5.4"),
    });

    disabledRuntime.sendChatMessage();

    expect(harness.spies.focusCustomModel).not.toHaveBeenCalled();
  });
});
