import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { RunStart } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import type { BrowserLocalMediaTranscript } from "./browser-local-transcript";
import { buildBrowserSummaryMarkdown } from "./browser-summary";
import type { ExtractResponse } from "./content-script-bridge";
import type { CachedExtract } from "./extract-cache";
import { routeExtract, type ExtractorContext, type ExtractorResult } from "./extractors/router";
import type { BrowserYoutubeLocalTranscript } from "./youtube-local-transcript";
import { extractYouTubeTranscriptInTab, hasYouTubeCaptionTracksInTab } from "./youtube-transcript";

type DaemonRecoveryLike = {
  recordFailure: (url: string) => void;
};

type DaemonStatusLike = {
  markReady: () => void;
};

type BackgroundSummarizeSession = {
  windowId: number;
  runController: AbortController | null;
  inflightUrl: string | null;
  lastSummarizedUrl: string | null;
  inflightRequest: {
    url: string;
    inputMode: "page" | "video" | null;
    slides: boolean;
  } | null;
  activeSummaryRun: {
    run: RunStart;
    startedAt: number;
    inputMode: "page" | "video" | null;
    slides: boolean;
  } | null;
  daemonRecovery: DaemonRecoveryLike;
  daemonStatus: DaemonStatusLike;
};

type StoreLike = {
  isPanelOpen: (session: BackgroundSummarizeSession) => boolean;
  setCachedExtract: (tabId: number, value: CachedExtract) => void;
};

type SendFn = (
  msg:
    | { type: "run:error"; message: string }
    | { type: "run:start"; run: RunStart }
    | { type: "run:snapshot"; run: RunStart; markdown: string },
) => void;

