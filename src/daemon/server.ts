import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import type { CacheState } from "../cache.js";
import { loadSummarizeConfig } from "../config.js";
import { createDaemonLogger } from "../logging/daemon.js";
import { setProcessObserver } from "../processes.js";
import { refreshFree } from "../refresh-free.js";
import { createCacheStateFromConfig, refreshCacheStoreIfMissing } from "../run/cache-state.js";
import { resolveExecutableInPath } from "../run/env.js";
import { createMediaCacheFromConfig } from "../run/media-cache-state.js";
import { type SseEvent } from "../shared/sse-events.js";
import type { SlideSettings } from "../slides/index.js";
import { resolvePackageVersion } from "../version.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import { type DaemonRequestedMode } from "./auto-mode.js";
import { daemonConfigTokens, isAuthorizedDaemonToken, type DaemonConfig } from "./config.js";
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from "./constants.js";
import { resolveDaemonLogPaths } from "./launchd.js";
import { ProcessRegistry } from "./process-registry.js";
import { handleAdminRoutes } from "./server-admin-routes.js";
import { handleAgentRoute } from "./server-agent-route.js";
import {
  clampNumber,
  corsHeaders,
  json,
  readBearerToken,
  readCorsHeaders,
  text,
} from "./server-http.js";
import { handleSessionRoutes } from "./server-session-routes.js";
import {
  createSession,
  emitMeta,
  emitSlides,
  emitSlidesDone,
  emitSlidesStatus,
  endSession,
  pushSlidesToSession,
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
import { isWindowsContainerEnvironment } from "./windows-container.js";

export { corsHeaders, isTrustedOrigin } from "./server-http.js";

const DAEMON_SHUTDOWN_ACTIVE_SESSION_GRACE_MS = 5000;
const DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT = 4;
const DAEMON_MAX_ACTIVE_SUMMARIES_LIMIT = 32;

function buildActiveSummarizeKey(request: {
  pageUrl: string;
  title: string | null;
  textContent: string;
  truncated: boolean;
  modelOverride: string | null;
  lengthRaw: string;
  languageRaw: string;
  promptOverride: string | null;
  noCache: boolean;
  mode: DaemonRequestedMode;
  maxCharacters: number | null;
  format: "text" | "markdown";
  overrides: unknown;
  slidesSettings: SlideSettings | null;
}) {
  const textHash = request.textContent
    ? createHash("sha256").update(request.textContent).digest("hex")
    : "";
  return createHash("sha256")
    .update(
      JSON.stringify({
        pageUrl: request.pageUrl,
        title: request.title,
        textHash,
        truncated: request.truncated,
        modelOverride: request.modelOverride,
        lengthRaw: request.lengthRaw,
        languageRaw: request.languageRaw,
        promptOverride: request.promptOverride,
        noCache: request.noCache,
        mode: request.mode,
        maxCharacters: request.maxCharacters,
        format: request.format,
        overrides: request.overrides,
        slidesSettings: request.slidesSettings,
      }),
    )
    .digest("hex");
}

export function resolveDaemonMaxActiveSummaries(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES?.trim();
  if (!raw) return DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT;
  return clampNumber(Math.floor(parsed), 1, DAEMON_MAX_ACTIVE_SUMMARIES_LIMIT);
}

async function drainActiveTasks(activeTasks: Set<Promise<void>>): Promise<void> {
  while (activeTasks.size > 0) {
    const tasks = [...activeTasks];
    await Promise.allSettled(tasks);
    for (const task of tasks) {
      activeTasks.delete(task);
    }
  }
}

export async function closeAfterActiveTasks({
  activeTasks,
  timeoutMs,
  close,
}: {
  activeTasks: Set<Promise<void>>;
  timeoutMs: number;
  close: () => void;
}): Promise<boolean> {
  const drainPromise = drainActiveTasks(activeTasks);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drained = false;
  try {
    drained = await Promise.race([
      drainPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (drained) {
    close();
  } else {
    void drainPromise.then(close).catch(() => {});
  }
  return drained;
}

export function resolveDaemonListenHost(env: Record<string, string | undefined>): string {
  return process.platform === "win32" && isWindowsContainerEnvironment(env)
    ? "0.0.0.0"
    : DAEMON_HOST;
}

function createLineWriter(onLine: (line: string) => void) {
  let buffer = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
      callback();
    },
    final(callback) {
      const line = buffer.trim();
      if (line) onLine(line);
      buffer = "";
      callback();
    },
  });
}

function resolveToolPath(
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string,
): string | null {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) return resolveExecutableInPath(explicit, env);
  return resolveExecutableInPath(binary, env);
}

export function buildHealthPayload(importMetaUrl?: string) {
  return { ok: true, pid: process.pid, version: resolvePackageVersion(importMetaUrl) };
}

