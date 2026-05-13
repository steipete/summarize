import { describe, expect, it, vi } from "vitest";
import { bindBackgroundListeners } from "../apps/chrome-extension/src/entrypoints/background/listeners";

function installChromeListenerStubs() {
  const onMessage = { addListener: vi.fn() };
  const onUserScriptMessage = { addListener: vi.fn() };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onConnect: { addListener: vi.fn() },
      onMessage,
      onUserScriptMessage,
    },
    storage: { onChanged: { addListener: vi.fn() } },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
    tabs: {
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
  };
  return { onMessage, onUserScriptMessage };
}

describe("background userScripts runtime messages", () => {
  it("routes userScripts messages through runtime actions", () => {
    const { onUserScriptMessage } = installChromeListenerStubs();
    const runtimeActionsHandler = vi.fn(() => true);
    const hoverRuntimeHandler = vi.fn(() => false);

    bindBackgroundListeners({
      panelSessionStore: {
        registerPanelSession: vi.fn(),
        deletePanelSession: vi.fn(),
        getPanelSession: vi.fn(() => null),
        getPanelSessions: vi.fn(() => []),
        clearCachedExtractsForWindow: vi.fn(async () => undefined),
        clearTab: vi.fn(),
      },
      handlePanelMessage: vi.fn(),
      onPanelDisconnect: vi.fn(),
      runtimeActionsHandler,
      hoverRuntimeHandler,
      emitState: vi.fn(),
      summarizeActiveTab: vi.fn(),
      onTabRemoved: vi.fn(),
    });

    const listener = onUserScriptMessage.addListener.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf("function");
    const sendResponse = vi.fn();
    const result = listener?.(
      { type: "automation:artifacts", action: "listArtifacts" },
      { tab: { id: 123 } },
      sendResponse,
    );

    expect(result).toBe(true);
    expect(runtimeActionsHandler).toHaveBeenCalledWith(
      { type: "automation:artifacts", action: "listArtifacts" },
      { tab: { id: 123 } },
      sendResponse,
    );
    expect(hoverRuntimeHandler).not.toHaveBeenCalled();
  });
});
