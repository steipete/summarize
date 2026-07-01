// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlideImageLoader as createNativeSlideImageLoader } from "../apps/chrome-extension/src/entrypoints/sidepanel/slide-images";
import type { Settings } from "../apps/chrome-extension/src/lib/settings";

const originalFetch = globalThis.fetch;
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalIntersectionObserver = globalThis.IntersectionObserver;

const createSlideImageLoader = (options: Parameters<typeof createNativeSlideImageLoader>[0] = {}) =>
  createNativeSlideImageLoader({
    ...options,
    fetchImpl: (...args) => fetch(...args),
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  globalThis.IntersectionObserver = originalIntersectionObserver;
  vi.useRealTimers();
  document.body.replaceChildren();
});

const waitUntil = async (assertion: () => void, timeoutMs = 4000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
};

const mockCreateObjectUrl = (impl: () => string) => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(impl),
  });
};

const createSlideFetchResponse = ({
  ready,
  body,
  status = 200,
}: {
  ready: "0" | "1";
  body: string;
  status?: number;
}) => {
  const blob = new Blob([body], { type: "image/png" });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "x-summarize-slide-ready" ? ready : null),
    },
    blob: async () => blob,
  } satisfies Pick<Response, "ok" | "status" | "headers" | "blob">;
};

