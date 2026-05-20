import { afterEach, describe, expect, it, vi } from "vitest";
import automationContentScript from "../apps/chrome-extension/src/entrypoints/automation.content.js";

const installFlag = "__summarize_automation_installed__";

type TestGlobals = typeof globalThis & {
  chrome?: {
    runtime: {
      onMessage: { addListener: ReturnType<typeof vi.fn> };
      sendMessage: ReturnType<typeof vi.fn>;
    };
  };
  window?: {
    addEventListener: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
  [installFlag]?: unknown;
};

describe("automation content script install", () => {
  afterEach(() => {
    const globals = globalThis as TestGlobals;
    delete globals.chrome;
    delete globals.window;
    delete globals[installFlag];
  });

  it("registers runtime and native-input listeners only once across repeated injections", () => {
    const globals = globalThis as TestGlobals;
    const messageListeners: Array<(event: unknown) => void> = [];
    globals.window = {
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        if (type === "message") messageListeners.push(listener);
      }),
      postMessage: vi.fn(),
    };
    globals.chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn(),
      },
    };

    const script = automationContentScript as unknown as { main: () => void };
    script.main();
    script.main();

    expect(globals.window.addEventListener).toHaveBeenCalledTimes(1);
    expect(globals.chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);

    messageListeners[0]?.({
      source: globals.window,
      data: {
        source: "summarize-native-input",
        requestId: "req-1",
        capability: "c".repeat(32),
        payload: { action: "click" },
      },
    });

    expect(globals.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
