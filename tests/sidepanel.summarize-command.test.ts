import { describe, expect, it, vi } from "vitest";
import { createSummarizeCommand } from "../apps/chrome-extension/src/entrypoints/sidepanel/summarize-command";

describe("sidepanel summarize command", () => {
  it("clears errors, records the action, and sends normalized options", async () => {
    const send = vi.fn(async () => {});
    const setLastAction = vi.fn();
    const clearInlineError = vi.fn();
    const summarize = createSummarizeCommand({
      send,
      setLastAction,
      clearInlineError,
      getInputModeOverride: () => "video",
    });

    summarize({ refresh: true });
    await Promise.resolve();

    expect(clearInlineError).toHaveBeenCalledOnce();
    expect(setLastAction).toHaveBeenCalledWith("summarize");
    expect(send).toHaveBeenCalledWith({
      type: "panel:summarize",
      refresh: true,
      inputMode: "video",
    });
  });

  it("omits an unset input override", async () => {
    const send = vi.fn(async () => {});
    const summarize = createSummarizeCommand({
      send,
      setLastAction: vi.fn(),
      clearInlineError: vi.fn(),
      getInputModeOverride: () => null,
    });

    summarize();
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith({
      type: "panel:summarize",
      refresh: false,
      inputMode: undefined,
    });
  });
});
