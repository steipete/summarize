import type http from "node:http";
import { encodeSseEvent, type SseSlidesData } from "@steipete/summarize-core/runtime";
import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import { runWithProcessContext } from "../processes.js";
import { formatModelLabelForDisplay } from "../run/finish-line.js";
import type { SlideExtractionResult, SlideSettings, SlideSourceKind } from "../slides/index.js";
import { type DaemonRequestedMode, resolveAutoDaemonMode } from "./auto-mode.js";
import {
  emitMeta,
  emitSlides,
  emitSlidesDone,
  emitSlidesStatus,
  pushToSession,
  scheduleSessionCleanup,
  type Session,
  type SessionEvent,
} from "./server-session.js";
import type { ParsedSummarizeRequest } from "./server-summarize-request.js";
import {
  extractContentForUrl,
  streamSummaryForUrl,
  streamSummaryForVisiblePage,
} from "./summarize.js";
import { assertDaemonUrlFetchAllowed, createDaemonUrlFetchGuard } from "./url-fetch-guard.js";

type LoggerLike = {
  info?: (payload: Record<string, unknown>) => void;
  error?: (payload: Record<string, unknown>) => void;
};

type SlidesLogShape = {
  enabled: boolean;
  ocr: boolean;
  outputDir: string;
  sceneThreshold: number | null;
  autoTuneThreshold: boolean;
  maxSlides: number | null;
  minDurationSeconds: number | null;
};

type SlideLogState = {
  startedAt: number | null;
  requested: boolean;
  cacheHit: boolean;
  lastStatus: string | null;
  statusCount: number;
  elapsedMs: number | null;
  slidesCount: number | null;
  ocrAvailable: boolean | null;
  warnings: string[];
};

type ExecuteSummarizeSessionArgs = {
  session: Session;
  request: ParsedSummarizeRequest;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  urlFetchImpl?: typeof fetch | null;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  port: number;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
  requestLogger?: LoggerLike | null;
  includeContentLog: boolean;
  logStartedAt: number;
  logInput: {
    url: string;
    title: string | null;
    text: string | null;
    truncated: boolean | null;
  } | null;
  logSlidesSettings: SlidesLogShape | null;
  sessions: Map<string, Session>;
  refreshSessions: Map<string, Session>;
};

export function buildSlidesPayload({
  slides,
  port,
  transcriptTimedText,
}: {
  slides: SlideExtractionResult;
  port: number;
  transcriptTimedText?: string | null;
}): SseSlidesData {
  const baseUrl = `http://127.0.0.1:${port}/v1/slides/${slides.sourceId}`;
  return {
    sourceUrl: slides.sourceUrl,
    sourceId: slides.sourceId,
    sourceKind: slides.sourceKind,
    ocrAvailable: slides.ocrAvailable,
    transcriptTimedText: transcriptTimedText ?? null,
    slides: slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: slide.timestamp,
      imageUrl: `${baseUrl}/${slide.index}${
        typeof slide.imageVersion === "number" && slide.imageVersion > 0
          ? `?v=${slide.imageVersion}`
          : ""
      }`,
      ocrText: slide.ocrText ?? null,
      ocrConfidence: slide.ocrConfidence ?? null,
    })),
  };
}

export async function handleExtractOnlySummarizeRequest({
  request,
  env,
  fetchImpl,
  urlFetchImpl,
  cacheState,
  mediaCache,
}: {
  request: ParsedSummarizeRequest;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  urlFetchImpl?: typeof fetch | null;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
}): Promise<{
  extracted: Awaited<ReturnType<typeof extractContentForUrl>>["extracted"];
  slides: Awaited<ReturnType<typeof extractContentForUrl>>["slides"];
}> {
  const requestCache: CacheState = request.noCache
    ? { ...cacheState, mode: "bypass" as const, store: null }
    : cacheState;
  const runId = crypto.randomUUID();
  return await runWithProcessContext({ runId, source: "extract" }, async () =>
    extractContentForUrl({
      env,
      fetchImpl,
      urlFetchImpl,
      input: { url: request.pageUrl, title: request.title, maxCharacters: request.maxCharacters },
      cache: requestCache,
      mediaCache,
      overrides: request.overrides,
      format: request.format,
      slides: request.slidesSettings,
    }),
  );
}

