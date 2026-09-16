import type http from "node:http";
import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import { describeCliError } from "../locale.js";
import type { DaemonLogger } from "../logging/daemon.js";
import { refreshCacheStoreIfMissing } from "../run/cache-state.js";
import { json } from "./server-http.js";
import { buildActiveSummarizeKey, type DaemonRuntime } from "./server-runtime.js";
import {
  createSession,
  emitSlidesDone,
  pushToSession,
  scheduleSessionCleanup,
  type Session,
  type SessionEvent,
} from "./server-session.js";
import {
  executeSummarizeSession,
  handleExtractOnlySummarizeRequest,
  toExtractOnlySlidesPayload,
} from "./server-summarize-execution.js";
import { parseSummarizeRequest } from "./server-summarize-request.js";
import { assertDaemonUrlFetchAllowed, createDaemonUrlFetchGuard } from "./url-fetch-guard.js";

type ResolveToolPath = (
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string,
) => string | null;

export async function handleSummarizeRoute({
  req,
  res,
  pathname,
  cors,
  env,
  fetchImpl,
  cacheState,
  mediaCache,
  runtime,
  port,
  daemonLogger,
  resolveToolPath,
  createSessionId,
  onSessionEvent,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  cors: Record<string, string>;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  runtime: DaemonRuntime;
  port: number;
  daemonLogger: DaemonLogger;
  resolveToolPath: ResolveToolPath;
  createSessionId: () => string;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
}): Promise<boolean> {
  if (req.method !== "POST" || pathname !== "/v1/summarize") return false;

  const request = await parseSummarizeRequest({
    req,
    res,
    cors,
    env,
    resolveToolPath,
  });
  if (!request) return true;

  const urlFetchNeeded = request.extractOnly || request.mode === "url" || !request.hasText;
  let summarizeUrlFetchImpl: typeof fetch | null = null;
  if (urlFetchNeeded) {
    try {
      await assertDaemonUrlFetchAllowed(request.pageUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 400, { ok: false, error: message }, cors);
      return true;
    }
    summarizeUrlFetchImpl = createDaemonUrlFetchGuard(fetchImpl);
  }

  const {
    pageUrl,
    title,
    textContent,
    truncated,
    modelOverride,
    lengthRaw,
    languageRaw,
    noCache,
    extractOnly,
    mode,
    slidesSettings,
    diagnostics,
    hasText,
  } = request;
  const includeContentLog = daemonLogger.enabled && diagnostics.includeContent;
  const activeRequestKey = extractOnly ? null : buildActiveSummarizeKey(request);
  if (activeRequestKey) {
    const activeSession = runtime.findActiveSummarizeSession(activeRequestKey);
    if (activeSession) {
      json(res, 200, { ok: true, id: activeSession.id, coalesced: true }, cors);
      return true;
    }
  }

  const releaseSummarizeSlot = runtime.reserveSummarizeSlot();
  if (!releaseSummarizeSlot) {
    json(
      res,
      429,
      {
        ok: false,
        error: `too many active summarize requests (max ${runtime.maxActiveSummaries})`,
      },
      cors,
    );
    return true;
  }

  let session: Session | null = null;
  try {
    if (!extractOnly) {
      session = createSession(createSessionId);
      session.slidesRequested = Boolean(slidesSettings);
      runtime.sessions.set(session.id, session);
      if (activeRequestKey) {
        runtime.registerActiveSummarizeRequest(activeRequestKey, session.id);
      }
    }

    await refreshCacheStoreIfMissing({ cacheState, transcriptNamespace: "yt:auto" });
    if (extractOnly) {
      const extractTask = (async () => {
        try {
          const { extracted, slides } = await handleExtractOnlySummarizeRequest({
            request,
            env,
            fetchImpl,
            urlFetchImpl: summarizeUrlFetchImpl,
            cacheState,
            mediaCache,
          });
          const slidesPayload = toExtractOnlySlidesPayload(slides);
          json(
            res,
            200,
            {
              ok: true,
              extracted: {
                content: extracted.content,
                title: extracted.title,
                url: extracted.url,
                wordCount: extracted.wordCount,
                totalCharacters: extracted.totalCharacters,
                truncated: extracted.truncated,
                transcriptSource: extracted.transcriptSource ?? null,
                transcriptCharacters: extracted.transcriptCharacters ?? null,
                transcriptWordCount: extracted.transcriptWordCount ?? null,
                transcriptLines: extracted.transcriptLines ?? null,
                transcriptSegments: extracted.transcriptSegments ?? null,
                transcriptTimedText: extracted.transcriptTimedText ?? null,
                transcriptionProvider: extracted.transcriptionProvider ?? null,
                mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
                diagnostics: extracted.diagnostics,
              },
              ...(slidesPayload ? { slides: slidesPayload } : {}),
            },
            cors,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(res, 500, { ok: false, error: message }, cors);
        }
      })();
      runtime.trackSummarizeTask(extractTask, releaseSummarizeSlot);
      await extractTask;
      return true;
    }

    if (!session) {
      throw new Error("Failed to initialize summarize session.");
    }
    const activeSession = session;
    const requestLogger = daemonLogger.getSubLogger("daemon.summarize", {
      requestId: activeSession.id,
    });
    const logStartedAt = Date.now();
    const logInput = includeContentLog
      ? {
          url: pageUrl,
          title,
          text: hasText ? textContent : null,
          truncated: hasText ? truncated : null,
        }
      : null;
    const logSlidesSettings =
      includeContentLog && slidesSettings
        ? {
            enabled: slidesSettings.enabled,
            ocr: slidesSettings.ocr,
            outputDir: slidesSettings.outputDir,
            sceneThreshold: slidesSettings.sceneThreshold,
            autoTuneThreshold: slidesSettings.autoTuneThreshold,
            maxSlides: slidesSettings.maxSlides,
            minDurationSeconds: slidesSettings.minDurationSeconds,
          }
        : null;
    requestLogger?.info({
      event: "summarize.request",
      url: pageUrl,
      mode,
      hasText,
      noCache,
      length: lengthRaw,
      language: languageRaw,
      model: modelOverride,
      includeContent: includeContentLog,
      slides: Boolean(slidesSettings),
      ...(logSlidesSettings ? { slidesSettings: logSlidesSettings } : {}),
      ...(includeContentLog ? { diagnostics } : {}),
    });

    json(res, 200, { ok: true, id: activeSession.id }, cors);

    const summaryTask = executeSummarizeSession({
      session: activeSession,
      request,
      env,
      fetchImpl,
      urlFetchImpl: summarizeUrlFetchImpl,
      cacheState,
      mediaCache,
      port,
      onSessionEvent,
      requestLogger,
      includeContentLog,
      logStartedAt,
      logInput,
      logSlidesSettings,
      sessions: runtime.sessions,
      refreshSessions: runtime.refreshSessions,
    });
    if (activeRequestKey) {
      void summaryTask.finally(() => {
        runtime.clearActiveSummarizeRequest(activeRequestKey, activeSession.id);
      });
    }
    runtime.trackSummarizeTask(summaryTask, releaseSummarizeSlot);
    return true;
  } catch (error) {
    if (activeRequestKey && session) {
      runtime.clearActiveSummarizeRequest(activeRequestKey, session.id);
      const message = error instanceof Error ? error.message : String(error);
      pushToSession(session, { event: "error", data: describeCliError(error) }, onSessionEvent);
      if (session.slidesRequested) {
        emitSlidesDone(
          session,
          { ok: false, error: message, localized: describeCliError(error).localized },
          onSessionEvent,
        );
      }
      scheduleSessionCleanup({
        sessions: runtime.sessions,
        refreshSessions: runtime.refreshSessions,
        session,
      });
    }
    releaseSummarizeSlot();
    throw error;
  }
}
