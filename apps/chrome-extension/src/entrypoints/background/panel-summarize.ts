import {
  isDirectMediaUrl,
  isLoomVideoUrl,
  isYouTubeVideoUrl,
  shouldPreferUrlMode,
} from "@steipete/summarize-core/content/url";
import { buildBrowserSummaryPayload } from "../../lib/browser-summary";
import {
  message as uiMessage,
  readLocalizedMessage,
  resolveText,
  type LocalizedText,
} from "../../lib/i18n";
import { planMediaExtraction } from "../../lib/media-extraction-plan";
import { resolveSummaryExecution } from "../../lib/model-routing";
import type { BgToPanel, RunStart } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import type { BrowserLocalMediaTranscript } from "./browser-local-transcript";
import { createCachedExtract, type CachedExtract } from "./cached-extract";
import type { ExtractResponse } from "./content-script-bridge";
import type { ExtractorContext } from "./extractors/router";
import { ensurePreparedPanelTranscript, preparePanelContent } from "./panel-content-preparation";
import { summarizePanelDirectly } from "./panel-direct-summary";
import { startPanelDaemonSummary } from "./panel-summary-daemon";
import {
  beginSummaryRequest,
  createSummaryRunId,
  recordActiveSummaryRun,
  shouldSkipSummaryRequest,
  type BackgroundSummarizeSession,
} from "./panel-summary-session";
import type { BrowserYoutubeLocalTranscript } from "./youtube-local-transcript";
import { extractYouTubeTranscriptInTab } from "./youtube-transcript";

type StoreLike<Session extends BackgroundSummarizeSession> = {
  isPanelOpen: (session: Session) => boolean;
  setCachedExtract: (tabId: number, value: CachedExtract) => void;
};

type SendFn = (
  msg: Extract<BgToPanel, { type: "run:error" | "run:start" | "slides:run" | "run:snapshot" }>,
) => void;

function resolveBrowserAiLength(value: string): "short" | "medium" | "long" {
  if (value === "short" || value === "medium") return value;
  return "long";
}

