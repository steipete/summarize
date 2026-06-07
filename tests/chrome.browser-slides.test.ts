import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserSlidesForTab } from "../apps/chrome-extension/src/entrypoints/background/browser-slides";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

describe("chrome browser slide capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: originalOffscreenCanvas,
    });
  });

  it("captures the current frame without seek setup or restore", async () => {
    const query = vi.fn(async () => [{ id: 7, url: "https://example.com/video" }]);
    const captureVisibleTab = vi.fn(async () => "data:image/png;base64,abc");
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        tabs: { query, captureVisibleTab },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => ({ blob: async () => new Blob(["image"]) })),
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 640, height: 360 })),
    });
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn() };
        }
        async convertToBlob() {
          return new Blob(["thumb"], { type: "image/jpeg" });
        }
      },
    });
    const beginFrameCapture = vi.fn(async () => ({ ok: true as const, state: null }));
    const prepareFrame = vi.fn(async () => ({
      ok: true as const,
      data: {
        ok: true as const,
        url: "https://example.com/video",
        title: "Video",
        durationSeconds: 6,
        currentTimeSeconds: 3,
        rect: { x: 0, y: 0, width: 640, height: 360 },
        devicePixelRatio: 1,
      },
    }));
    const prepareCurrentFrame = vi.fn(async () => ({
      ok: true as const,
      data: {
        ok: true as const,
        url: "https://example.com/video",
        title: "Video",
        durationSeconds: 6,
        currentTimeSeconds: 3,
        rect: { x: 0, y: 0, width: 640, height: 360 },
        devicePixelRatio: 1,
      },
    }));
    const restoreFrame = vi.fn(async () => ({ ok: true as const }));

    const result = await runBrowserSlidesForTab({
      tab: { id: 7, url: "https://example.com/video" },
      windowId: 1,
      captureMode: "current",
      beginFrameCapture,
      prepareFrame,
      prepareCurrentFrame,
      restoreFrame,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slides.slides).toHaveLength(1);
      expect(result.slides.slides[0]?.timestamp).toBe(3);
    }
    expect(beginFrameCapture).not.toHaveBeenCalled();
    expect(prepareFrame).not.toHaveBeenCalled();
    expect(prepareCurrentFrame).toHaveBeenCalledWith(7);
    expect(restoreFrame).not.toHaveBeenCalled();
  });

  it("cancels before visible-tab capture when the active tab changes and restores the video", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 7, url: "https://example.com/video" }])
      .mockResolvedValueOnce([{ id: 9, url: "https://example.com/other" }]);
    const captureVisibleTab = vi.fn(async () => "data:image/png;base64,abc");
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        tabs: { query, captureVisibleTab },
      },
    });
    const restoreFrame = vi.fn(async () => ({ ok: true as const }));

    const result = await runBrowserSlidesForTab({
      tab: { id: 7, url: "https://example.com/video" },
      windowId: 1,
      maxSlides: 1,
      prepareFrame: vi.fn(async () => ({
        ok: true as const,
        data: {
          ok: true as const,
          url: "https://example.com/video",
          title: "Video",
          durationSeconds: 6,
          rect: { x: 0, y: 0, width: 640, height: 360 },
          devicePixelRatio: 1,
        },
      })),
      restoreFrame,
    });

    expect(result).toEqual({
      ok: false,
      error: "Slide capture cancelled because the active tab changed.",
    });
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(restoreFrame).toHaveBeenCalledWith(7, null);
  });

  it("cancels before visible-tab capture when the active tab navigates", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ id: 7, url: "https://example.com/video" }])
      .mockResolvedValueOnce([{ id: 7, url: "https://example.com/other" }]);
    const captureVisibleTab = vi.fn(async () => "data:image/png;base64,abc");
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        tabs: { query, captureVisibleTab },
      },
    });

    const result = await runBrowserSlidesForTab({
      tab: { id: 7, url: "https://example.com/video" },
      windowId: 1,
      maxSlides: 1,
      prepareFrame: vi.fn(async () => ({
        ok: true as const,
        data: {
          ok: true as const,
          url: "https://example.com/video",
          title: "Video",
          durationSeconds: 6,
          rect: { x: 0, y: 0, width: 640, height: 360 },
          devicePixelRatio: 1,
        },
      })),
      restoreFrame: vi.fn(async () => ({ ok: true as const })),
    });

    expect(result).toEqual({
      ok: false,
      error: "Slide capture cancelled because the active tab changed.",
    });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
});