function createSlideLogState(requested: boolean): SlideLogState {
  return {
    startedAt: null,
    requested,
    cacheHit: false,
    lastStatus: null,
    statusCount: 0,
    elapsedMs: null,
    slidesCount: null,
    ocrAvailable: null,
    warnings: [],
  };
}

function serializeSlideLogState(state: SlideLogState) {
  return {
    requested: true,
    cacheHit: state.cacheHit,
    lastStatus: state.lastStatus,
    statusCount: state.statusCount,
    elapsedMs: state.elapsedMs,
    slidesCount: state.slidesCount,
    ocrAvailable: state.ocrAvailable,
    warnings: state.warnings,
  };
}

function createLiveSlides(meta: {
  slidesDir: string;
  sourceUrl: string;
  sourceId: string;
  sourceKind: SlideSourceKind;
  ocrAvailable: boolean;
}): SlideExtractionResult {
  return {
    sourceUrl: meta.sourceUrl,
    sourceKind: meta.sourceKind,
    sourceId: meta.sourceId,
    slidesDir: meta.slidesDir,
    sceneThreshold: 0,
    autoTuneThreshold: false,
    autoTune: {
      enabled: false,
      chosenThreshold: 0,
      confidence: 0,
      strategy: "none",
    },
    maxSlides: 0,
    minSlideDuration: 0,
    ocrRequested: meta.ocrAvailable,
    ocrAvailable: meta.ocrAvailable,
    slides: [],
    warnings: [],
  };
}

export function toExtractOnlySlidesPayload(slides: SlideExtractionResult | null): {
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
} | null {
  if (!slides || slides.slides.length === 0) return null;
  return {
    sourceUrl: slides.sourceUrl,
    sourceId: slides.sourceId,
    sourceKind: slides.sourceKind,
    ocrAvailable: slides.ocrAvailable,
    slides: slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: slide.timestamp,
      ocrText: slide.ocrText ?? null,
      ocrConfidence: slide.ocrConfidence ?? null,
    })),
  };
}