export async function summarizeActiveTab({
  session,
  reason,
  opts,
  loadSettings,
  emitState,
  getActiveTab,
  canSummarizeUrl,
  panelSessionStore,
  sendStatus,
  send,
  fetchImpl,
  extractFromTab,
  urlsMatch,
  buildSummarizeRequestBody,
  friendlyFetchError,
  isDaemonUnreachableError,
  logPanel,
  transcribeYouTubeLocally = async () => ({
    ok: false,
    error: "Local YouTube transcription is unavailable in this browser.",
  }),
  transcribeMediaLocally = async () => ({
    ok: false,
    error: "Local browser media transcription is unavailable in this browser.",
  }),
  extractYouTubeTranscript = extractYouTubeTranscriptInTab,
  youtubeTranscriptTimeoutMs = 12_000,
}: {
  session: BackgroundSummarizeSession;
  reason: string;
  opts?: { refresh?: boolean; inputMode?: "page" | "video" };
  loadSettings: () => Promise<Settings>;
  emitState: (session: BackgroundSummarizeSession, status: string) => Promise<void>;
  getActiveTab: (windowId?: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url?: string | null) => boolean;
  panelSessionStore: StoreLike;
  sendStatus: (status: string) => void;
  send: SendFn;
  fetchImpl: typeof fetch;
  extractFromTab: ExtractorContext["extractFromTab"];
  urlsMatch: (left: string, right: string) => boolean;
  buildSummarizeRequestBody: (args: {
    extracted: ExtractResponse & { ok: true };
    settings: Settings;
    noCache: boolean;
    inputMode?: "page" | "video";
    timestamps: boolean;
    slides:
      | { enabled: false }
      | {
          enabled: true;
          ocr: boolean;
          maxSlides: number | null;
          minDurationSeconds: number | null;
        };
  }) => Record<string, unknown>;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  isDaemonUnreachableError: (error: unknown) => boolean;
  logPanel: (event: string, detail?: Record<string, unknown>) => void;
  transcribeYouTubeLocally?: (args: {
    tabId: number;
    maxChars: number;
    onStatus?: ((status: string) => void) | null;
  }) => Promise<BrowserYoutubeLocalTranscript>;
  transcribeMediaLocally?: (args: {
    maxChars: number;
    onStatus?: ((status: string) => void) | null;
    tabId: number;
    tabUrl: string;
  }) => Promise<BrowserLocalMediaTranscript>;
  extractYouTubeTranscript?: typeof extractYouTubeTranscriptInTab;
  youtubeTranscriptTimeoutMs?: number;
}) {
  if (!panelSessionStore.isPanelOpen(session)) return;

  const settings = await loadSettings();
  const isManual = reason === "manual" || reason === "refresh" || reason === "length-change";
  if (!isManual && !settings.autoSummarize) return;
  const useBrowserSummary = settings.slideRuntime === "browser" && !settings.token.trim();
  if (!useBrowserSummary && !settings.token.trim()) {
    await emitState(session, "Setup required (missing token)");
    return;
  }

  if (reason === "spa-nav" || reason === "tab-url-change") {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  const tab = await getActiveTab(session.windowId);
  if (!tab?.id || !canSummarizeUrl(tab.url)) return;
  const tabUrl = tab.url ?? "";
  const prefersUrlModeForTab = shouldPreferUrlMode(tabUrl);
  const requestedInputMode =
    opts?.inputMode ?? (prefersUrlModeForTab || isYouTubeVideoUrl(tabUrl) ? "video" : null);
  const requestedWantsSlides =
    settings.slidesEnabled && (requestedInputMode === "video" || prefersUrlModeForTab);
  const matchesRequestedRun = (candidate: {
    url: string;
    inputMode: "page" | "video" | null;
    slides: boolean;
  }) =>
    urlsMatch(candidate.url, tabUrl) &&
    candidate.inputMode === requestedInputMode &&
    candidate.slides === requestedWantsSlides;
  const canCoalesceSameUrl = !opts?.refresh && reason !== "length-change";
  const activeRun = session.activeSummaryRun;
  if (
    canCoalesceSameUrl &&
    activeRun &&
    Date.now() - activeRun.startedAt < 15_000 &&
    matchesRequestedRun({
      url: activeRun.run.url,
      inputMode: activeRun.inputMode,
      slides: activeRun.slides,
    })
  ) {
    sendStatus("");
    return;
  }
  if (
    canCoalesceSameUrl &&
    session.inflightRequest &&
    matchesRequestedRun(session.inflightRequest)
  ) {
    sendStatus("");
    return;
  }
  if (
    settings.autoSummarize &&
    !isManual &&
    canCoalesceSameUrl &&
    session.lastSummarizedUrl &&
    urlsMatch(session.lastSummarizedUrl, tabUrl)
  ) {
    sendStatus("");
    return;
  }

  session.runController?.abort();
  const controller = new AbortController();
  session.runController = controller;
  session.inflightUrl = tabUrl;
  session.inflightRequest = {
    url: tabUrl,
    inputMode: requestedInputMode,
    slides: requestedWantsSlides,
  };
  const isSuperseded = () => controller.signal.aborted || session.runController !== controller;
  const clearCurrentRun = () => {
    if (session.runController !== controller) return;
    session.runController = null;
    session.inflightUrl = null;
    session.inflightRequest = null;
  };

  const prefersUrlMode = Boolean(tab.url && shouldPreferUrlMode(tab.url));
  const wantsUrlDirectPath =
    Boolean(tab.url && isYouTubeVideoUrl(tab.url)) && opts?.inputMode !== "page" && prefersUrlMode;

  let extracted: ExtractResponse & { ok: true };
  let routedResult: Pick<ExtractorResult, "source" | "diagnostics"> | null = null;
  let browserTranscriptTimedText: string | null = null;
  if (wantsUrlDirectPath) {
    logPanel("extractor.route.start", { tabId: tab.id, preferUrl: prefersUrlMode });
    logPanel("extractor.route.preferUrlHardSwitch", { tabId: tab.id });
    sendStatus(`Preparing video… (${reason})`);
    logPanel("extract:url-direct", { reason, tabId: tab.id });
    const shouldProbeBrowserTranscript =
      !useBrowserSummary || (await hasYouTubeCaptionTracksInTab(tab.id));
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
      clearCurrentRun();
      sendStatus("");
      return;
    }
    browserTranscriptTimedText = browserTranscript.ok
      ? browserTranscript.transcriptTimedText
      : null;
    if (isSuperseded()) return;
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
    if (isSuperseded()) return;
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
          : {
              ok: true,
              url: tab.url,
              title: tab.title ?? null,
              text: "",
              truncated: false,
              media: { hasVideo: true, hasAudio: true, hasCaptions: true },
            };
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
      if (!panelSessionStore.isPanelOpen(session)) return;
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
        inputMode: requestedInputMode ?? "video",
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return;
      logPanel(extractedAttempt.ok ? "extract:done" : "extract:failed", {
        ok: extractedAttempt.ok,
        ...(extractedAttempt.ok
          ? { url: extractedAttempt.data.url }
          : { error: extractedAttempt.error }),
      });
      extracted = extractedAttempt.ok
        ? extractedAttempt.data
        : {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: "",
            truncated: false,
            media: null,
          };
    } else {
      const routed = await routeExtract({
        tabId: tab.id,
        url: tab.url,
        title: tab.title?.trim() ?? null,
        maxChars: settings.maxChars,
        minTextChars: 1,
        token: settings.token,
        noCache: Boolean(opts?.refresh),
        includeDiagnostics: settings.extendedLogging,
        signal: controller.signal,
        fetchImpl,
        extractFromTab,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return;
      logPanel(routed ? "extract:done" : "extract:failed", {
        ok: Boolean(routed),
        ...(routed
          ? { url: routed.extracted.url, source: routed.source }
          : { error: "No extractor result" }),
      });
      if (routed) {
        extracted = routed.extracted;
        routedResult = routed;
      } else {
        extracted = {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: null,
        };
      }
    }
  }

  if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    logPanel("extract:retry", { tabId: tab.id, maxChars: settings.maxChars });
    const retry = await extractFromTab(tab.id, settings.maxChars, {
      timeoutMs: 8_000,
      inputMode: requestedInputMode ?? undefined,
      log: (event, detail) => logPanel(event, detail),
    });
    if (isSuperseded()) return;
    if (retry.ok) {
      extracted = retry.data;
      routedResult = null;
    }
  }

  const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true;
  const resolvedExtracted =
    tab.url && !extractedMatchesTab
      ? {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: null,
        }
      : extracted;

  if (isSuperseded()) return;
  const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null;
  let resolvedPayload = { ...resolvedExtracted, title: resolvedTitle };
  const ensureLocalBrowserTranscript = async () => {
    if (!tab.id || browserTranscriptTimedText?.trim()) {
      return false;
    }
    const isYoutube = isYouTubeVideoUrl(resolvedPayload.url);
    if (!isYoutube && requestedInputMode !== "video" && !prefersUrlMode) return false;
    const localTranscript = isYoutube
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
        isYoutube
          ? "extract:url-direct:local-transcript-failed"
          : "extract:browser-media:local-transcript-failed",
        {
          error: localTranscript.error,
        },
      );
      return false;
    }
    if (!urlsMatch(localTranscript.url, tabUrl)) return false;
    browserTranscriptTimedText = localTranscript.transcriptTimedText;
    resolvedPayload = {
      ...resolvedPayload,
      text: localTranscript.text,
      truncated: localTranscript.truncated,
      mediaDurationSeconds: localTranscript.durationSeconds,
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
    };
    logPanel(
      isYoutube ? "extract:url-direct:local-transcript" : "extract:browser-media:transcript",
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
    return true;
  };
  if (useBrowserSummary) {
    await ensureLocalBrowserTranscript();
    if (isSuperseded()) return;
  }
  const effectiveInputMode =
    opts?.inputMode ??
    (resolvedPayload.media?.hasVideo === true ||
    resolvedPayload.media?.hasAudio === true ||
    resolvedPayload.media?.hasCaptions === true ||
    (resolvedPayload.url && isYouTubeVideoUrl(resolvedPayload.url))
      ? "video"
      : undefined);
  const wantsSummaryTimestamps =
    settings.summaryTimestamps &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      resolvedPayload.media?.hasAudio === true ||
      resolvedPayload.media?.hasCaptions === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsSlides =
    settings.slidesEnabled &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsDaemonSlides = wantsSlides && settings.slideRuntime === "daemon";
  const summaryTimestamps = wantsSummaryTimestamps || wantsSlides;

  logPanel("summarize:start", {
    reason,
    url: resolvedPayload.url,
    inputMode: effectiveInputMode ?? null,
    wantsSummaryTimestamps: summaryTimestamps,
    wantsSlides,
    wantsDaemonSlides,
    slideRuntime: settings.slideRuntime,
    wantsParallelSlides: false,
  });

  const cacheResolvedPayload = () => {
    const wordCount =
      resolvedPayload.text.length > 0
        ? resolvedPayload.text.split(/\s+/).filter(Boolean).length
        : 0;
    panelSessionStore.setCachedExtract(tab.id, {
      url: resolvedPayload.url,
      title: resolvedTitle,
      text: resolvedPayload.text,
      source: routedResult?.source ?? "page",
      truncated: resolvedPayload.truncated,
      totalCharacters: resolvedPayload.text.length,
      wordCount,
      media: resolvedPayload.media ?? null,
      transcriptSource: browserTranscriptTimedText ? "browser" : null,
      transcriptionProvider: browserTranscriptTimedText ? "browser" : null,
      transcriptCharacters: browserTranscriptTimedText ? resolvedPayload.text.length : null,
      transcriptWordCount: browserTranscriptTimedText ? wordCount : null,
      transcriptLines: browserTranscriptTimedText
        ? browserTranscriptTimedText.split("\n").filter(Boolean).length
        : null,
      transcriptTimedText: browserTranscriptTimedText,
      mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
      slides: null,
      diagnostics: routedResult?.diagnostics ?? null,
    });
  };
  cacheResolvedPayload();

  const sendBrowserSummarySnapshot = () => {
    const random =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const run: RunStart = {
      id: `browser-summary-${random}`,
      url: resolvedPayload.url,
      title: resolvedTitle,
      model: "Browser",
      reason,
      slides: wantsSlides,
    };
    session.activeSummaryRun = {
      run,
      startedAt: Date.now(),
      inputMode: requestedInputMode,
      slides: requestedWantsSlides,
    };
    session.inflightRequest = null;
    session.lastSummarizedUrl = resolvedPayload.url;
    clearCurrentRun();
    send({
      type: "run:snapshot",
      run,
      markdown: buildBrowserSummaryMarkdown({
        title: resolvedTitle,
        text: resolvedPayload.text,
        transcriptTimedText: browserTranscriptTimedText,
      }),
    });
    sendStatus("");
  };

  if (useBrowserSummary) {
    sendBrowserSummarySnapshot();
    return;
  }

  sendStatus("Connecting…");
  session.inflightUrl = resolvedPayload.url;
  const slidesConfig = wantsDaemonSlides
    ? {
        enabled: true as const,
        ocr: settings.slidesOcrEnabled,
        maxSlides: null,
        minDurationSeconds: null,
      }
    : { enabled: false as const };
  const summarySlides = slidesConfig;

  let id: string;
  try {
    const requestInputMode =
      browserTranscriptTimedText && resolvedPayload.text.trim().length > 0
        ? "page"
        : effectiveInputMode;
    const body = buildSummarizeRequestBody({
      extracted: resolvedPayload,
      settings,
      noCache: Boolean(opts?.refresh),
      inputMode: requestInputMode,
      timestamps: summaryTimestamps,
      slides: summarySlides,
    });
    logPanel("summarize:request", {
      url: resolvedPayload.url,
      slides: wantsDaemonSlides,
      slideRuntime: settings.slideRuntime,
      slidesParallel: false,
      timestamps: summaryTimestamps,
    });
    const res = await fetchImpl("http://127.0.0.1:8787/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
    if (isSuperseded()) return;
    if (!res.ok || !json.ok || !json.id) {
      throw new Error(json.error || `${res.status} ${res.statusText}`);
    }
    session.daemonStatus.markReady();
    id = json.id;
  } catch (err) {
    if (isSuperseded()) return;
    if (settings.slideRuntime === "browser") {
      if (isDaemonUnreachableError(err)) {
        session.daemonRecovery.recordFailure(resolvedPayload.url);
      }
      await ensureLocalBrowserTranscript();
      if (isSuperseded()) return;
      cacheResolvedPayload();
      sendBrowserSummarySnapshot();
      return;
    }
    const message = friendlyFetchError(err, "Daemon request failed");
    send({ type: "run:error", message });
    sendStatus(`Error: ${message}`);
    session.inflightUrl = null;
    session.inflightRequest = null;
    if (!isManual && isDaemonUnreachableError(err)) {
      session.daemonRecovery.recordFailure(resolvedPayload.url);
    }
    return;
  }

  const run: RunStart = {
    id,
    url: resolvedPayload.url,
    title: resolvedTitle,
    model: settings.model,
    reason,
    slides: wantsDaemonSlides,
  };
  session.activeSummaryRun = {
    run,
    startedAt: Date.now(),
    inputMode: requestedInputMode,
    slides: requestedWantsSlides,
  };
  session.inflightRequest = null;
  send({ type: "run:start", run });
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
