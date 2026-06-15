import {
  isDirectMediaUrl,
  isYouTubeVideoUrl,
  shouldPreferUrlMode,
} from "@steipete/summarize-core/content/url";
import { planMediaExtraction } from "../../lib/media-extraction-plan";
import type { RunStart } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import type { BrowserLocalMediaTranscript } from "./browser-local-transcript";
import { buildBrowserSummaryMarkdown } from "./browser-summary";
import { createCachedExtract, type CachedExtract } from "./cached-extract";
import type { ExtractResponse } from "./content-script-bridge";
import type { ExtractorContext } from "./extractors/router";
import { ensurePreparedPanelTranscript, preparePanelContent } from "./panel-content-preparation";
import { startPanelDaemonSummary } from "./panel-summary-daemon";
import type { BrowserYoutubeLocalTranscript } from "./youtube-local-transcript";
import { extractYouTubeTranscriptInTab } from "./youtube-transcript";

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
  const useBrowserSummary = settings.slideRuntime === "browser";
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
  const extractionPlan = planMediaExtraction({
    url: tabUrl,
    requestedInputMode: opts?.inputMode,
  });
  const requestedInputMode = extractionPlan.inputMode;
  const prefersUrlModeForTab = extractionPlan.prefersUrlMode;
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

  const prepared = await preparePanelContent({
    tab: { id: tab.id, url: tabUrl, title: tab.title },
    tabUrl,
    settings,
    reason,
    refresh: Boolean(opts?.refresh),
    requestedInputMode,
    useBrowserSummary,
    panelOpen: () => panelSessionStore.isPanelOpen(session),
    isSuperseded,
    signal: controller.signal,
    fetchImpl,
    extractFromTab,
    sendStatus,
    logPanel,
    urlsMatch,
    extractYouTubeTranscript,
    youtubeTranscriptTimeoutMs,
  });
  if (prepared.kind === "stale") {
    clearCurrentRun();
    sendStatus("");
    return;
  }
  if (prepared.kind === "superseded" || isSuperseded()) return;

  let preparedContent = prepared.content;
  let resolvedPayload = preparedContent.payload;
  const resolvedTitle = preparedContent.title;
  let browserTranscriptTimedText = preparedContent.transcriptTimedText;
  const ensureLocalBrowserTranscript = async () => {
    preparedContent = await ensurePreparedPanelTranscript({
      content: preparedContent,
      tab: { id: tab.id, url: tabUrl, title: tab.title },
      tabUrl,
      settings,
      requestedInputMode,
      sendStatus,
      logPanel,
      urlsMatch,
      transcribeYouTubeLocally,
      transcribeMediaLocally,
    });
    resolvedPayload = preparedContent.payload;
    browserTranscriptTimedText = preparedContent.transcriptTimedText;
  };
  if (useBrowserSummary) {
    await ensureLocalBrowserTranscript();
    if (isSuperseded()) return;
    const browserExtractionPlan = planMediaExtraction({
      url: resolvedPayload.url,
      requestedInputMode,
    });
    const requiresMediaTranscript =
      browserExtractionPlan.isYouTubeVideo ||
      isDirectMediaUrl(resolvedPayload.url) ||
      Boolean(resolvedPayload.media?.hasVideo || resolvedPayload.media?.hasAudio);
    const localTranscriptError = preparedContent.localTranscriptError
      ?.trim()
      .replace(/[.!?]+$/, "");
    const browserError =
      localTranscriptError && requiresMediaTranscript
        ? `Could not transcribe this media in Browser mode: ${localTranscriptError}. Switch Runtime to Daemon for broader media support.`
        : resolvedPayload.text.trim().length === 0
          ? browserExtractionPlan.localTranscriptKind
            ? "No transcript text was available in Browser mode. Switch Runtime to Daemon for broader media support."
            : "No readable text was available in Browser mode. Reload the page or switch Runtime to Daemon for URL extraction."
          : null;
    if (browserError) {
      send({ type: "run:error", message: browserError });
      sendStatus(`Error: ${browserError}`);
      clearCurrentRun();
      return;
    }
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
    panelSessionStore.setCachedExtract(
      tab.id,
      createCachedExtract({
        extracted: resolvedPayload,
        source: preparedContent.source,
        diagnostics: preparedContent.diagnostics,
        title: resolvedTitle,
        transcript: browserTranscriptTimedText
          ? {
              timedText: browserTranscriptTimedText,
              text: resolvedPayload.text,
              source: "browser",
              provider: "browser",
            }
          : null,
      }),
    );
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
    id = await startPanelDaemonSummary({
      extracted: resolvedPayload,
      settings,
      noCache: Boolean(opts?.refresh),
      inputMode: requestInputMode,
      timestamps: summaryTimestamps,
      slides: summarySlides,
      signal: controller.signal,
      fetchImpl,
      buildSummarizeRequestBody,
      log: logPanel,
    });
    if (isSuperseded()) return;
    session.daemonStatus.markReady();
  } catch (err) {
    if (isSuperseded()) return;
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
