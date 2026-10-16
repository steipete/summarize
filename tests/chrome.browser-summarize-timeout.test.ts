import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBrowserUrlContent: vi.fn(),
  loadSettings: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/lib/browser-url-content", () => ({
  fetchBrowserUrlContent: mocks.fetchBrowserUrlContent,
}));

vi.mock("../apps/chrome-extension/src/lib/settings", () => ({
  loadSettings: mocks.loadSettings,
  getProviderSettings: () => ({}),
}));

import { executeSummarizeTool } from "../apps/chrome-extension/src/automation/tools/summarize";

describe("browser summarize fetch deadline", () => {
  it.each([
    [undefined, undefined, 120_000],
    [undefined, "3m", 180_000],
    ["500ms", "3m", 500],
    ["1.5", undefined, 1500],
  ] as const)(
    "honors the effective fetch timeout (%s, %s)",
    async (timeout, savedTimeout, expectedMs) => {
      const createTimeout = vi.spyOn(AbortSignal, "timeout");
      mocks.loadSettings.mockResolvedValue({
        model: "browser/gemini-nano",
        length: "short",
        language: "en",
        promptOverride: "",
        maxOutputTokens: "",
        maxChars: 1000,
        token: "",
        summaryRuntime: "direct",
        provider: "openai",
        providerApiKeys: {},
        timeout: savedTimeout,
      });
      mocks.fetchBrowserUrlContent.mockResolvedValue({
        text: "hello",
        url: "https://example.com/article",
        title: "Article",
        truncated: false,
      });

      await executeSummarizeTool({
        url: "https://example.com/article",
        extractOnly: true,
        timeout,
      });

      const options = mocks.fetchBrowserUrlContent.mock.calls[0]?.[0] as { signal?: AbortSignal };
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal?.aborted).toBe(false);
      expect(createTimeout).toHaveBeenLastCalledWith(expectedMs);
      createTimeout.mockRestore();
    },
  );
});