export async function runDaemonServer({
  env,
  fetchImpl,
  config,
  port = config.port ?? DAEMON_PORT_DEFAULT,
  signal,
  onListening,
  onSessionEvent,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  config: DaemonConfig;
  port?: number;
  signal?: AbortSignal;
  onListening?: ((port: number) => void) | null;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
}): Promise<void> {
  const { config: summarizeConfig } = loadSummarizeConfig({ env });
  const daemonLogger = createDaemonLogger({ env, config: summarizeConfig });
  const daemonLogPaths = resolveDaemonLogPaths(env);
  const daemonLogFile =
    daemonLogger.config?.file ?? path.join(daemonLogPaths.logDir, "daemon.jsonl");
  const cacheState = await createCacheStateFromConfig({
    envForRun: env,
    config: summarizeConfig,
    noCacheFlag: false,
    transcriptNamespace: "yt:auto",
  });
  const mediaCache = await createMediaCacheFromConfig({
    envForRun: env,
    config: summarizeConfig,
    noMediaCacheFlag: false,
  });

  const processRegistry = new ProcessRegistry();
  setProcessObserver(processRegistry.createObserver());
  const listenHost = resolveDaemonListenHost(env);

  const sessions = new Map<string, Session>();
  const refreshSessions = new Map<string, Session>();
  const activeTasks = new Set<Promise<void>>();
  const maxActiveSummaries = resolveDaemonMaxActiveSummaries(env);
  let activeSummarizeCount = 0;
  let activeRefreshSessionId: string | null = null;
  const activeSummarizeRequests = new Map<string, string>();
  const authLimiter = new AuthRateLimiter();

  const reserveSummarizeSlot = (): (() => void) | null => {
    if (activeSummarizeCount >= maxActiveSummaries) return null;
    activeSummarizeCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSummarizeCount = Math.max(0, activeSummarizeCount - 1);
    };
  };

  const trackSummarizeTask = (task: Promise<unknown>, releaseSlot: () => void): void => {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    activeTasks.add(tracked);
    void tracked.finally(() => {
      activeTasks.delete(tracked);
      releaseSlot();
    });
  };

  const server = http.createServer((req, res) => {
    const requestTask = (async () => {
      const cors = readCorsHeaders(req);

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${DAEMON_HOST}:${port}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        json(res, 200, buildHealthPayload(import.meta.url), cors);
        return;
      }

      const token = readBearerToken(req);
      const authed = token ? isAuthorizedDaemonToken(token, daemonConfigTokens(config)) : false;
      if (pathname.startsWith("/v1/")) {
        // `req.socket.remoteAddress` is loopback in the common case; for
        // 0.0.0.0 binds inside Windows containers it's the caller's IP.
        const clientKey = req.socket.remoteAddress ?? null;
        const preCheck = authLimiter.check(clientKey);
        if (!preCheck.allowed) {
          json(
            res,
            429,
            { ok: false, error: "too many auth failures" },
            { ...cors, "retry-after": String(preCheck.retryAfterSeconds) },
          );
          return;
        }
        if (!authed) {
          const decision = authLimiter.recordFailure(clientKey);
          const headers = decision.allowed
            ? cors
            : { ...cors, "retry-after": String(decision.retryAfterSeconds) };
          json(
            res,
            decision.allowed ? 401 : 429,
            {
              ok: false,
              error: decision.allowed ? "unauthorized" : "too many auth failures",
            },
            headers,
          );
          return;
        }
        authLimiter.recordSuccess(clientKey);
      }

      if (
        await handleAdminRoutes({
          req,
          res,
          url,
          pathname,
          cors,
          env,
          fetchImpl,
          summarizeConfig,
          daemonLogger,
          daemonLogFile,
          daemonLogPaths,
          processRegistry,
          resolveToolPath,
        })
      ) {
        return;
      }

      if (req.method === "POST" && pathname === "/v1/refresh-free") {
        if (activeRefreshSessionId) {
          json(res, 200, { ok: true, id: activeRefreshSessionId, running: true }, cors);
          return;
        }

        const session = createSession(() => randomUUID());
        refreshSessions.set(session.id, session);
        activeRefreshSessionId = session.id;
        json(res, 200, { ok: true, id: session.id }, cors);

        void (async () => {
          const pushStatus = (text: string) => {
            pushToSession(session, { event: "status", data: { text } }, onSessionEvent);
          };
          try {
            pushStatus("Refresh free: starting…");
            const stdout = createLineWriter(pushStatus);
            const stderr = createLineWriter(pushStatus);
            await refreshFree({ env, fetchImpl, stdout, stderr });
            pushToSession(session, { event: "done", data: {} }, onSessionEvent);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushToSession(session, { event: "error", data: { message } }, onSessionEvent);
            console.error("[summarize-daemon] refresh-free failed", error);
          } finally {
            if (activeRefreshSessionId === session.id) {
              activeRefreshSessionId = null;
            }
            setTimeout(() => {
              refreshSessions.delete(session.id);
              endSession(session);
            }, 60_000).unref();
          }
        })();
        return;
      }

      if (req.method === "POST" && pathname === "/v1/summarize") {
        const request = await parseSummarizeRequest({
          req,
          res,
          cors,
          env,
          resolveToolPath,
        });
        if (!request) {
          return;
        }
        const urlFetchNeeded = request.extractOnly || request.mode === "url" || !request.hasText;
        let summarizeUrlFetchImpl: typeof fetch | null = null;
        if (urlFetchNeeded) {
          try {
            await assertDaemonUrlFetchAllowed(request.pageUrl);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            json(res, 400, { ok: false, error: message }, cors);
            return;
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
          promptOverride,
          noCache,
          extractOnly,
          mode,
          maxCharacters,
          format,
          overrides,
          slidesSettings,
          diagnostics,
          hasText,
        } = request;
        const includeContentLog = daemonLogger.enabled && diagnostics.includeContent;
        const activeRequestKey = extractOnly ? null : buildActiveSummarizeKey(request);
        if (activeRequestKey) {
          const activeRequestId = activeSummarizeRequests.get(activeRequestKey);
          const activeSession = activeRequestId ? sessions.get(activeRequestId) : null;
          if (activeRequestId && activeSession && !activeSession.done) {
            json(res, 200, { ok: true, id: activeRequestId, coalesced: true }, cors);
            return;
          }
          if (activeRequestId && !activeSession) {
            activeSummarizeRequests.delete(activeRequestKey);
          }
        }
        const releaseSummarizeSlot = reserveSummarizeSlot();
        if (!releaseSummarizeSlot) {
          json(
            res,
            429,
            { ok: false, error: `too many active summarize requests (max ${maxActiveSummaries})` },
            cors,
          );
          return;
        }
        let session: Session | null = null;
        try {
          if (!extractOnly) {
            session = createSession(() => randomUUID());
            session.slidesRequested = Boolean(slidesSettings);
            sessions.set(session.id, session);
            if (activeRequestKey) {
              activeSummarizeRequests.set(activeRequestKey, session.id);
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
            trackSummarizeTask(extractTask, releaseSummarizeSlot);
            await extractTask;
            return;
          }

          if (!session) {
            throw new Error("Failed to initialize summarize session.");
          }
          const activeSession = session;
          const requestLogger = daemonLogger.getSubLogger("daemon.summarize", {
            requestId: activeSession.id,
          });
          const logStartedAt = Date.now();
          let logSummaryFromCache = false;
          let logInputSummary: string | null = null;
          let logSummaryText = "";
          let logExtracted: Record<string, unknown> | null = null;
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
            sessions,
            refreshSessions,
          });
          if (activeRequestKey) {
            void summaryTask.finally(() => {
              if (activeSummarizeRequests.get(activeRequestKey) === activeSession.id) {
                activeSummarizeRequests.delete(activeRequestKey);
              }
            });
          }
          trackSummarizeTask(summaryTask, releaseSummarizeSlot);
          return;
        } catch (error) {
          if (activeRequestKey && session) {
            if (activeSummarizeRequests.get(activeRequestKey) === session.id) {
              activeSummarizeRequests.delete(activeRequestKey);
            }
            const message = error instanceof Error ? error.message : String(error);
            pushToSession(session, { event: "error", data: { message } }, onSessionEvent);
            if (session.slidesRequested) {
              emitSlidesDone(session, { ok: false, error: message }, onSessionEvent);
            }
            scheduleSessionCleanup({ sessions, refreshSessions, session });
          }
          releaseSummarizeSlot();
          throw error;
        }
      }

      if (await handleAgentRoute({ req, res, url, cors, env, createRunId: randomUUID })) {
        return;
      }

      if (
        await handleSessionRoutes({
          req,
          res,
          pathname,
          cors,
          env,
          port,
          sessions,
          refreshSessions,
        })
      ) {
        return;
      }

      text(res, 404, "Not found", cors);
    })().catch((error) => {
      const cors = readCorsHeaders(req);
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: message }, cors);
        return;
      }
      try {
        res.end();
      } catch {
        // ignore
      }
    });
    activeTasks.add(requestTask);
    void requestTask.finally(() => activeTasks.delete(requestTask));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, listenHost, () => {
        const address = server.address();
        const actualPort =
          address && typeof address === "object" && typeof address.port === "number"
            ? address.port
            : port;
        onListening?.(actualPort);
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      let resolved = false;
      const onStop = () => {
        if (resolved) return;
        resolved = true;
        server.close(() => resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      };
      process.once("SIGTERM", onStop);
      process.once("SIGINT", onStop);
      if (signal) {
        if (signal.aborted) {
          onStop();
        } else {
          signal.addEventListener("abort", onStop, { once: true });
        }
      }
    });
  } finally {
    await closeAfterActiveTasks({
      activeTasks,
      timeoutMs: DAEMON_SHUTDOWN_ACTIVE_SESSION_GRACE_MS,
      close: () => cacheState.store?.close(),
    });
  }
}
