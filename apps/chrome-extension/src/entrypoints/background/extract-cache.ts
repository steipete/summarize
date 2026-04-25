import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { ExtractResponse } from "./content-script-bridge";
import {
  routeExtract,
  type ExtractLog,
  type ExtractorContext,
  type ExtractorResult,
} from "./extractors/router";
import type { SlidesPayload } from "./panel-utils";

export type CachedExtract = {
  url: string;
  title: string | null;
  text: string;
  source: "page" | "url";
  truncated: boolean;
  totalCharacters: number;
  wordCount: number | null;
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  transcriptSource: string | null;
  transcriptionProvider: string | null;
  transcriptCharacters: number | null;
  transcriptWordCount: number | null;
  transcriptLines: number | null;
  transcriptTimedText: string | null;
  mediaDurationSeconds: number | null;
  slides: SlidesPayload | null;
  diagnostics?: {
    strategy: string;
    markdown?: { used?: boolean; provider?: string | null } | null;
    firecrawl?: { used?: boolean } | null;
    transcript?: {
      provider?: string | null;
      cacheStatus?: string | null;
      attemptedProviders?: string[] | null;
    } | null;
  } | null;
};

type CachedExtractStore = {
  getCachedExtract(tabId: number, url: string): CachedExtract | null | undefined;
  setCachedExtract(tabId: number, value: CachedExtract): void;
  getLastMediaProbe(tabId: number): string | null | undefined;
  rememberMediaProbe(tabId: number, url: string): void;
};

type LoadSettingsResult = {
  extendedLogging: boolean;
  maxChars: number;
  slidesEnabled: boolean;
  token: string;
};

const MIN_CHAT_CHARS = 100;
const CHAT_FULL_TRANSCRIPT_MAX_CHARS = Number.MAX_SAFE_INTEGER;

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

function fromPageExtract({
  extracted,
  result,
  title,
}: {
  extracted: {
    url: string;
    title?: string | null;
    text: string;
    truncated: boolean;
    media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
    mediaDurationSeconds?: number | null;
  };
  result?: Pick<ExtractorResult, "source" | "diagnostics"> | null;
  title: string | null;
}): CachedExtract {
  return {
    url: extracted.url,
    title: extracted.title ?? title,
    text: extracted.text,
    source: result?.source ?? "page",
    truncated: extracted.truncated,
    totalCharacters: extracted.text.length,
    wordCount: countWords(extracted.text),
    media: extracted.media ?? null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptCharacters: null,
    transcriptWordCount: null,
    transcriptLines: null,
    transcriptTimedText: null,
    mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
    slides: null,
    diagnostics: result?.diagnostics ?? null,
  };
}

export async function ensureChatExtract({
  session,
  tab,
  settings,
  panelSessionStore,
  sendStatus,
  extractFromTab,
  fetchImpl,
  log,
}: {
  session: { windowId: number };
  tab: chrome.tabs.Tab;
  settings: LoadSettingsResult;
  panelSessionStore: CachedExtractStore;
  sendStatus: (status: string) => void;
  extractFromTab: ExtractorContext["extractFromTab"];
  fetchImpl: typeof fetch;
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
      extractFromTab,
      log: routeLog,
    });
    if (routed) {
      const next = fromPageExtract({
        extracted: routed.extracted,
        result: routed,
        title: tab.title?.trim() ?? null,
      });
      panelSessionStore.setCachedExtract(tab.id, next);
      return next;
    }
  }

  const wantsSlides = settings.slidesEnabled && shouldPreferUrlMode(tab.url);
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
  try {
    res = await fetchImpl("http://127.0.0.1:8787/v1/summarize", {
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
    fromPageExtract({
      extracted: attempt.data,
      title,
    }),
  );
  emitState(session, "");
}
