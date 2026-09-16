import { executeSummarize } from "../application/execute-summarize.js";
import type {
  SummarizeInput,
  SummarizeRequest,
  SummarizeRuntime,
} from "../application/summarize-contracts.js";
import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import { describeCliError, emitCliMessage } from "../locale.js";
import type { ExecFileFn } from "../markitdown.js";
import { execFileTracked } from "../processes.js";
import { runWithProcessContext } from "../processes.js";
import { formatModelLabelForDisplay } from "../run/finish-line.js";
import type { SlideExtractionResult } from "../slides/index.js";
import { resolveAutoDaemonMode } from "./auto-mode.js";
import {
  emitMeta,
  emitSlidesDone,
  pushToSession,
  scheduleSessionCleanup,
  type Session,
  type SessionEvent,
} from "./server-session.js";
import {
  createDaemonSummarizeEventAdapter,
  type SlidesLogShape,
} from "./server-summarize-events.js";
import type { ParsedSummarizeRequest } from "./server-summarize-request.js";
import { buildDaemonSummaryMetrics } from "./summarize-presentation.js";
import { assertDaemonUrlFetchAllowed, createDaemonUrlFetchGuard } from "./url-fetch-guard.js";

type LoggerLike = {
  info?: (payload: Record<string, unknown>) => void;
  error?: (payload: Record<string, unknown>) => void;
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

function toApplicationRequest({
  request,
  input,
  extractOnly = request.extractOnly,
}: {
  request: ParsedSummarizeRequest;
  input: SummarizeInput;
  extractOnly?: boolean;
}): SummarizeRequest {
  const modelOverride =
    request.modelOverride && request.modelOverride.toLowerCase() !== "auto"
      ? request.modelOverride
      : null;
  return {
    input,
    modelOverride,
    promptOverride: request.promptOverride,
    lengthRaw: request.lengthRaw,
    languageRaw: request.languageRaw,
    format: request.format,
    overrides: request.overrides,
    extractOnly,
    slides: request.slidesSettings,
  };
}

function toApplicationRuntime({
  runId,
  env,
  fetchImpl,
  urlFetchImpl,
  cache,
  mediaCache,
}: {
  runId: string;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  urlFetchImpl?: typeof fetch | null;
  cache: CacheState;
  mediaCache: MediaCache | null;
}): SummarizeRuntime {
  return {
    runId,
    env,
    fetch: fetchImpl,
    urlFetch: urlFetchImpl,
    execFile: execFileTracked as unknown as ExecFileFn,
    cache,
    mediaCache,
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
  extracted: Extract<
    Awaited<ReturnType<typeof executeSummarize>>,
    { kind: "extraction" }
  >["extracted"];
  slides: Extract<Awaited<ReturnType<typeof executeSummarize>>, { kind: "extraction" }>["slides"];
}> {
  const requestCache: CacheState = request.noCache
    ? { ...cacheState, mode: "bypass" as const, store: null }
    : cacheState;
  const runId = crypto.randomUUID();
  return await runWithProcessContext({ runId, source: "extract" }, async () => {
    const result = await executeSummarize(
      toApplicationRequest({
        request,
        input: {
          kind: "url",
          url: request.pageUrl,
          title: request.title,
          maxCharacters: request.maxCharacters,
        },
        extractOnly: true,
      }),
      toApplicationRuntime({
        runId,
        env,
        fetchImpl,
        urlFetchImpl,
        cache: requestCache,
        mediaCache,
      }),
    );
    if (result.kind !== "extraction") {
      throw new Error("Internal error: expected extraction result");
    }
    return { extracted: result.extracted, slides: result.slides };
  });
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
    noCache,
    mode,
    maxCharacters,
    slidesSettings,
    hasText,
  } = request;
  const eventAdapter = createDaemonSummarizeEventAdapter({
    session,
    pageUrl,
    slidesRequested: Boolean(slidesSettings),
    port,
    onSessionEvent,
    includeContentLog,
    requestLogger,
    logSlidesSettings,
  });

  try {
    const requestCache: CacheState = noCache
      ? { ...cacheState, mode: "bypass" as const, store: null }
      : cacheState;

    const runWithMode = async (resolved: "url" | "page") => {
      if (resolved === "url") eventAdapter.startSlides();

      let resolvedUrlFetch = urlFetchImpl;
      const input: SummarizeInput =
        resolved === "url"
          ? { kind: "url", url: pageUrl, title, maxCharacters }
          : { kind: "visible-page", url: pageUrl, title, text: textContent, truncated };
      if (resolved === "url") {
        await assertDaemonUrlFetchAllowed(pageUrl);
        resolvedUrlFetch = createDaemonUrlFetchGuard(fetchImpl);
      }

      const result = await executeSummarize(
        toApplicationRequest({ request, input, extractOnly: false }),
        toApplicationRuntime({
          runId: session.id,
          env,
          fetchImpl,
          urlFetchImpl: resolvedUrlFetch,
          cache: requestCache,
          mediaCache,
        }),
        eventAdapter.handleEvent,
      );
      if (result.kind !== "summary") {
        throw new Error("Internal error: expected summary result");
      }
      return result;
    };

    const result = await (async () => {
      if (mode !== "auto") return runWithMode(mode);
      const { primary, fallback } = resolveAutoDaemonMode({ url: pageUrl, hasText });
      try {
        return await runWithMode(primary);
      } catch (error) {
        if (!fallback || eventAdapter.state.emittedOutput) throw error;
        emitCliMessage(eventAdapter.writeStatus, "en", "progress.primaryFallback");
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

    pushToSession(
      session,
      { event: "metrics", data: buildDaemonSummaryMetrics(result) },
      onSessionEvent,
    );
    pushToSession(session, { event: "done", data: {} }, onSessionEvent);
    requestLogger?.info?.({
      event: "summarize.done",
      url: pageUrl,
      mode,
      model: result.usedModel,
      elapsedMs: Date.now() - logStartedAt,
      summaryFromCache: eventAdapter.state.summaryFromCache,
      inputSummary: eventAdapter.state.inputSummary,
      ...(includeContentLog && slidesSettings ? { slides: eventAdapter.serializeSlides() } : {}),
      ...(includeContentLog && !eventAdapter.state.summaryFromCache
        ? {
            input: logInput,
            extracted: eventAdapter.state.extracted,
            summary: eventAdapter.state.summaryText,
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushToSession(session, { event: "error", data: describeCliError(error) }, onSessionEvent);
    if (session.slidesRequested && !session.slideEvents.done) {
      emitSlidesDone(
        session,
        { ok: false, error: message, localized: describeCliError(error).localized },
        onSessionEvent,
      );
    }
    console.error("[summarize-daemon] summarize failed", error);
    requestLogger?.error?.({
      event: "summarize.error",
      url: request.pageUrl,
      mode: request.mode,
      elapsedMs: Date.now() - logStartedAt,
      summaryFromCache: eventAdapter.state.summaryFromCache,
      inputSummary: eventAdapter.state.inputSummary,
      ...(includeContentLog && slidesSettings ? { slides: eventAdapter.serializeSlides() } : {}),
      error: {
        message,
        stack: error instanceof Error ? error.stack : null,
      },
      ...(includeContentLog && !eventAdapter.state.summaryFromCache
        ? {
            input: logInput,
            extracted: eventAdapter.state.extracted,
            summary: eventAdapter.state.summaryText || null,
          }
        : {}),
    });
  } finally {
    scheduleSessionCleanup({ session, sessions, refreshSessions });
  }
}