export async function summarizeActiveTab<Session extends BackgroundSummarizeSession>({
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
  daemonFetchImpl = fetchImpl,
  extractFromTab,
  urlsMatch,
  buildSummarizeRequestBody,
  friendlyFetchError,
  isDaemonUnreachableError,
  logPanel,
  transcribeYouTubeLocally = async () => ({
    ok: false,
    error: resolveText(uiMessage("error.localTranscriptUnavailable", { kind: "youtube" }), "en"),
    localized: uiMessage("error.localTranscriptUnavailable", { kind: "youtube" }),
  }),
  transcribeMediaLocally = async () => ({
    ok: false,
    error: resolveText(uiMessage("error.localTranscriptUnavailable", { kind: "media" }), "en"),
    localized: uiMessage("error.localTranscriptUnavailable", { kind: "media" }),
  }),
  extractYouTubeTranscript = extractYouTubeTranscriptInTab,
  youtubeTranscriptTimeoutMs = 12_000,
}: {
  session: Session;
  reason: string;
  opts?: { refresh?: boolean; inputMode?: "page" | "video" };
  loadSettings: () => Promise<Settings>;
  emitState: (session: Session, status: string) => Promise<void>;
  getActiveTab: (windowId?: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url?: string | null) => boolean;
  panelSessionStore: StoreLike<Session>;
  sendStatus: (status: LocalizedText) => void;
  send: SendFn;
  fetchImpl: typeof fetch;
  daemonFetchImpl?: typeof fetch;
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
  friendlyFetchError: typeof import("./daemon-client").friendlyFetchError;
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
  const summaryExecution = resolveSummaryExecution(settings);
  const isManual = reason === "manual" || reason === "refresh" || reason === "length-change";
  if (!isManual && !settings.autoSummarize) return;
  const useStandaloneExtraction = summaryExecution !== "daemon";
  if (summaryExecution === "daemon" && !settings.token.trim()) {
    await emitState(session, "");
    sendStatus(uiMessage("setup.required.missing.token"));
    return;
  }

  if (reason === "spa-nav" || reason === "tab-url-change") {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  const tab = await getActiveTab(session.windowId);
  if (!tab?.id || !canSummarizeUrl(tab.url)) return;
  const tabId = tab.id;
  const tabUrl = tab.url ?? "";
  const extractionPlan = planMediaExtraction({
    url: tabUrl,
    requestedInputMode: opts?.inputMode,
  });
  const requestedInputMode = extractionPlan.inputMode;
  const prefersUrlModeForTab = extractionPlan.prefersUrlMode;
  const requestedWantsSlides =
    settings.slidesEnabled && (requestedInputMode === "video" || prefersUrlModeForTab);
  const requestedRun = {
    url: tabUrl,
    inputMode: requestedInputMode,
    slides: requestedWantsSlides,
  };
  if (
    shouldSkipSummaryRequest({
      session,
      request: requestedRun,
      refresh: Boolean(opts?.refresh),
      reason,
      standaloneExtraction: useStandaloneExtraction,
      autoSummarize: settings.autoSummarize,
      manual: isManual,
      urlsMatch,
    })
  ) {
    sendStatus("");
    return;
  }

  const {
    controller,
    isSuperseded,
    clear: clearCurrentRun,
  } = beginSummaryRequest(session, requestedRun);

  const prepared = await preparePanelContent({
    tab: { id: tab.id, url: tabUrl, title: tab.title },
    tabUrl,
    settings,
    reason,
    refresh: Boolean(opts?.refresh),
    requestedInputMode,
    useBrowserSummary: useStandaloneExtraction,
    panelOpen: () => panelSessionStore.isPanelOpen(session),
    isSuperseded,
    signal: controller.signal,
    fetchImpl,
    daemonFetchImpl,
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
      tab: { id: tabId, url: tabUrl, title: tab.title },
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
  if (useStandaloneExtraction) {
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
    const localTranscriptError =
      readLocalizedMessage(preparedContent.localTranscriptMessage) ??
      preparedContent.localTranscriptError?.trim().replace(/[.!?]+$/, "");
    const browserError =
      localTranscriptError && requiresMediaTranscript
        ? uiMessage("error.standalone", { kind: "failed", error: localTranscriptError })
        : resolvedPayload.text.trim().length === 0
          ? browserExtractionPlan.localTranscriptKind
            ? uiMessage("error.standalone", { kind: "noTranscript", error: "" })
            : uiMessage("error.standalone", { kind: "noText", error: "" })
          : null;
    if (browserError) {
      send({
        type: "run:error",
        message: resolveText(browserError, "en"),
        localized: browserError,
      });
      sendStatus(uiMessage("error.message", { error: browserError }));
      clearCurrentRun();
      return;
    }
  }
  const allowPageMediaInference =
    !isLoomVideoUrl(resolvedPayload.url) || opts?.inputMode === "video";
  const effectiveInputMode =
    opts?.inputMode ??
    (allowPageMediaInference &&
    (resolvedPayload.media?.hasVideo === true ||
      resolvedPayload.media?.hasAudio === true ||
      resolvedPayload.media?.hasCaptions === true ||
      (resolvedPayload.url && isYouTubeVideoUrl(resolvedPayload.url)))
      ? "video"
      : undefined);
  const wantsSummaryTimestamps =
    settings.summaryTimestamps &&
    (effectiveInputMode === "video" ||
      (allowPageMediaInference &&
        (resolvedPayload.media?.hasVideo === true ||
          resolvedPayload.media?.hasAudio === true ||
          resolvedPayload.media?.hasCaptions === true)) ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsSlides =
    settings.slidesEnabled &&
    (effectiveInputMode === "video" ||
      (allowPageMediaInference && resolvedPayload.media?.hasVideo === true) ||
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
    summaryRuntime: settings.summaryRuntime,
    wantsParallelSlides: false,
  });

  const cacheResolvedPayload = () => {
    panelSessionStore.setCachedExtract(
      tabId,
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

  const daemonSlidesConfig = wantsDaemonSlides
    ? {
        enabled: true as const,
        ocr: settings.slidesOcrEnabled,
        maxSlides: null,
        minDurationSeconds: null,
      }
    : { enabled: false as const };
  const startStandaloneDaemonSlides = async () => {
    if (!wantsDaemonSlides) return;
    if (!settings.token.trim()) {
      send({
        type: "slides:run",
        ok: false,
        error: resolveText(uiMessage("error.daemonSlidesToken"), "en"),
        localized: uiMessage("error.daemonSlidesToken"),
      });
      return;
    }

    sendStatus(uiMessage("progress.daemonSlides"));
    try {
      const id = await startPanelDaemonSummary({
        extracted: resolvedPayload,
        settings: { ...settings, model: "auto" },
        noCache: Boolean(opts?.refresh),
        inputMode: effectiveInputMode,
        timestamps: true,
        slides: daemonSlidesConfig,
        signal: controller.signal,
        fetchImpl: daemonFetchImpl,
        buildSummarizeRequestBody,
        log: logPanel,
      });
      if (isSuperseded()) return;
      session.daemonStatus.markReady();
      send({
        type: "slides:run",
        ok: true,
        runId: id,
        url: resolvedPayload.url,
      });
      sendStatus("");
    } catch (error) {
      if (isSuperseded()) return;
      const { message, localized } = friendlyFetchError(error, "daemonSlides");
      send({ type: "slides:run", ok: false, error: message, localized });
      sendStatus(uiMessage("error.slidesFailed", { error: localized }));
    }
  };

  const sendBrowserSummarySnapshot = () => {
    const run: RunStart = {
      id: createSummaryRunId("browser"),
      url: resolvedPayload.url,
      title: resolvedTitle,
      model: "Browser",
      reason,
      slides: wantsSlides,
    };
    recordActiveSummaryRun({ session, run, request: requestedRun });
    const browserSummary = buildBrowserSummaryPayload({
      title: resolvedTitle,
      text: resolvedPayload.text,
      transcriptTimedText: browserTranscriptTimedText,
    });
    sendStatus("");
    send({
      type: "run:snapshot",
      run,
      markdown: browserSummary.markdown,
      browserAi: {
        text: browserSummary.sourceText,
        length: resolveBrowserAiLength(settings.length),
        keyMoments: browserSummary.keyMoments,
      },
    });
  };

  if (summaryExecution === "browser") {
    sendBrowserSummarySnapshot();
    await startStandaloneDaemonSlides();
    clearCurrentRun();
    return;
  }

  if (summaryExecution === "direct") {
    sendStatus(uiMessage("progress.provider"));
    try {
      const result = await summarizePanelDirectly({
        extracted: resolvedPayload,
        title: resolvedTitle,
        transcriptTimedText: browserTranscriptTimedText,
        settings,
        signal: controller.signal,
        fetchImpl,
      });
      if (isSuperseded()) return;
      const run: RunStart = {
        id: createSummaryRunId("direct"),
        url: resolvedPayload.url,
        title: resolvedTitle,
        model: result.model,
        reason,
        slides: wantsSlides,
      };
      recordActiveSummaryRun({ session, run, request: requestedRun });
      sendStatus("");
      send({ type: "run:snapshot", run, markdown: result.text });
      await startStandaloneDaemonSlides();
      clearCurrentRun();
      return;
    } catch (error) {
      if (isSuperseded()) return;
      const { message, localized } = friendlyFetchError(error, "directProvider");
      send({ type: "run:error", message, localized });
      sendStatus(uiMessage("error.message", { error: localized }));
      clearCurrentRun();
      return;
    }
  }

  sendStatus(uiMessage("connecting"));
  session.inflightUrl = resolvedPayload.url;

  let id: string;
  try {
    const requestInputMode =
      browserTranscriptTimedText && resolvedPayload.text.trim().length > 0 && !wantsDaemonSlides
        ? "page"
        : effectiveInputMode;
    id = await startPanelDaemonSummary({
      extracted: resolvedPayload,
      settings,
      noCache: Boolean(opts?.refresh),
      inputMode: requestInputMode,
      timestamps: summaryTimestamps,
      slides: daemonSlidesConfig,
      signal: controller.signal,
      fetchImpl: daemonFetchImpl,
      buildSummarizeRequestBody,
      log: logPanel,
    });
    if (isSuperseded()) return;
    session.daemonStatus.markReady();
  } catch (err) {
    if (isSuperseded()) return;
    const { message, localized } = friendlyFetchError(err, "daemonRequest");
    send({ type: "run:error", message, localized });
    sendStatus(uiMessage("error.message", { error: localized }));
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
