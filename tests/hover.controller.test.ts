import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHoverController } from "../apps/chrome-extension/src/entrypoints/background/hover-controller.js";
import { defaultSettings, type Settings } from "../apps/chrome-extension/src/lib/settings.js";

const mocks = vi.hoisted(() => ({
  fetchBrowserUrlContent: vi.fn(),
  loadSettings: vi.fn(),
  streamDirectModel: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/lib/browser-url-content.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../apps/chrome-extension/src/lib/browser-url-content.js")
    >();
  return {
    ...original,
    fetchBrowserUrlContent: mocks.fetchBrowserUrlContent,
  };
});

vi.mock("../apps/chrome-extension/src/lib/direct-provider.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../apps/chrome-extension/src/lib/direct-provider.js")>();
  return {
    ...original,
    streamDirectModel: mocks.streamDirectModel,
  };
});

vi.mock("../apps/chrome-extension/src/lib/settings.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../apps/chrome-extension/src/lib/settings.js")>();
  return {
    ...original,
    loadSettings: mocks.loadSettings,
  };
});

function makeSettings(overrides: Partial<Settings>): Settings {
  return {
    ...defaultSettings,
    ...overrides,
    providerApiKeys: overrides.providerApiKeys ?? defaultSettings.providerApiKeys,
    providerBaseUrls: overrides.providerBaseUrls ?? defaultSettings.providerBaseUrls,
  };
}

function installChromeMocks() {
  const sendMessage = vi.fn(async () => undefined);
  const query = vi.fn(async () => [{ id: 7, active: true, url: "https://example.com" }]);
  vi.stubGlobal("chrome", {
    tabs: {
      query,
      sendMessage,
    },
  });
  return { query, sendMessage };
}

function createController() {
  return createHoverController({
    hoverControllersByTabId: new Map(),
    buildDaemonRequestBody: vi.fn(() => ({})) as never,
    resolveLogLevel: () => "verbose",
  });
}

function sender(): chrome.runtime.MessageSender {
  return { tab: { id: 7, url: "https://example.com" } as chrome.tabs.Tab };
}

async function waitForResponse(sendResponse: ReturnType<typeof vi.fn>) {
  await expect.poll(() => sendResponse.mock.calls.length).toBeGreaterThan(0);
  return sendResponse.mock.calls.at(-1)?.[0] as { ok?: boolean; error?: string };
}

describe("hover controller token routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.fetchBrowserUrlContent.mockReset();
    mocks.loadSettings.mockReset();
    mocks.streamDirectModel.mockReset();
  });

  it("starts direct hover summaries without a daemon token", async () => {
    const chromeMocks = installChromeMocks();
    mocks.loadSettings.mockResolvedValue(
      makeSettings({
        token: "",
        summaryRuntime: "direct",
        provider: "ollama",
        model: "auto",
      }),
    );
    mocks.fetchBrowserUrlContent.mockResolvedValue({
      url: "https://example.com/article",
      title: "Article",
      text: "Article text",
    });
    mocks.streamDirectModel.mockImplementation(async function* () {
      yield { type: "text", text: "Direct hover" };
    });
    const controller = createController();
    const sendResponse = vi.fn();

    const handled = controller.handleRuntimeMessage(
      {
        type: "hover:summarize",
        requestId: "hover-1",
        url: "https://example.com/article",
        title: "Article",
      },
      sender(),
      sendResponse,
    );

    expect(handled).toBe(true);
    await expect.poll(() => chromeMocks.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await waitForResponse(sendResponse)).toEqual({ ok: true });
    expect(chromeMocks.sendMessage).toHaveBeenCalledWith(7, {
      type: "hover:chunk",
      requestId: "hover-1",
      url: "https://example.com/article",
      text: "Direct hover",
    });
    expect(chromeMocks.sendMessage).toHaveBeenCalledWith(7, {
      type: "hover:done",
      requestId: "hover-1",
      url: "https://example.com/article",
    });
  });

  it("still rejects daemon hover summaries without a daemon token", async () => {
    const chromeMocks = installChromeMocks();
    mocks.loadSettings.mockResolvedValue(
      makeSettings({
        token: "",
        summaryRuntime: "daemon",
      }),
    );
    const controller = createController();
    const sendResponse = vi.fn();

    const handled = controller.handleRuntimeMessage(
      {
        type: "hover:summarize",
        requestId: "hover-2",
        url: "https://example.com/article",
        title: "Article",
      },
      sender(),
      sendResponse,
    );

    expect(handled).toBe(true);
    expect(await waitForResponse(sendResponse)).toEqual({
      ok: false,
      error: "Setup required (missing token)",
    });
    expect(chromeMocks.sendMessage).toHaveBeenCalledWith(7, {
      type: "hover:error",
      requestId: "hover-2",
      url: "https://example.com/article",
      message: "Setup required (missing token)",
    });
    expect(mocks.fetchBrowserUrlContent).not.toHaveBeenCalled();
    expect(mocks.streamDirectModel).not.toHaveBeenCalled();
  });
});
