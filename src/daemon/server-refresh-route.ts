import type http from "node:http";
import { Writable } from "node:stream";
import { cliMessage } from "../locale.js";
import { describeCliError, createCliTranslator, type CliMessage } from "../locale.js";
import { refreshFree } from "../refresh-free.js";
import { json } from "./server-http.js";
import type { DaemonRuntime } from "./server-runtime.js";
import { createSession, endSession, pushToSession, type SessionEvent } from "./server-session.js";

export async function handleRefreshFreeRoute({
  req,
  res,
  pathname,
  cors,
  env,
  fetchImpl,
  runtime,
  createSessionId,
  onSessionEvent,
  cleanupDelayMs = 60_000,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  cors: Record<string, string>;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  runtime: DaemonRuntime;
  createSessionId: () => string;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
  cleanupDelayMs?: number;
}): Promise<boolean> {
  if (req.method !== "POST" || pathname !== "/v1/refresh-free") return false;

  if (runtime.activeRefreshSessionId) {
    json(res, 200, { ok: true, id: runtime.activeRefreshSessionId, running: true }, cors);
    return true;
  }

  const session = createSession(createSessionId);
  runtime.registerRefreshSession(session);
  json(res, 200, { ok: true, id: session.id }, cors);

  void (async () => {
    const pushStatus = (text: string, message?: CliMessage) => {
      pushToSession(
        session,
        { event: "status", data: { text, ...(message ? { message } : {}) } },
        onSessionEvent,
      );
    };
    try {
      pushStatus(createCliTranslator("en")("refresh.begin"), cliMessage("refresh.begin"));
      const sink = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      await refreshFree({ env, fetchImpl, stdout: sink, stderr: sink, onMessage: pushStatus });
      pushToSession(session, { event: "done", data: {} }, onSessionEvent);
    } catch (error) {
      pushToSession(session, { event: "error", data: describeCliError(error) }, onSessionEvent);
      console.error("[summarize-daemon] refresh-free failed", error);
    } finally {
      runtime.finishRefreshSession(session.id);
      setTimeout(() => {
        runtime.refreshSessions.delete(session.id);
        endSession(session);
      }, cleanupDelayMs).unref();
    }
  })();
  return true;
}
