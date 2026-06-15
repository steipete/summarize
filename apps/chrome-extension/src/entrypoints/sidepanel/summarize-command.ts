export function createSummarizeCommand({
  send,
  setLastAction,
  clearInlineError,
  getInputModeOverride,
  prepareBrowserAi,
}: {
  send: (message: {
    type: "panel:summarize";
    refresh: boolean;
    inputMode?: "page" | "video";
  }) => Promise<void>;
  setLastAction: (value: "summarize") => void;
  clearInlineError: () => void;
  getInputModeOverride: () => "page" | "video" | null;
  prepareBrowserAi?: () => void;
}) {
  return (options?: { refresh?: boolean }) => {
    clearInlineError();
    setLastAction("summarize");
    prepareBrowserAi?.();
    void send({
      type: "panel:summarize",
      refresh: Boolean(options?.refresh),
      inputMode: getInputModeOverride() ?? undefined,
    });
  };
}