export async function executeSummarizeSession({
  session,
  request,
  env,
  fetchImpl,
  urlFetchImpl,
  cacheState,
  mediaCache,
  port,
  onSessionEvent,
  requestLogger,
  includeContentLog,
  logStartedAt,
  logInput,
  logSlidesSettings,
  sessions,
  refreshSessions,
}: ExecuteSummarizeSessionArgs): Promise<void> {
  const {
    pageUrl,
    title,
    textContent,
    truncated,
    modelOverride,
    lengthRaw,
    languageRaw,
    promptOverride,
    noCache,
    mode,
    maxCharacters,
    format,
    overrides,
    slidesSettings,
    hasText,
  } = request;
  const slideLogState = createSlideLogState(Boolean(slidesSettings));
  let logSummaryFromCache = false;
  let logInputSummary: string | null = null;
  let logSummaryText = "";
  let logExtracted: Record<string, unknown> | null = null;

  try {
    let emittedOutput = false;
    const sink = {
      writeChunk: (chunk: string) => {
        emittedOutput = true;
        if (includeContentLog) logSummaryText += chunk;
        pushToSession(session, { event: "chunk", data: { text: chunk } }, onSessionEvent);
      },
      onModelChosen: (modelId: string) => {
        if (session.lastMeta.model === modelId) return;
        emittedOutput = true;
        emitMeta(
          session,
          { model: modelId, modelLabel: formatModelLabelForDisplay(modelId) },
          onSessionEvent,
        );
      },
      writeStatus: (text: string) => {
        const clean = text.trim();
        if (!clean) return;
        pushToSession(session, { event: "status", data: { text: clean } }, onSessionEvent);
      },
      writeMeta: (data: { inputSummary?: string | null; summaryFromCache?: boolean | null }) => {
        if (typeof data.inputSummary === "string") logInputSummary = data.inputSummary;
        if (typeof data.summaryFromCache === "boolean") {
          logSummaryFromCache = data.summaryFromCache;
        }
        emitMeta(
          session,
          {
            inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : null,
            summaryFromCache:
              typeof data.summaryFromCache === "boolean" ? data.summaryFromCache : null,
          },
          onSessionEvent,
        );
      },
    };

    const normalizedModelOverride =
      modelOverride && modelOverride.toLowerCase() !== "auto" ? modelOverride : null;
    const requestCache: CacheState = noCache
      ? { ...cacheState, mode: "bypass" as const, store: null }
      : cacheState;
    let liveSlides: SlideExtractionResult | null = null;

    const runWithMode = async (resolved: "url" | "page") => {
      if (resolved === "url" && slideLogState.requested) {
        slideLogState.startedAt = Date.now();
        console.log(`[summarize-daemon] slides: start url=${pageUrl} (session=${session.id})`);
        if (includeContentLog) {
          requestLogger?.info?.({
            event: "slides.start",
            url: pageUrl,
            sessionId: session.id,
            ...(logSlidesSettings ? { settings: logSlidesSettings } : {}),
          });
        }
      }

      if (resolved === "url") {
        await assertDaemonUrlFetchAllowed(pageUrl);
        const urlModeFetchImpl = createDaemonUrlFetchGuard(fetchImpl);
        return await streamSummaryForUrl({
          env,
          fetchImpl,
          urlFetchImpl: urlModeFetchImpl,
          modelOverride: normalizedModelOverride,
          promptOverride,
          lengthRaw,
          languageRaw,
          format,
          input: { url: pageUrl, title, maxCharacters },
          sink,
          cache: requestCache,
          mediaCache,
          overrides,
          slides: slidesSettings,
          hooks: {
            onExtracted: (content) => {
              session.transcriptTimedText = content.transcriptTimedText ?? null;
              if (includeContentLog) {
                logExtracted = content as unknown as Record<string, unknown>;
              }
            },
            onSlidesExtracted: (slides) => {
              session.slides = slides;
              slideLogState.slidesCount = slides.slides.length;
              slideLogState.ocrAvailable = slides.ocrAvailable;
              slideLogState.warnings = slides.warnings;
              if (slideLogState.startedAt) {
                slideLogState.elapsedMs = Date.now() - slideLogState.startedAt;
                console.log(
                  `[summarize-daemon] slides: done count=${slides.slides.length} ocr=${slides.ocrAvailable} elapsedMs=${slideLogState.elapsedMs} warnings=${slides.warnings.join("; ")}`,
                );
              }
              if (includeContentLog) {
                requestLogger?.info?.({
                  event: "slides.done",
                  url: pageUrl,
                  sessionId: session.id,
                  slidesCount: slides.slides.length,
                  ocrAvailable: slides.ocrAvailable,
                  elapsedMs: slideLogState.elapsedMs,
                  cacheHit: slideLogState.cacheHit,
                  warnings: slides.warnings,
                });
              }
              emitSlides(
                session,
                buildSlidesPayload({
                  slides,
                  port,
                  transcriptTimedText: session.transcriptTimedText,
                }),
                onSessionEvent,
              );
            },
            onSlidesDone: (result) => {
              emitSlidesDone(session, result, onSessionEvent);
            },
            onSlidesProgress: (text) => {
              const clean = typeof text === "string" ? text.trim() : "";
              if (!clean) return;
              slideLogState.lastStatus = clean;
              slideLogState.statusCount += 1;
              if (clean.toLowerCase().includes("cached")) {
                slideLogState.cacheHit = true;
              }
              const progressMatch = clean.match(/(\d+)%/);
              const progress = progressMatch ? Number(progressMatch[1]) : null;
              if (includeContentLog) {
                requestLogger?.info?.({
                  event: "slides.status",
                  url: pageUrl,
                  sessionId: session.id,
                  status: clean,
                  ...(progress !== null ? { progress } : {}),
                });
              }
              emitSlidesStatus(session, clean, onSessionEvent);
            },
            onSlideChunk: ({ slide, meta }) => {
              if (
                !slide ||
                !meta?.slidesDir ||
                !meta.sourceUrl ||
                !meta.sourceId ||
                !meta.sourceKind
              ) {
                return;
              }
              const nextSlides = liveSlides ?? createLiveSlides(meta);
              liveSlides = nextSlides;
              const existingIndex = nextSlides.slides.findIndex(
                (item) => item.index === slide.index,
              );
              if (existingIndex >= 0) {
                nextSlides.slides[existingIndex] = {
                  ...nextSlides.slides[existingIndex],
                  ...slide,
                };
              } else {
                nextSlides.slides.push(slide);
              }
              nextSlides.slides.sort((a, b) => a.index - b.index);
              session.slides = nextSlides;
              emitSlides(
                session,
                buildSlidesPayload({
                  slides: nextSlides,
                  port,
                  transcriptTimedText: session.transcriptTimedText,
                }),
                onSessionEvent,
              );
            },
          },
        });
      }

      return await streamSummaryForVisiblePage({
        env,
        fetchImpl,
        urlFetchImpl,
        modelOverride: normalizedModelOverride,
        promptOverride,
        lengthRaw,
        languageRaw,
        format,
        input: { url: pageUrl, title, text: textContent, truncated },
        sink,
        cache: requestCache,
        mediaCache,
        overrides,
      });
    };

    const result = await (async () => {
      if (mode !== "auto") return runWithMode(mode);
      const { primary, fallback } = resolveAutoDaemonMode({ url: pageUrl, hasText });
      try {
        return await runWithMode(primary);
      } catch (error) {
        if (!fallback || emittedOutput) throw error;
        sink.writeStatus("Primary failed. Trying fallback…");
        try {
          return await runWithMode(fallback);
        } catch (fallbackError) {
          const primaryMessage = error instanceof Error ? error.message : String(error);
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new Error(
            `Auto mode failed.\nPrimary (${primary}): ${primaryMessage}\nFallback (${fallback}): ${fallbackMessage}`,
          );
        }
      }
    })();

    if (!session.lastMeta.model) {
      emitMeta(
        session,
        {
          model: result.usedModel,
          modelLabel: formatModelLabelForDisplay(result.usedModel),
        },
        onSessionEvent,
      );
    }

    pushToSession(session, { event: "metrics", data: result.metrics }, onSessionEvent);
    pushToSession(session, { event: "done", data: {} }, onSessionEvent);
    requestLogger?.info?.({
      event: "summarize.done",
      url: pageUrl,
      mode,
      model: result.usedModel,
      elapsedMs: Date.now() - logStartedAt,
      summaryFromCache: logSummaryFromCache,
      inputSummary: logInputSummary,
      ...(includeContentLog && slideLogState.requested
        ? { slides: serializeSlideLogState(slideLogState) }
        : {}),
      ...(includeContentLog && !logSummaryFromCache
        ? {
            input: logInput,
            extracted: logExtracted,
            summary: logSummaryText,
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushToSession(session, { event: "error", data: { message } }, onSessionEvent);
    if (session.slidesRequested && !session.slidesDone) {
      emitSlidesDone(session, { ok: false, error: message }, onSessionEvent);
    }
    console.error("[summarize-daemon] summarize failed", error);
    requestLogger?.error?.({
      event: "summarize.error",
      url: request.pageUrl,
      mode: request.mode,
      elapsedMs: Date.now() - logStartedAt,
      summaryFromCache: logSummaryFromCache,
      inputSummary: logInputSummary,
      ...(includeContentLog && slideLogState.requested
        ? { slides: serializeSlideLogState(slideLogState) }
        : {}),
      error: {
        message,
        stack: error instanceof Error ? error.stack : null,
      },
      ...(includeContentLog && !logSummaryFromCache
        ? {
            input: logInput,
            extracted: logExtracted,
            summary: logSummaryText || null,
          }
        : {}),
    });
  } finally {
    scheduleSessionCleanup({ session, sessions, refreshSessions });
  }
}