describe("slide image loader", () => {
  it("loads images when ready", async () => {
    globalThis.IntersectionObserver = undefined;
    globalThis.fetch = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    mockCreateObjectUrl(() => "blob:mock");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/1");
    expect(wrapper.classList.contains("isPlaceholder")).toBe(true);
    await waitUntil(() => {
      expect(img.getAttribute("src")).toBe("blob:mock");
    });
    img.dispatchEvent(new Event("load"));
    expect(img.dataset.loaded).toBe("true");
    expect(wrapper.classList.contains("isPlaceholder")).toBe(false);
  });

  it("schedules retries when slide is not ready", async () => {
    globalThis.IntersectionObserver = undefined;
    globalThis.fetch = vi.fn(async () => createSlideFetchResponse({ ready: "0", body: "wait" }));
    mockCreateObjectUrl(() => "blob:mock");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/2");
    await waitUntil(() => {
      expect(img.dataset.slideRetryCount).toBe("1");
    });
    expect(img.src).toBe("");
  });

  it("reuses cached images for subsequent elements", async () => {
    globalThis.IntersectionObserver = undefined;
    const fetchSpy = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    globalThis.fetch = fetchSpy;
    mockCreateObjectUrl(() => "blob:cache");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const url = "http://127.0.0.1:8787/v1/slides/abc/3";

    const wrapper1 = document.createElement("div");
    wrapper1.className = "slideStrip__thumb";
    const img1 = document.createElement("img");
    wrapper1.appendChild(img1);
    document.body.appendChild(wrapper1);

    loader.observe(img1, url);
    await waitUntil(() => {
      expect(img1.getAttribute("src")).toBe("blob:cache");
    });
    img1.dispatchEvent(new Event("load"));

    const wrapper2 = document.createElement("div");
    wrapper2.className = "slideStrip__thumb";
    const img2 = document.createElement("img");
    wrapper2.appendChild(img2);
    document.body.appendChild(wrapper2);

    loader.observe(img2, url);
    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(img2.getAttribute("src")).toBe("blob:cache");
    });
  });

  it("clears the previous image before loading a changed slide URL", async () => {
    globalThis.IntersectionObserver = undefined;
    let responseBody = "first";
    const fetchSpy = vi.fn(async () =>
      createSlideFetchResponse({ ready: responseBody === "first" ? "1" : "0", body: responseBody }),
    );
    globalThis.fetch = fetchSpy;
    const objectUrls = ["blob:first", "blob:second"];
    mockCreateObjectUrl(() => objectUrls.shift() ?? "blob:next");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/1?v=1");
    await waitUntil(() => {
      expect(img.getAttribute("src")).toBe("blob:first");
    });
    img.dispatchEvent(new Event("load"));
    expect(img.dataset.loaded).toBe("true");

    responseBody = "second";
    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/1?v=2");

    expect(img.getAttribute("src")).toBeNull();
    expect(img.dataset.loaded).toBe("false");
    expect(wrapper.classList.contains("isPlaceholder")).toBe(true);
    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(img.dataset.slideRetryCount).toBe("1");
    });
  });

  it("skips fetch when token is missing", async () => {
    globalThis.IntersectionObserver = undefined;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "", daemonPort: "8787", extendedLogging: true }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/4");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(img.getAttribute("src")).toBeNull();
  });

  it("defers loading until intersecting", async () => {
    let observer: { trigger: (entries: IntersectionObserverEntry[]) => void } | null = null;

    class MockIntersectionObserver {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observer = this;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      trigger(entries: IntersectionObserverEntry[]) {
        this.callback(entries, this);
      }
    }

    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchSpy = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    globalThis.fetch = fetchSpy;
    mockCreateObjectUrl(() => "blob:io");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/5");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();

    observer?.trigger([{ isIntersecting: false, target: img } as IntersectionObserverEntry]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).not.toHaveBeenCalled();

    observer?.trigger([{ isIntersecting: true, target: img } as IntersectionObserverEntry]);
    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(img.getAttribute("src")).toBe("blob:io");
    });
  });

  it("loads immediately when the image is already in the viewport", async () => {
    let observerInstanceCount = 0;

    class MockIntersectionObserver {
      constructor(_callback: IntersectionObserverCallback) {
        observerInstanceCount += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }

    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchSpy = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    globalThis.fetch = fetchSpy;
    mockCreateObjectUrl(() => "blob:visible");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 120,
      height: 68,
      top: 10,
      right: 120,
      bottom: 78,
      left: 0,
      toJSON: () => ({}),
    });
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/visible");

    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(img.getAttribute("src")).toBe("blob:visible");
    });
    expect(observerInstanceCount).toBe(1);
  });

  it("rechecks armed images when layout settles without an intersection callback", async () => {
    vi.useFakeTimers();

    class MockIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }

    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchSpy = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    globalThis.fetch = fetchSpy;
    mockCreateObjectUrl(() => "blob:late-visible");

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    const rectSpy = vi.spyOn(img, "getBoundingClientRect");
    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/lazy");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchSpy).not.toHaveBeenCalled();

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 120,
      height: 68,
      top: 20,
      right: 120,
      bottom: 88,
      left: 0,
      toJSON: () => ({}),
    });

    await vi.advanceTimersByTimeAsync(25);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(img.getAttribute("src")).toBe("blob:late-visible");
  });

  it("stops retrying when the retry window has elapsed", async () => {
    globalThis.IntersectionObserver = undefined;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => createSlideFetchResponse({ ready: "0", body: "wait" }));

    const loader = createSlideImageLoader({
      loadSettings: async () => ({ token: "t", extendedLogging: true }) as Settings,
    });
    const wrapper = document.createElement("div");
    wrapper.className = "slideStrip__thumb";
    const img = document.createElement("img");
    img.dataset.slideImageUrl = "http://127.0.0.1:8787/v1/slides/abc/6";
    img.dataset.slideRetryCount = "0";
    img.dataset.slideRetryStartedAt = String(Date.now() - 21 * 60_000);
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    loader.observe(img, "http://127.0.0.1:8787/v1/slides/abc/6");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(img.dataset.slideRetryCount).toBe("0");
    debugSpy.mockRestore();
  });

  it("evicts least-recently-used cached entries when over capacity", async () => {
    globalThis.IntersectionObserver = undefined;
    const fetchSpy = vi.fn(async () => createSlideFetchResponse({ ready: "1", body: "ok" }));
    globalThis.fetch = fetchSpy;
    const objectUrls = ["blob:1", "blob:2", "blob:3"];
    mockCreateObjectUrl(() => objectUrls.shift() ?? "blob:next");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const loader = createSlideImageLoader({
      loadSettings: async () =>
        ({ token: "t", daemonPort: "8787", extendedLogging: false }) as Settings,
      maxCacheEntries: 2,
    });

    const makeImg = () => {
      const wrapper = document.createElement("div");
      wrapper.className = "slideStrip__thumb";
      const img = document.createElement("img");
      wrapper.appendChild(img);
      document.body.appendChild(wrapper);
      return img;
    };

    const img1 = makeImg();
    loader.observe(img1, "http://127.0.0.1:8787/v1/slides/abc/1");
    await waitUntil(() => {
      expect(img1.getAttribute("src")).toMatch(/^blob:/);
    });
    const img1Src = img1.getAttribute("src");
    expect(img1Src).toMatch(/^blob:/);

    const img2 = makeImg();
    loader.observe(img2, "http://127.0.0.1:8787/v1/slides/abc/2");
    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(img2.getAttribute("src")).toMatch(/^blob:/);
    });
    const img2Src = img2.getAttribute("src");
    expect(img2Src).toMatch(/^blob:/);
    expect(img2Src).not.toBe(img1Src);

    const img1b = makeImg();
    loader.observe(img1b, "http://127.0.0.1:8787/v1/slides/abc/1");
    await waitUntil(() => {
      expect(img1b.getAttribute("src")).toBe(img1Src);
    });

    const img3 = makeImg();
    loader.observe(img3, "http://127.0.0.1:8787/v1/slides/abc/3");
    await waitUntil(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(img3.getAttribute("src")).toMatch(/^blob:/);
      expect(revokeSpy).toHaveBeenCalledWith(img2Src);
    });
    revokeSpy.mockRestore();
  });
});
