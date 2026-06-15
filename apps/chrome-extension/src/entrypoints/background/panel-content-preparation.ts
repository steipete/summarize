import { planMediaExtraction } from "../../lib/media-extraction-plan";
import type { Settings } from "../../lib/settings";
import type { BrowserLocalMediaTranscript } from "./browser-local-transcript";
import type { CachedExtract } from "./cached-extract";
import type { ExtractResponse } from "./content-script-bridge";
import { routeExtract, type ExtractorContext } from "./extractors/router";
import type { BrowserYoutubeLocalTranscript } from "./youtube-local-transcript";
import { extractYouTubeTranscriptInTab, hasYouTubeCaptionTracksInTab } from "./youtube-transcript";

type PanelTab = {
  id: number;
  title?: string | null;
  url: string;
};

export type PreparedPanelContent = {
  payload: ExtractResponse & { ok: true };
  title: string | null;
  transcriptTimedText: string | null;
  localTranscriptError: string | null;
  source: CachedExtract["source"];
  diagnostics: CachedExtract["diagnostics"];
  prefersUrlMode: boolean;
};

type PreparationResult =
  | { kind: "ready"; content: PreparedPanelContent }
  | { kind: "stale" }
  | { kind: "superseded" };

type CommonPreparationOptions = {
  tab: PanelTab;
  tabUrl: string;
  settings: Settings;
  requestedInputMode: "page" | "video" | null;
  sendStatus: (status: string) => void;
  logPanel: (event: string, detail?: Record<string, unknown>) => void;
  urlsMatch: (left: string, right: string) => boolean;
};

