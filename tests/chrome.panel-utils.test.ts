import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSlidesText,
  formatSlideTimestamp,
  getActiveTab,
  openOptionsWindow,
  resolveOptionsUrl,
  urlsMatch,
} from "../apps/chrome-extension/src/entrypoints/background/panel-utils.js";

describe("chrome panel utils", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ options_ui: { page: "advanced.html" } }),
        getURL: (value: string) => `chrome-extension://test/${value}`,
        openOptionsPage: vi.fn(async () => {}),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: "https://example.com" }]),
      },
      windows: {
        getCurrent: vi.fn(async () => ({ width: 900, height: 620 })),
        create: vi.fn(async () => {}),
      },
    });
  });

  it("matches urls across hash and nested boundaries", () => {
    expect(urlsMatch("https://example.com/watch?v=1#now", "https://example.com/watch?v=1")).toBe(
      true,
    );
    expect(urlsMatch("https://example.com/watch?v=1&list=2", "https://example.com/watch?v=1")).toBe(
      true,
    );
    expect(urlsMatch("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(urlsMatch("https://example.com/watch?v=1", "notaurl")).toBe(false);
  });

  it("builds slide ocr text with timestamps", () => {
    expect(
      buildSlidesText(
        {
          sourceUrl: "https://example.com/video",
          sourceId: "video",
          sourceKind: "url",
          ocrAvailable: true,
          slides: [
            { index: 1, timestamp: 2, ocrText: "Opening slide" },
            { index: 2, timestamp: 65, ocrText: "Second slide" },
          ],
        },
        true,
      ),
    ).toEqual({
      count: 2,
      text: "Slide 1 @ 0:02:\nOpening slide\n\nSlide 2 @ 1:05:\nSecond slide",
    });
  });

  it("skips slide text when ocr is disabled", () => {
    expect(
      buildSlidesText(
        {
          sourceUrl: "https://example.com/video",
          sourceId: "video",
          sourceKind: "url",
          ocrAvailable: true,
          slides: [{ index: 1, timestamp: 2, ocrText: "Opening slide" }],
        },
        false,
      ),
    ).toBeNull();
  });

  it("stops after the ocr budget and skips empty slides", () => {
    expect(
      buildSlidesText(
        {
          sourceUrl: "https://example.com/video",
          sourceId: "video",
          sourceKind: "url",
          ocrAvailable: true,
          slides: [
            { index: 1, timestamp: 3723, ocrText: "First slide" },
            { index: 2, timestamp: 3728, ocrText: "   " },
            { index: 3, timestamp: Number.NaN, ocrText: "x".repeat(9000) },
          ],
        },
        true,
      ),
    ).toEqual({
      count: 3,
      text: "Slide 1 @ 1:02:03:\nFirst slide",
    });
  });

  it("resolves and opens the options popup with a fallback", async () => {
    expect(resolveOptionsUrl()).toBe("chrome-extension://test/advanced.html");
    await openOptionsWindow();

    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: "chrome-extension://test/advanced.html",
      type: "popup",
      width: 880,
      height: 600,
    });

    vi.mocked(chrome.windows.create).mockRejectedValueOnce(new Error("boom"));
    await openOptionsWindow();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it("gets the active tab for either the current or a specific window", async () => {
    await expect(getActiveTab()).resolves.toMatchObject({ id: 1 });
    await expect(getActiveTab(7)).resolves.toMatchObject({ id: 1 });
    expect(chrome.tabs.query).toHaveBeenNthCalledWith(1, { active: true, currentWindow: true });
    expect(chrome.tabs.query).toHaveBeenNthCalledWith(2, { active: true, windowId: 7 });
  });

  it("falls back to a real content tab when the active tab is the extension page", async () => {
    vi.mocked(chrome.tabs.query)
      .mockResolvedValueOnce([{ id: 9, url: "chrome-extension://test/sidepanel.html" }])
      .mockResolvedValueOnce([
        { id: 9, url: "chrome-extension://test/sidepanel.html" },
        { id: 3, url: "https://example.com/article" },
      ]);

    await expect(getActiveTab(7)).resolves.toMatchObject({
      id: 3,
      url: "https://example.com/article",
    });
    expect(chrome.tabs.query).toHaveBeenNthCalledWith(1, { active: true, windowId: 7 });
    expect(chrome.tabs.query).toHaveBeenNthCalledWith(2, { windowId: 7 });
  });

  it("formats slide timestamps for minutes and hours", () => {
    expect(formatSlideTimestamp(65)).toBe("1:05");
    expect(formatSlideTimestamp(3723)).toBe("1:02:03");
  });
});
