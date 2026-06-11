export type ExtractRequest = { type: "extract"; maxChars: number; inputMode?: "page" | "video" };
export type SeekRequest = { type: "seek"; seconds: number };
export type SlideFrameRestoreSnapshot = {
  currentTime: number;
  paused: boolean;
  scrollX: number;
  scrollY: number;
  pageUrl?: string;
  mediaSrc?: string;
};
export type BeginSlideFrameCaptureRequest = {
  type: "begin-slide-frame-capture";
  state: SlideFrameRestoreSnapshot | null;
};
export type PrepareSlideFrameRequest = { type: "prepare-slide-frame"; seconds: number };
export type PrepareCurrentSlideFrameRequest = { type: "prepare-current-slide-frame" };
export type RestoreSlideFrameRequest = { type: "restore-slide-frame" };
type RestoreSlideFrameResponse = { ok: true; restored?: boolean } | { ok: false; error: string };

export type ExtractResponse =
  | {
      ok: true;
      url: string;
      title: string | null;
      text: string;
      truncated: boolean;
      mediaDurationSeconds?: number | null;
      media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean };
    }
  | { ok: false; error: string };

export type SeekResponse = { ok: true } | { ok: false; error: string };
export type SlideFrameResponse =
  | {
      ok: true;
      url: string;
      title: string | null;
      durationSeconds: number | null;
      currentTimeSeconds?: number | null;
      rect: { x: number; y: number; width: number; height: number };
      devicePixelRatio: number;
    }
  | { ok: false; error: string };

export type PrimaryMediaInfo =
  | {
      ok: true;
      currentTimeSeconds: number | null;
      durationSeconds: number | null;
      mediaSrc: string;
      title: string | null;
      url: string;
    }
  | { ok: false; error: string };

function contentAccessError(message: string) {
  return (
    message.toLowerCase().includes("cannot access") || message.toLowerCase().includes("denied")
  );
}

function formatInjectionError(message: string) {
  return contentAccessError(message)
    ? `Chrome blocked content access (${message}). Check extension “Site access” → “On all sites” (or allow this domain), then reload the tab.`
    : `Failed to inject content script (${message}). Check extension “Site access”, then reload the tab.`;
}

async function injectExtractScript(
  tabId: number,
  opts?: { log?: (event: string, detail?: Record<string, unknown>) => void },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/extract.js"],
    });
    opts?.log?.("extract:inject:ok");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts?.log?.("extract:inject:error", { error: message });
    return { ok: false, error: formatInjectionError(message) };
  }
}

export function canSummarizeUrl(url: string | undefined): url is string {
  if (!url) return false;
  if (url.startsWith("chrome://")) return false;
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("moz-extension://")) return false;
  if (url.startsWith("edge://")) return false;
  if (url.startsWith("about:")) return false;
  return true;
}