export async function preparePanelContent({
  tab,
  tabUrl,
  settings,
  reason,
  refresh,
  requestedInputMode,
  useBrowserSummary,
  panelOpen,
  isSuperseded,
  signal,
  fetchImpl,
  extractFromTab,
  routeExtractImpl = routeExtract,
  sendStatus,
  logPanel,
  urlsMatch,
  extractYouTubeTranscript = extractYouTubeTranscriptInTab,
  hasYouTubeCaptionTracks = hasYouTubeCaptionTracksInTab,
  youtubeTranscriptTimeoutMs = 12_000,
}: CommonPreparationOptions & {
  reason: string;
  refresh: boolean;
  useBrowserSummary: boolean;
  panelOpen: () => boolean;
  isSuperseded: () => boolean;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  extractFromTab: ExtractorContext["extractFromTab"];
  routeExtractImpl?: typeof routeExtract;
  extractYouTubeTranscript?: typeof extractYouTubeTranscriptInTab;
  hasYouTubeCaptionTracks?: typeof hasYouTubeCaptionTracksInTab;
  youtubeTranscriptTimeoutMs?: number;
}): Promise<PreparationResult> {
  const extractionPlan = planMediaExtraction({ url: tabUrl, requestedInputMode });
  const { prefersUrlMode } = extractionPlan;

  let extracted: ExtractResponse & { ok: true };
  let source: CachedExtract["source"] = "page";
  let diagnostics: CachedExtract["diagnostics"] = null;
  let transcriptTimedText: string | null = null;

  if (extractionPlan.directYouTubeTranscript) {
    logPanel("extractor.route.start", { tabId: tab.id, preferUrl: prefersUrlMode });
    logPanel("extractor.route.preferUrlHardSwitch", { tabId: tab.id });
    sendStatus(`Preparing video… (${reason})`);
    logPanel("extract:url-direct", { reason, tabId: tab.id });
    const shouldProbeBrowserTranscript =
      !useBrowserSummary || (await hasYouTubeCaptionTracks(tab.id));
    const browserTranscript = shouldProbeBrowserTranscript
      ? await withTimeout(
          extractYouTubeTranscript(tab.id, settings.maxChars),
          youtubeTranscriptTimeoutMs,
          { ok: false as const, error: "YouTube caption lookup timed out." },
        )
      : { ok: false as const, error: "YouTube player has no caption tracks." };
    if (browserTranscript.ok && !urlsMatch(browserTranscript.url, tabUrl)) {
      logPanel("extract:url-direct:browser-transcript-stale", {
        expectedUrl: tabUrl,
        actualUrl: browserTranscript.url,
      });
      return { kind: "stale" };
    }
    transcriptTimedText = browserTranscript.ok ? browserTranscript.transcriptTimedText : null;
    if (isSuperseded()) return { kind: "superseded" };
    const extractedAttempt =
      browserTranscript.ok && browserTranscript.text.trim().length > 0
        ? null
        : await extractFromTab(tab.id, settings.maxChars, {
            timeoutMs: 8_000,
            inputMode: "video",
            log: (event, detail) => {
              logPanel(event, detail);
            },
          });
    if (isSuperseded()) return { kind: "superseded" };
    extracted =
      browserTranscript.ok && browserTranscript.text.trim().length > 0
        ? {
            ok: true,
            url: browserTranscript.url,
            title: tab.title ?? null,
            text: browserTranscript.text,
            truncated: browserTranscript.truncated,
            mediaDurationSeconds: browserTranscript.durationSeconds,
            media: { hasVideo: true, hasAudio: true, hasCaptions: true },
          }
        : extractedAttempt?.ok && extractedAttempt.data.text.trim().length > 0
          ? {
              ...extractedAttempt.data,
              media: extractedAttempt.data.media ?? {
                hasVideo: true,
                hasAudio: true,
                hasCaptions: true,
              },
            }
          : emptyExtract(tab, { hasVideo: true, hasAudio: true, hasCaptions: true });
    logPanel("extract:url-direct:browser-transcript", {
      ok: browserTranscript.ok,
      textLength: extracted.text.length,
      source:
        browserTranscript.ok && browserTranscript.text.trim().length > 0
          ? "browser"
          : extracted.text.length > 0
            ? "content-script"
            : "empty-fallback",
      error: browserTranscript.ok ? undefined : browserTranscript.error,
    });
  } else {
    sendStatus(`Extracting… (${reason})`);
    logPanel("extract:start", { reason, tabId: tab.id, maxChars: settings.maxChars });
    const statusFromExtractEvent = (event: string) => {
      if (!panelOpen()) return;
      if (event === "extract:attempt") {
        sendStatus(`Extracting page content… (${reason})`);
        return;
      }
      if (event === "extract:inject:ok") {
        sendStatus(`Extracting: injecting… (${reason})`);
        return;
      }
      if (event === "extract:message:ok") {
        sendStatus(`Extracting: reading… (${reason})`);
      }
    };
    if (prefersUrlMode) {
      logPanel("extractor.route.start", { tabId: tab.id, preferUrl: true });
      logPanel("extractor.route.preferUrlHardSwitch", { tabId: tab.id });
      const extractedAttempt = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        inputMode: extractionPlan.contentScriptInputMode,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return { kind: "superseded" };
      logPanel(extractedAttempt.ok ? "extract:done" : "extract:failed", {
        ok: extractedAttempt.ok,
        ...(extractedAttempt.ok
          ? { url: extractedAttempt.data.url }
          : { error: extractedAttempt.error }),
      });
      extracted = extractedAttempt.ok ? extractedAttempt.data : emptyExtract(tab);
    } else {
      const routed = await routeExtractImpl({
        tabId: tab.id,
        url: tabUrl,
        title: tab.title?.trim() ?? null,
        maxChars: settings.maxChars,
        minTextChars: 1,
        token: settings.token,
        allowDaemon: !useBrowserSummary,
        noCache: refresh,
        includeDiagnostics: settings.extendedLogging,
        signal,
        fetchImpl,
        extractFromTab,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return { kind: "superseded" };
      logPanel(routed ? "extract:done" : "extract:failed", {
        ok: Boolean(routed),
        ...(routed
          ? { url: routed.extracted.url, source: routed.source }
          : { error: "No extractor result" }),
      });
      if (routed) {
        extracted = routed.extracted;
        source = routed.source;
        diagnostics = routed.diagnostics ?? null;
      } else {
        extracted = emptyExtract(tab);
      }
    }
  }

  if (extracted.url && !urlsMatch(tabUrl, extracted.url)) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    logPanel("extract:retry", { tabId: tab.id, maxChars: settings.maxChars });
    const retry = await extractFromTab(tab.id, settings.maxChars, {
      timeoutMs: 8_000,
      inputMode: requestedInputMode ?? undefined,
      log: (event, detail) => logPanel(event, detail),
    });
    if (isSuperseded()) return { kind: "superseded" };
    if (retry.ok) {
      extracted = retry.data;
      source = "page";
      diagnostics = null;
    }
  }

  const extractedMatchesTab = extracted.url ? urlsMatch(tabUrl, extracted.url) : true;
  const payload = extractedMatchesTab ? extracted : emptyExtract(tab);
  const title = tab.title?.trim() || payload.title || null;
  return {
    kind: "ready",
    content: {
      payload: { ...payload, title },
      title,
      transcriptTimedText,
      localTranscriptError: null,
      source,
      diagnostics,
      prefersUrlMode,
    },
  };
}

export async function ensurePreparedPanelTranscript({
  content,
  tab,
  tabUrl,
  settings,
  requestedInputMode,
  sendStatus,
  logPanel,
  urlsMatch,
  transcribeYouTubeLocally,
  transcribeMediaLocally,
}: CommonPreparationOptions & {
  content: PreparedPanelContent;
  transcribeYouTubeLocally: (args: {
    tabId: number;
    maxChars: number;
    onStatus?: ((status: string) => void) | null;
  }) => Promise<BrowserYoutubeLocalTranscript>;
  transcribeMediaLocally: (args: {
    maxChars: number;
    onStatus?: ((status: string) => void) | null;
    tabId: number;
    tabUrl: string;
  }) => Promise<BrowserLocalMediaTranscript>;
}): Promise<PreparedPanelContent> {
  if (content.transcriptTimedText?.trim()) return content;
  const extractionPlan = planMediaExtraction({
    url: content.payload.url,
    requestedInputMode,
  });
  const localTranscriptKind = extractionPlan.localTranscriptKind;
  if (!localTranscriptKind) return content;
  const localTranscript =
    localTranscriptKind === "youtube"
      ? await transcribeYouTubeLocally({
          tabId: tab.id,
          maxChars: settings.maxChars,
          onStatus: sendStatus,
        })
      : await transcribeMediaLocally({
          tabId: tab.id,
          tabUrl,
          maxChars: settings.maxChars,
          onStatus: sendStatus,
        });
  if (!localTranscript.ok) {
    logPanel(
      localTranscriptKind === "youtube"
        ? "extract:url-direct:local-transcript-failed"
        : "extract:browser-media:local-transcript-failed",
      { error: localTranscript.error },
    );
    return { ...content, localTranscriptError: localTranscript.error };
  }
  if (!urlsMatch(localTranscript.url, tabUrl)) {
    return {
      ...content,
      localTranscriptError: "The page changed before browser transcription completed.",
    };
  }
  logPanel(
    localTranscriptKind === "youtube"
      ? "extract:url-direct:local-transcript"
      : "extract:browser-media:transcript",
    {
      textLength: localTranscript.text.length,
      mediaSource:
        "mediaSource" in localTranscript ? localTranscript.mediaSource : localTranscript.source,
      decoder: localTranscript.diagnostics.decoder,
      mediaChunksProcessed: localTranscript.diagnostics.chunksProcessed,
      mediaChunksTotal: localTranscript.diagnostics.chunksTotal,
      mediaCodec: localTranscript.diagnostics.codec,
      mediaInput: localTranscript.diagnostics.input,
      whisperDevice: localTranscript.diagnostics.whisper.device,
      whisperLoadMs: Math.round(localTranscript.diagnostics.whisper.loadMs),
      whisperReused: localTranscript.diagnostics.whisper.reused,
    },
  );
  return {
    ...content,
    payload: {
      ...content.payload,
      text: localTranscript.text,
      truncated: localTranscript.truncated,
      mediaDurationSeconds: localTranscript.durationSeconds,
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
    },
    transcriptTimedText: localTranscript.transcriptTimedText,
    localTranscriptError: null,
  };
}

function emptyExtract(
  tab: PanelTab,
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null = null,
): ExtractResponse & { ok: true } {
  return {
    ok: true,
    url: tab.url,
    title: tab.title ?? null,
    text: "",
    truncated: false,
    media,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
