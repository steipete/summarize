import { describe, expect, it, vi } from "vitest";
import { ensureChatExtract } from "../apps/chrome-extension/src/entrypoints/background/extract-cache.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

describe("browser chat extraction", () => {
  it.each(["https://www.youtube.com/watch?v=example", "https://example.com/article"])(
    "never falls back to the daemon without browser context for %s",
    async (url) => {
      const daemonFetchImpl = vi.fn();
      const extractFromTab = vi.fn(async () => ({ ok: false as const, error: "No content" }));

      await expect(
        ensureChatExtract({
          tab: { id: 7, url },
          settings: { ...defaultSettings, slideRuntime: "browser", token: "old-daemon-token" },
          panelSessionStore: {
            getCachedExtract: () => null,
            setCachedExtract: vi.fn(),
            getLastMediaProbe: () => null,
            rememberMediaProbe: vi.fn(),
          },
          sendStatus: vi.fn(),
          extractFromTab,
          fetchImpl: vi.fn(),
          daemonFetchImpl,
        }),
      ).rejects.toThrow(/browser.*context/i);
      expect(daemonFetchImpl).not.toHaveBeenCalled();
    },
  );
});
