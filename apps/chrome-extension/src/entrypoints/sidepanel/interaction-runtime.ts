type PatchSettingsResult = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

export function createSidepanelInteractionRuntime(options: {
  chatEnabled: () => boolean;
  getRawChatInput: () => string;
  clearChatInput: () => void;
  restoreChatInput: (value: string) => void;
  getChatInputScrollHeight: () => number;
  setChatInputHeight: (value: string) => void;
  isChatStreaming: () => boolean;
  getQueuedChatCount: () => number;
  enqueueChatMessage: (value: string) => boolean;
  maybeSendQueuedChat: () => void;
  startChatMessage: (value: string) => void;
  typographyController: {
    clampFontSize: (value: number) => number;
    getCurrentFontSize: () => number;
    apply: (fontFamily: string, fontSize: number, lineHeight: number) => void;
    setCurrentFontSize: (value: number) => void;
    setCurrentLineHeight: (value: number) => void;
    clampLineHeight: (value: number) => number;
    getCurrentLineHeight: () => number;
  };
  patchSettings: (value: Record<string, unknown>) => Promise<PatchSettingsResult>;
  updateModelRowUI: () => void;
  isCustomModelHidden: () => boolean;
  focusCustomModel: () => void;
  blurCustomModel: () => void;
  readCurrentModelValue: () => string;
}) {
  function sendChatMessage() {
    if (!options.chatEnabled()) return;
    const rawInput = options.getRawChatInput();
    const input = rawInput.trim();
    if (!input) return;

    options.clearChatInput();

    const chatBusy = options.isChatStreaming();
    if (chatBusy || options.getQueuedChatCount() > 0) {
      const queued = options.enqueueChatMessage(input);
      if (!queued) {
        options.restoreChatInput(rawInput);
        options.setChatInputHeight(`${Math.min(options.getChatInputScrollHeight(), 120)}px`);
      } else if (!chatBusy) {
        options.maybeSendQueuedChat();
      }
      return;
    }

    options.startChatMessage(input);
  }

  const bumpFontSize = (delta: number) => {
    void (async () => {
      const nextSize = options.typographyController.clampFontSize(
        options.typographyController.getCurrentFontSize() + delta,
      );
      const next = await options.patchSettings({ fontSize: nextSize });
      options.typographyController.apply(next.fontFamily, next.fontSize, next.lineHeight);
      options.typographyController.setCurrentFontSize(next.fontSize);
      options.typographyController.setCurrentLineHeight(next.lineHeight);
    })();
  };

  const bumpLineHeight = (delta: number) => {
    void (async () => {
      const nextHeight = options.typographyController.clampLineHeight(
        options.typographyController.getCurrentLineHeight() + delta,
      );
      const next = await options.patchSettings({ lineHeight: nextHeight });
      options.typographyController.apply(next.fontFamily, next.fontSize, next.lineHeight);
      options.typographyController.setCurrentLineHeight(next.lineHeight);
    })();
  };

  const persistCurrentModel = (opts?: { focusCustom?: boolean; blurCustom?: boolean }) => {
    options.updateModelRowUI();
    if (opts?.focusCustom && !options.isCustomModelHidden()) options.focusCustomModel();
    if (opts?.blurCustom) options.blurCustomModel();
    void (async () => {
      await options.patchSettings({ model: options.readCurrentModelValue() });
    })();
  };

  return {
    sendChatMessage,
    bumpFontSize,
    bumpLineHeight,
    persistCurrentModel,
  };
}
