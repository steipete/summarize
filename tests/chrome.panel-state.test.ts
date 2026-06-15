import { describe, expect, it, vi } from "vitest";
import { resolvePanelState } from "../apps/chrome-extension/src/entrypoints/background/panel-state.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

function createSession() {
  return {
    windowId: 1,
    runController: null,
    agentController: null,
    inflightUrl: null,
    daemonRecovery: {
      getPendingUrl: () => null,
      maybeRecover: vi.fn(() => false),
      updateStatus: vi.fn(),
    },
    daemonStatus: {
      resolve: vi.fn((state) => state),
    },
  };
}

describe("chrome panel state", () => {
  it("does not probe localhost when no daemon token is configured", async () => {
    const daemonHealth = vi.fn(async () => ({ ok: true }));
    const daemonPing = vi.fn(async () => ({ ok: true }));

    const result = await resolvePanelState({
      session: createSession(),
      status: "",
      loadSettings: vi.fn(async () => ({ ...defaultSettings, token: "" })),
      getActiveTab: vi.fn(async () => null),
      daemonHealth,
      daemonPing,
      panelSessionStore: {
        isPanelOpen: () => true,
        getCachedExtract: () => null,
      },
      urlsMatch: (left, right) => left === right,
      canSummarizeUrl: () => false,
    });

    expect(daemonHealth).not.toHaveBeenCalled();
    expect(daemonPing).not.toHaveBeenCalled();
    expect(result.state.daemon).toMatchObject({ ok: false, authed: false });
  });
});
