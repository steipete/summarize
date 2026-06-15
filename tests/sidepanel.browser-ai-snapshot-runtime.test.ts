import { describe, expect, it, vi } from "vitest";
import { createBrowserAiSnapshotRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/browser-ai-snapshot-runtime";
import {
  applyPanelStateAction,
  createInitialPanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

describe("sidepanel browser AI snapshot runtime", () => {
  it("upgrades the current extractive snapshot and records Gemini Nano metadata", async () => {
    const panelState = createInitialPanelState();
    panelState.runId = "run-1";
    panelState.currentSource = { url: "https://example.com", title: "Example" };
    const renderMarkdown = vi.fn();
    const runtime = createBrowserAiSnapshotRuntime({
      panelState,
      dispatchPanelState: (action) => applyPanelStateAction(panelState, action),
      browserAi: {
        cancel: vi.fn(),
        summarize: vi.fn(async () => "- First point\n- Second point"),
      },
      renderMarkdown,
    });

    runtime.enhance({
      type: "run:snapshot",
      run: {
        id: "run-1",
        url: "https://example.com",
        title: "Example",
        model: "Browser",
        reason: "manual",
      },
      markdown: "Fallback",
      browserAi: {
        text: "Source",
        length: "medium",
        keyMoments: [],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(panelState.lastMeta.model).toBe("Gemini Nano");
    expect(renderMarkdown).toHaveBeenCalledWith(expect.stringContaining("- First point"));
  });

  it("drops a Nano result after the active run changes", async () => {
    const panelState = createInitialPanelState();
    panelState.runId = "run-1";
    panelState.currentSource = { url: "https://example.com", title: "Example" };
    let resolveSummary: (value: string) => void = () => {};
    const summaryPromise = new Promise<string>((resolve) => {
      resolveSummary = resolve;
    });
    const renderMarkdown = vi.fn();
    const runtime = createBrowserAiSnapshotRuntime({
      panelState,
      dispatchPanelState: (action) => applyPanelStateAction(panelState, action),
      browserAi: {
        cancel: vi.fn(),
        summarize: vi.fn(async () => await summaryPromise),
      },
      renderMarkdown,
    });

    runtime.enhance({
      type: "run:snapshot",
      run: {
        id: "run-1",
        url: "https://example.com",
        title: "Example",
        model: "Browser",
        reason: "manual",
      },
      markdown: "Fallback",
      browserAi: { text: "Source", length: "short", keyMoments: [] },
    });
    panelState.runId = "run-2";
    resolveSummary("Stale summary");
    await Promise.resolve();
    await Promise.resolve();

    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(panelState.lastMeta.model).toBeNull();
  });
});
