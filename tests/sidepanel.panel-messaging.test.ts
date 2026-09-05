import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelMessagingRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-messaging";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { SseSlidesData } from "../apps/chrome-extension/src/lib/runtime-contracts";

describe("sidepanel panel messaging runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("tracks user actions only for normal sends", async () => {
    const panelStateStore = createInitialPanelState();
    const send = vi.fn(async () => {});
    const runtime = createPanelMessagingRuntime({
      panelState: panelStateStore,

      onMessage: vi.fn(),
      portRuntime: {
        ensure: async () => null,
        send,
      },
    });

    await runtime.send({ type: "panel:summarize", refresh: true });
    expect(panelStateStore.panelSession.lastAction).toBe("summarize");

    await runtime.sendRaw({
      type: "panel:agent",
      requestId: "agent-1",
      messages: [],
      tools: [],
    });
    expect(panelStateStore.panelSession.lastAction).toBe("summarize");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("resolves matching local slides responses and ignores stale responses", async () => {
    const panelState = createInitialPanelState();
    const send = vi.fn(async () => {});
    const runtime = createPanelMessagingRuntime({
      panelState,
      onMessage: vi.fn(),
      portRuntime: {
        ensure: async () => null,
        send,
      },
      createRequestId: () => "local-1",
    });
    const slides: SseSlidesData = {
      sourceId: "source-1",
      sourceKind: "video",
      slides: [],
    };

    const pending = runtime.resolveLocalSlides("run-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({
      type: "panel:slides-local",
      requestId: "local-1",
      runId: "run-1",
    });

    runtime.handleLocalSlidesResponse({
      type: "slides:local",
      requestId: "stale",
      ok: true,
      slides,
    });
    runtime.handleLocalSlidesResponse({
      type: "slides:local",
      requestId: "local-1",
      ok: true,
      slides,
    });

    await expect(pending).resolves.toEqual(slides);
  });

  it("resolves local slide requests to null after the timeout", async () => {
    const runtime = createPanelMessagingRuntime({
      panelState: createInitialPanelState(),
      onMessage: vi.fn(),
      portRuntime: {
        ensure: async () => null,
        send: async () => {},
      },
      createRequestId: () => "local-timeout",
      localSlidesTimeoutMs: 25,
    });

    const pending = runtime.resolveLocalSlides("run-1");
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toBeNull();
  });
});