export async function extractFromTab(
  tabId: number,
  maxChars: number,
  opts?: {
    timeoutMs?: number;
    inputMode?: "page" | "video" | null;
    log?: (event: string, detail?: Record<string, unknown>) => void;
  },
): Promise<{ ok: true; data: ExtractResponse & { ok: true } } | { ok: false; error: string }> {
  const req = {
    type: "extract",
    maxChars,
    inputMode: opts?.inputMode ?? undefined,
  } satisfies ExtractRequest;
  const timeoutMs = opts?.timeoutMs ?? 6_000;

  const sendMessageWithTimeout = async (): Promise<ExtractResponse> => {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const res = (await Promise.race([
        chrome.tabs.sendMessage(tabId, req) as Promise<ExtractResponse>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`extract timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ])) as ExtractResponse;
      if (timer) clearTimeout(timer);
      opts?.log?.("extract:message:ok", { elapsedMs: Date.now() - start });
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      opts?.log?.("extract:message:error", {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      opts?.log?.("extract:attempt", { attempt: attempt + 1, timeoutMs });
      const res = await sendMessageWithTimeout();
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: res };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noReceiver =
        message.includes("Receiving end does not exist") ||
        message.includes("Could not establish connection");
      const didTimeout = message.includes("extract timed out");
      if (noReceiver || didTimeout) {
        const injected = await injectExtractScript(tabId, opts);
        if (!injected.ok) return injected;
        if (didTimeout && attempt === 2) {
          return {
            ok: false,
            error:
              "Page extraction timed out. Reload the tab (or “Summarize → Refresh”), then retry.",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? "Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab."
            : message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return { ok: false, error: "Content script not ready" };
}

export async function seekInTab(
  tabId: number,
  seconds: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const req = { type: "seek", seconds } satisfies SeekRequest;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, req)) as SeekResponse;
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noReceiver =
        message.includes("Receiving end does not exist") ||
        message.includes("Could not establish connection");
      if (noReceiver) {
        const injected = await injectExtractScript(tabId);
        if (!injected.ok) return injected;
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? "Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab."
            : message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return { ok: false, error: "Content script not ready" };
}

export async function prepareSlideFrameInTab(
  tabId: number,
  seconds: number,
): Promise<{ ok: true; data: SlideFrameResponse & { ok: true } } | { ok: false; error: string }> {
  const req = { type: "prepare-slide-frame", seconds } satisfies PrepareSlideFrameRequest;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, req)) as SlideFrameResponse;
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: res };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noReceiver =
        message.includes("Receiving end does not exist") ||
        message.includes("Could not establish connection");
      if (noReceiver) {
        const injected = await injectExtractScript(tabId);
        if (!injected.ok) return injected;
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? "Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab."
            : message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return { ok: false, error: "Content script not ready" };
}

export async function prepareCurrentSlideFrameInTab(
  tabId: number,
): Promise<{ ok: true; data: SlideFrameResponse & { ok: true } } | { ok: false; error: string }> {
  const req = { type: "prepare-current-slide-frame" } satisfies PrepareCurrentSlideFrameRequest;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, req)) as SlideFrameResponse;
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: res };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noReceiver =
        message.includes("Receiving end does not exist") ||
        message.includes("Could not establish connection");
      if (noReceiver) {
        const injected = await injectExtractScript(tabId);
        if (!injected.ok) return injected;
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? "Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab."
            : message,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return { ok: false, error: "Content script not ready" };
}

export async function beginSlideFrameCaptureInTab(
  tabId: number,
): Promise<{ ok: true; state: SlideFrameRestoreSnapshot | null } | { ok: false; error: string }> {
  let stateResult: chrome.scripting.InjectionResult<SlideFrameRestoreSnapshot | null> | undefined;
  try {
    [stateResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (): SlideFrameRestoreSnapshot | null => {
        const best = Array.from(document.querySelectorAll("video")).reduce<{
          video: HTMLVideoElement;
          area: number;
        } | null>((current, video) => {
          const rect = video.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          if (area <= 0) return current;
          if (!current || area > current.area) return { video, area };
          return current;
        }, null);
        if (!best) return null;
        return {
          currentTime: best.video.currentTime,
          paused: best.video.paused,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          pageUrl: location.href,
          mediaSrc: best.video.currentSrc || best.video.src || "",
        };
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const req = {
    type: "begin-slide-frame-capture",
    state: stateResult?.result ?? null,
  } satisfies BeginSlideFrameCaptureRequest;

  try {
    const res = (await chrome.tabs.sendMessage(tabId, req)) as SeekResponse;
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, state: req.state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noReceiver =
      message.includes("Receiving end does not exist") ||
      message.includes("Could not establish connection");
    if (!noReceiver) return { ok: false, error: message };
    const injected = await injectExtractScript(tabId);
    if (!injected.ok) return injected;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const res = (await chrome.tabs.sendMessage(tabId, req)) as SeekResponse;
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, state: req.state };
  }
}

export async function getPrimaryMediaInfoInTab(tabId: number): Promise<PrimaryMediaInfo> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (): PrimaryMediaInfo => {
        const best = Array.from(
          document.querySelectorAll<HTMLMediaElement>("video, audio"),
        ).reduce<{
          media: HTMLMediaElement;
          score: number;
        } | null>((current, video) => {
          const rect = video.getBoundingClientRect();
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          const score = video instanceof HTMLVideoElement ? area : area || 1;
          if (score <= 0 || !(video.currentSrc || video.src)) return current;
          return !current || score > current.score ? { media: video, score } : current;
        }, null);
        if (!best) return { ok: false, error: "No audio or video element found." };
        const duration = best.media.duration;
        const currentTime = best.media.currentTime;
        return {
          ok: true,
          currentTimeSeconds: Number.isFinite(currentTime) ? currentTime : null,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
          mediaSrc: best.media.currentSrc || best.media.src || "",
          title: document.title || null,
          url: location.href,
        };
      },
    });
    return result?.result ?? { ok: false, error: "Could not inspect the active video." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function restoreSlideFrameInTab(
  tabId: number,
  state?: SlideFrameRestoreSnapshot | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const req = { type: "restore-slide-frame" } satisfies RestoreSlideFrameRequest;

  try {
    const res = (await chrome.tabs.sendMessage(tabId, req)) as RestoreSlideFrameResponse;
    if (!res.ok) return { ok: false, error: res.error };
    if (state && res.restored !== true) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [state],
        func: async (snapshot: SlideFrameRestoreSnapshot) => {
          const best = Array.from(document.querySelectorAll("video")).reduce<{
            video: HTMLVideoElement;
            area: number;
          } | null>((current, video) => {
            const rect = video.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area <= 0) return current;
            if (!current || area > current.area) return { video, area };
            return current;
          }, null);
          if (!best) return;
          const video = best.video;
          const currentMediaSrc = video.currentSrc || video.src || "";
          if (
            (snapshot.pageUrl && location.href !== snapshot.pageUrl) ||
            (snapshot.mediaSrc && currentMediaSrc !== snapshot.mediaSrc)
          ) {
            return;
          }
          video.pause();
          if (
            Number.isFinite(snapshot.currentTime) &&
            Math.abs(video.currentTime - snapshot.currentTime) > 0.05
          ) {
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(resolve, 1800);
              video.addEventListener(
                "seeked",
                () => {
                  window.clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
              video.currentTime = Math.max(0, snapshot.currentTime);
            });
          }
          if (snapshot.paused) {
            video.pause();
          } else {
            await video.play().catch(() => undefined);
          }
          window.scrollTo(snapshot.scrollX, snapshot.scrollY);
        },
      });
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
