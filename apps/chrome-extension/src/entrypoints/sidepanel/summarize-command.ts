export function createSummarizeCommand({
  send,
  setLastAction,
  clearInlineError,
  getInputModeOverride,
}: {
  send: (message: {
    type: "panel:summarize";
    refresh: boolean;
    inputMode?: "page" | "video";
  }) => Promise<void>;
  setLastAction: (value: "summarize") => void;
  clearInlineError: () => void;
  getInputModeOverride: () => "page" | "video" | null;
}) {
  return (options?: { refresh?: boolean }) => {
    clearInlineError();
    setLastAction("summarize");
    void send({
      type: "panel:summarize",
      refresh: Boolean(options?.refresh),
      inputMode: getInputModeOverride() ?? undefined,
    });
  };
}
