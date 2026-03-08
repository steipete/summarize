import { logExtensionEvent } from "../../lib/extension-logs";
import { loadSettings, type Settings } from "../../lib/settings";

const SLIDE_THUMB_SELECTOR = ".slideStrip__thumb, .slideInline__thumb, .slideGallery__thumb";

export function normalizeSlideImageUrl(
  imageUrl: string | null | undefined,
  sourceId: string,
  index: number,
): string {
  if (!imageUrl) return "";
  const stablePrefix = `http://127.0.0.1:8787/v1/slides/${sourceId}`;
  if (imageUrl.startsWith(stablePrefix)) return imageUrl;
  if (!imageUrl.includes("/v1/summarize/")) return imageUrl;
  const queryIndex = imageUrl.indexOf("?");
  const query = queryIndex >= 0 ? imageUrl.slice(queryIndex) : "";
  return `${stablePrefix}/${index}${query}`;
}

type SlideImageLoader = {
  observe: (img: HTMLImageElement, imageUrl: string) => void;
  clearCache: () => void;
};

export function createSlideImageLoader(
  options: { loadSettings?: () => Promise<Settings>; maxCacheEntries?: number } = {},
): SlideImageLoader {
  const loadSettingsFn = options.loadSettings ?? loadSettings;
  const slideImageCache = new Map<string, { objectUrl: string; lastUsed: number }>();
  const slideImagePending = new Map<string, Promise<string | null>>();
  const slideImageRetryTimers = new WeakMap<HTMLImageElement, number>();
  const slideImageObserverEntries = new WeakMap<HTMLImageElement, { imageUrl: string }>();
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 160);
  let cacheUseCounter = 0;

  const recordCacheUse = (imageUrl: string, objectUrl: string) => {
    cacheUseCounter += 1;
    slideImageCache.set(imageUrl, { objectUrl, lastUsed: cacheUseCounter });
  };

  const pruneCache = () => {
    const excess = slideImageCache.size - maxCacheEntries;
    if (excess <= 0) return;
    const entries = Array.from(slideImageCache.entries()).sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );
    for (let i = 0; i < excess; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      const [url, cached] = entry;
      URL.revokeObjectURL(cached.objectUrl);
      slideImageCache.delete(url);
    }
  };

  const markSlideImageLoaded = (img: HTMLImageElement) => {
    img.dataset.loaded = "true";
    const parent = img.closest<HTMLElement>(SLIDE_THUMB_SELECTOR);
    parent?.classList.remove("isPlaceholder");
  };

  const markSlideImagePending = (img: HTMLImageElement) => {
    img.dataset.loaded = "false";
    const parent = img.closest<HTMLElement>(SLIDE_THUMB_SELECTOR);
    parent?.classList.add("isPlaceholder");
  };

  const clearCache = () => {
    for (const cached of slideImageCache.values()) {
      URL.revokeObjectURL(cached.objectUrl);
    }
    slideImageCache.clear();
    slideImagePending.clear();
  };

  const resolveSlideImageUrl = async (imageUrl: string): Promise<string | null> => {
    if (!imageUrl) return null;
    const cached = slideImageCache.get(imageUrl);
    if (cached) {
      recordCacheUse(imageUrl, cached.objectUrl);
      return cached.objectUrl;
    }
    const pending = slideImagePending.get(imageUrl);
    if (pending) return pending;

    const task = (async () => {
      try {
        const settings = await loadSettingsFn();
        const token = settings.token.trim();
        if (!token) return null;
        const res = await fetch(imageUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          if (settings.extendedLogging) {
            logExtensionEvent({
              event: "slides:image:fetch-failed",
              level: "warn",
              scope: "slides:panel",
              detail: { url: imageUrl, status: res.status },
            });
            console.debug("[summarize] slide fetch failed", { url: imageUrl, status: res.status });
          }
          return null;
        }
        const readyHeader = res.headers.get("x-summarize-slide-ready");
        if (readyHeader === "0") {
          if (settings.extendedLogging) {
            logExtensionEvent({
              event: "slides:image:not-ready",
              level: "verbose",
              scope: "slides:panel",
              detail: { url: imageUrl },
            });
            console.debug("[summarize] slide not ready", { url: imageUrl });
          }
          return null;
        }
        const blob = await res.blob();
        if (settings.extendedLogging) {
          logExtensionEvent({
            event: "slides:image:loaded",
            level: "info",
            scope: "slides:panel",
            detail: { url: imageUrl, sizeBytes: blob.size },
          });
        }
        const objectUrl = URL.createObjectURL(blob);
        recordCacheUse(imageUrl, objectUrl);
        pruneCache();
        return objectUrl;
      } catch {
        return null;
      } finally {
        slideImagePending.delete(imageUrl);
      }
    })();

    slideImagePending.set(imageUrl, task);
    return task;
  };

  const setSlideImage = async (img: HTMLImageElement, imageUrl: string) => {
    if (!imageUrl) return;
    const existingTimer = slideImageRetryTimers.get(img);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      slideImageRetryTimers.delete(img);
    }
    markSlideImagePending(img);
    const cached = slideImageCache.get(imageUrl);
    if (cached) {
      if (img.src !== cached.objectUrl) img.src = cached.objectUrl;
      recordCacheUse(imageUrl, cached.objectUrl);
      markSlideImageLoaded(img);
      return;
    }
    img.dataset.slideImageUrl = imageUrl;
    const resolved = await resolveSlideImageUrl(imageUrl);
    if (!resolved) {
      if (img.dataset.slideImageUrl !== imageUrl) return;
      const retryCount = Number(img.dataset.slideRetryCount ?? "0");
      if (!Number.isFinite(retryCount)) return;
      const startedAt = Number(img.dataset.slideRetryStartedAt ?? "0");
      const elapsedMs = startedAt > 0 ? Date.now() - startedAt : 0;
      if (elapsedMs > 20 * 60_000) return;
      const nextRetry = retryCount + 1;
      img.dataset.slideRetryCount = String(nextRetry);
      const delayMs = Math.min(30_000, Math.round(500 * 1.7 ** retryCount));
      const timer = window.setTimeout(() => {
        if (img.dataset.slideImageUrl !== imageUrl) return;
        void setSlideImage(img, imageUrl);
      }, delayMs);
      slideImageRetryTimers.set(img, timer);
      return;
    }
    if (img.dataset.slideImageUrl !== imageUrl) return;
    if (img.src !== resolved) img.src = resolved;
    const markLoaded = () => {
      if (img.dataset.slideImageUrl !== imageUrl) return;
      markSlideImageLoaded(img);
    };
    markLoaded();
    if (img.complete && img.naturalWidth > 0) {
      markLoaded();
    } else if (typeof img.decode === "function") {
      img
        .decode()
        .then(markLoaded)
        .catch(() => {});
    }
  };

  const slideImageObserver =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const img = entry.target as HTMLImageElement;
              const info = slideImageObserverEntries.get(img);
              if (!info) continue;
              slideImageObserverEntries.delete(img);
              slideImageObserver?.unobserve(img);
              img.dataset.slideObserveArmed = "false";
              void setSlideImage(img, info.imageUrl);
            }
          },
          { rootMargin: "320px 0px" },
        )
      : null;

  const observe = (img: HTMLImageElement, imageUrl: string) => {
    if (!imageUrl) return;
    const isSameUrl = img.dataset.slideImageUrl === imageUrl;
    if (isSameUrl) {
      if (img.dataset.loaded === "true" && img.src) return;
      if (img.dataset.slideObserveArmed === "true") return;
    }
    const hadVisibleImage = img.dataset.loaded === "true" && Boolean(img.src);
    img.dataset.slideImageUrl = imageUrl;
    if (!hadVisibleImage) {
      img.dataset.loaded = "false";
    }
    const thumb = img.closest<HTMLElement>(SLIDE_THUMB_SELECTOR);
    if (thumb && img.dataset.loaded !== "true") thumb.classList.add("isPlaceholder");
    if (!isSameUrl) {
      img.dataset.slideRetryCount = "0";
      img.dataset.slideRetryStartedAt = String(Date.now());
    } else if (!img.dataset.slideRetryCount) {
      img.dataset.slideRetryCount = "0";
    }
    if (img.dataset.slideLoadListener !== "true") {
      img.dataset.slideLoadListener = "true";
      img.addEventListener("load", () => {
        markSlideImageLoaded(img);
      });
    }
    if (!slideImageObserver) {
      void setSlideImage(img, imageUrl);
      return;
    }
    const rect = img.getBoundingClientRect();
    const viewportHeight =
      globalThis.innerHeight || document.documentElement?.clientHeight || Number.MAX_SAFE_INTEGER;
    const alreadyNearViewport =
      rect.width > 0 && rect.height > 0 && rect.bottom >= -320 && rect.top <= viewportHeight + 320;
    if (alreadyNearViewport) {
      img.dataset.slideObserveArmed = "false";
      slideImageObserverEntries.delete(img);
      slideImageObserver.unobserve(img);
      void setSlideImage(img, imageUrl);
      return;
    }
    img.dataset.slideObserveArmed = "true";
    slideImageObserverEntries.set(img, { imageUrl });
    slideImageObserver.observe(img);
  };

  return { observe, clearCache };
}
