const optionsWindowSize = { width: 940, height: 680 };
const optionsWindowMin = { width: 820, height: 560 };
const optionsWindowMargin = 20;
const MAX_SLIDE_OCR_CHARS = 8000;

export type SlidesPayload = {
  sourceUrl: string;
  sourceId: string;
  sourceKind: string;
  ocrAvailable: boolean;
  slides: Array<{
    index: number;
    timestamp: number;
    ocrText?: string | null;
    ocrConfidence?: number | null;
  }>;
};

export function formatSlideTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function buildSlidesText(
  slides: SlidesPayload | null,
  allowOcr: boolean,
): { count: number; text: string } | null {
  if (!allowOcr || !slides || slides.slides.length === 0) return null;
  let remaining = MAX_SLIDE_OCR_CHARS;
  const lines: string[] = [];
  for (const slide of slides.slides) {
    const text = slide.ocrText?.trim();
    if (!text) continue;
    const timestamp = Number.isFinite(slide.timestamp)
      ? formatSlideTimestamp(slide.timestamp)
      : null;
    const label = timestamp ? `@ ${timestamp}` : "";
    const entry = `Slide ${slide.index} ${label}:\n${text}`.trim();
    if (entry.length > remaining && lines.length > 0) break;
    lines.push(entry);
    remaining -= entry.length;
    if (remaining <= 0) break;
  }
  return lines.length > 0 ? { count: slides.slides.length, text: lines.join("\n\n") } : null;
}

export function resolveOptionsUrl(): string {
  const page = chrome.runtime.getManifest().options_ui?.page ?? "options.html";
  return chrome.runtime.getURL(page);
}

export async function openOptionsWindow() {
  const url = resolveOptionsUrl();
  try {
    if (chrome.windows?.create) {
      const current = await chrome.windows.getCurrent();
      const maxWidth = current.width
        ? Math.max(optionsWindowMin.width, current.width - optionsWindowMargin)
        : null;
      const maxHeight = current.height
        ? Math.max(optionsWindowMin.height, current.height - optionsWindowMargin)
        : null;
      const width = maxWidth
        ? Math.min(optionsWindowSize.width, maxWidth)
        : optionsWindowSize.width;
      const height = maxHeight
        ? Math.min(optionsWindowSize.height, maxHeight)
        : optionsWindowSize.height;
      await chrome.windows.create({ url, type: "popup", width, height });
      return;
    }
  } catch {
    // ignore and fall back
  }
  void chrome.runtime.openOptionsPage();
}

export async function getActiveTab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const query =
    typeof windowId === "number"
      ? { active: true, windowId }
      : { active: true, currentWindow: true };
  const [activeTab] = await chrome.tabs.query(query);
  if (
    activeTab?.url &&
    !activeTab.url.startsWith("chrome-extension://") &&
    !activeTab.url.startsWith("chrome://")
  ) {
    return activeTab;
  }

  const fallbackTabs = await chrome.tabs.query(
    typeof windowId === "number" ? { windowId } : { currentWindow: true },
  );
  const contentTab =
    fallbackTabs.find(
      (tab) =>
        typeof tab.url === "string" &&
        !tab.url.startsWith("chrome-extension://") &&
        !tab.url.startsWith("chrome://"),
    ) ?? null;
  return contentTab ?? activeTab ?? null;
}

export function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function urlsMatch(a: string, b: string) {
  const left = normalizeUrl(a);
  const right = normalizeUrl(b);
  if (left === right) return true;
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false;
    if (longer.length === shorter.length) return true;
    const next = longer[shorter.length];
    return next === "/" || next === "?" || next === "&";
  };
  return boundaryMatch(left, right) || boundaryMatch(right, left);
}
