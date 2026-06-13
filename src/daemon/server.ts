import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { resolveExecutableInPath } from "../application/environment.js";
import { loadSummarizeConfig } from "../config.js";
import { createDaemonLogger } from "../logging/daemon.js";
import { setProcessObserver } from "../processes.js";
import { createCacheStateFromConfig } from "../run/cache-state.js";
import { createMediaCacheFromConfig } from "../run/media-cache-state.js";
import { resolvePackageVersion } from "../version.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import type { DaemonConfig } from "./config.js";
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from "./constants.js";
import { resolveDaemonLogPaths } from "./launchd.js";
import { ProcessRegistry } from "./process-registry.js";
import { handleAdminRoutes } from "./server-admin-routes.js";
import { handleAgentRoute } from "./server-agent-route.js";
import { authorizeDaemonRequest } from "./server-auth.js";
import { corsHeaders, json, readCorsHeaders, text } from "./server-http.js";
import { handleRefreshFreeRoute } from "./server-refresh-route.js";
import { DaemonRuntime, resolveDaemonMaxActiveSummaries } from "./server-runtime.js";
import { handleSessionRoutes } from "./server-session-routes.js";
import type { SessionEvent } from "./server-session.js";
import { handleSummarizeRoute } from "./server-summarize-route.js";
import { isWindowsContainerEnvironment } from "./windows-container.js";

export { corsHeaders, isTrustedOrigin } from "./server-http.js";
export { closeAfterActiveTasks, resolveDaemonMaxActiveSummaries } from "./server-runtime.js";

const DAEMON_SHUTDOWN_ACTIVE_SESSION_GRACE_MS = 5000;

export function resolveDaemonListenHost(env: Record<string, string | undefined>): string {
  return process.platform === "win32" && isWindowsContainerEnvironment(env)
    ? "0.0.0.0"
    : DAEMON_HOST;
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

  const runtime = new DaemonRuntime({
    maxActiveSummaries: resolveDaemonMaxActiveSummaries(env),
  });
  const { sessions, refreshSessions } = runtime;
  const authLimiter = new AuthRateLimiter();

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

      if (!authorizeDaemonRequest({ req, res, pathname, cors, config, limiter: authLimiter })) {
        return;
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

      if (
        await handleRefreshFreeRoute({
          req,
          res,
          pathname,
          cors,
          env,
          fetchImpl,
          runtime,
          createSessionId: randomUUID,
          onSessionEvent,
        })
      ) {
        return;
      }

      if (
        await handleSummarizeRoute({
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
          createSessionId: randomUUID,
          onSessionEvent,
        })
      ) {
        return;
      }

      if (
        await handleAgentRoute({
          req,
          res,
          url,
          cors,
          env,
          cacheState,
          createRunId: randomUUID,
        })
      ) {
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
    runtime.trackRequestTask(requestTask);
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
    await runtime.closeAfterActiveTasks({
      timeoutMs: DAEMON_SHUTDOWN_ACTIVE_SESSION_GRACE_MS,
      close: () => cacheState.store?.close(),
    });
  }
}
