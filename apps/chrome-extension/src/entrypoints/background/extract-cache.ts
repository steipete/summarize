import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import { daemonOrigin } from "../../lib/daemon-url";
import { createCachedExtract, type CachedExtract } from "./cached-extract";
import type { ExtractResponse } from "./content-script-bridge";
import { routeExtract, type ExtractLog, type ExtractorContext } from "./extractors/router";
import type { SlidesPayload } from "./panel-utils";

export { createCachedExtract, type CachedExtract } from "./cached-extract";

type CachedExtractStore = {
  getCachedExtract(tabId: number, url: string): CachedExtract | null | undefined;
  setCachedExtract(tabId: number, value: CachedExtract): void;
  getLastMediaProbe(tabId: number): string | null | undefined;
  rememberMediaProbe(tabId: number, url: string): void;
};

type LoadSettingsResult = {
  extendedLogging: boolean;
  maxChars: number;
  slideRuntime: "browser" | "daemon";
  slidesEnabled: boolean;
  token: string;
  daemonPort: string;
};

const MIN_CHAT_CHARS = 100;
const CHAT_FULL_TRANSCRIPT_MAX_CHARS = Number.MAX_SAFE_INTEGER;

export async function ensureChatExtract({
  session,
  tab,
  settings,
  panelSessionStore,
  sendStatus,
  extractFromTab,
  fetchImpl,
  daemonFetchImpl = fetchImpl,
  log,
}: {
  session: { windowId: number };
  tab: chrome.tabs.Tab;
  settings: LoadSettingsResult;
  panelSessionStore: CachedExtractStore;
  sendStatus: (status: string) => void;
  extractFromTab: ExtractorContext["extractFromTab"];
  fetchImpl: typeof fetch;
  daemonFetchImpl?: typeof fetch;
  log?: ExtractLog;
}): Promise<CachedExtract> {
  if (!tab.id || !tab.url) {
    throw new Error("Cannot chat on this page");
  }

  const preferUrl = shouldPreferUrlMode(tab.url);
  const cached = panelSessionStore.getCachedExtract(tab.id, tab.url);
  if (cached && (!preferUrl || cached.source === "url")) return cached;
  const routeLog = log ?? (() => {});

  if (preferUrl) {
    await routeExtract({
      tabId: tab.id,
      url: tab.url,
      title: tab.title?.trim() ?? null,
      maxChars: settings.maxChars,
      minTextChars: 1,
      token: settings.token,
      includeDiagnostics: settings.extendedLogging,
      fetchImpl,
      daemonFetchImpl,
      extractFromTab,
      log: routeLog,
    });
  } else {
    const routed = await routeExtract({
      tabId: tab.id,
      url: tab.url,
      title: tab.title?.trim() ?? null,
      maxChars: CHAT_FULL_TRANSCRIPT_MAX_CHARS,
      minTextChars: MIN_CHAT_CHARS,
      token: settings.token,
      includeDiagnostics: settings.extendedLogging,
      fetchImpl,
      daemonFetchImpl,
      extractFromTab,
      log: routeLog,
    });
    if (routed) {
      const next = createCachedExtract({
        extracted: routed.extracted,
        source: routed.source,
        diagnostics: routed.diagnostics,
        title: tab.title?.trim() ?? null,
      });
      panelSessionStore.setCachedExtract(tab.id, next);
      return next;
    }
  }

  const wantsSlides =
    settings.slidesEnabled && settings.slideRuntime === "daemon" && shouldPreferUrlMode(tab.url);
  sendStatus(
    wantsSlides
      ? "Extracting video + thumbnails…"
      : preferUrl
        ? "Extracting video transcript…"
        : "Extracting URL content…",
  );
  const extractTimeoutMs = wantsSlides ? 6 * 60_000 : 3 * 60_000;
  const extractController = new AbortController();
  const extractTimeout = setTimeout(() => {
    extractController.abort();
  }, extractTimeoutMs);

  let res!: Response;
  let json!: {
    ok: boolean;
    extracted?: {
      content: string;
      title: string | null;
      url: string;
      wordCount: number;
      totalCharacters: number;
      truncated: boolean;
      transcriptSource: string | null;
      transcriptCharacters?: number | null;
      transcriptWordCount?: number | null;
      transcriptLines?: number | null;
      transcriptionProvider?: string | null;
      transcriptTimedText?: string | null;
      mediaDurationSeconds?: number | null;
      diagnostics?: CachedExtract["diagnostics"];
    };
    slides?: SlidesPayload | null;
    error?: string;
  };
  const origin = daemonOrigin(settings.daemonPort);

  try {
    res = await daemonFetchImpl(`${origin}/v1/summarize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: tab.url,
        mode: "url",
        extractOnly: true,
        timestamps: true,
        ...(wantsSlides ? { slides: true } : {}),
        maxCharacters: null,
      }),
      signal: extractController.signal,
    });
    json = (await res.json()) as typeof json;
  } catch (err) {
    if (extractController.signal.aborted) {
      throw new Error("Video extraction timed out. The daemon may be stuck.");
    }
    throw err;
  } finally {
    clearTimeout(extractTimeout);
  }
  if (!res.ok || !json.ok || !json.extracted) {
    throw new Error(json.error || `${res.status} ${res.statusText}`);
  }

  const next: CachedExtract = {
    url: json.extracted.url,
    title: json.extracted.title,
    text: json.extracted.content,
    source: "url",
    truncated: json.extracted.truncated,
    totalCharacters: json.extracted.totalCharacters,
    wordCount: json.extracted.wordCount,
    media: null,
    transcriptSource: json.extracted.transcriptSource ?? null,
    transcriptionProvider: json.extracted.transcriptionProvider ?? null,
    transcriptCharacters: json.extracted.transcriptCharacters ?? null,
    transcriptWordCount: json.extracted.transcriptWordCount ?? null,
    transcriptLines: json.extracted.transcriptLines ?? null,
    transcriptTimedText: json.extracted.transcriptTimedText ?? null,
    mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
    slides: json.slides ?? null,
    diagnostics: json.extracted.diagnostics ?? null,
  };
  if (!next.mediaDurationSeconds) {
    const fallback = await extractFromTab(tab.id, CHAT_FULL_TRANSCRIPT_MAX_CHARS);
    if (fallback.ok) {
      const duration = fallback.data.mediaDurationSeconds;
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
        next.mediaDurationSeconds = duration;
      }
      if (!next.media) {
        next.media = fallback.data.media ?? null;
      }
    }
  }
  panelSessionStore.setCachedExtract(tab.id, next);
  return next;
}

export async function primeMediaHint({
  session,
  tabId,
  url,
  title,
  panelSessionStore,
  urlsMatch,
  extractFromTab,
  emitState,
}: {
  session: unknown;
  tabId: number;
  url: string;
  title: string | null;
  panelSessionStore: CachedExtractStore;
  urlsMatch: (left: string, right: string) => boolean;
  extractFromTab: (tabId: number, maxCharacters: number) => Promise<ExtractResponse>;
  emitState: (session: unknown, status: string) => void;
}): Promise<void> {
  const lastProbeUrl = panelSessionStore.getLastMediaProbe(tabId);
  if (lastProbeUrl && urlsMatch(lastProbeUrl, url)) return;
  const existing = panelSessionStore.getCachedExtract(tabId, url);
  if (existing?.media) {
    panelSessionStore.rememberMediaProbe(tabId, url);
    return;
  }

  panelSessionStore.rememberMediaProbe(tabId, url);
  const attempt = await extractFromTab(tabId, 1200);
  if (!attempt.ok || !attempt.data.media) return;

  panelSessionStore.setCachedExtract(
    tabId,
    createCachedExtract({
      extracted: attempt.data,
      title,
    }),
  );
  emitState(session, "");
}
