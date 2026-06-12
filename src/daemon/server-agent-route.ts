import type http from "node:http";
import type { Message } from "@earendil-works/pi-ai";
import { encodeSseEvent, type SseEvent } from "@steipete/summarize-core/runtime";
import { runWithProcessContext } from "../processes.js";
import { completeAgentResponse, streamAgentResponse } from "./agent.js";
import { json, readJsonBody, wantsJsonResponse } from "./server-http.js";

export async function handleAgentRoute({
  req,
  res,
  url,
  cors,
  env,
  createRunId,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  cors: Record<string, string>;
  env: Record<string, string | undefined>;
  createRunId: () => string;
}) {
  if (!(req.method === "POST" && url.pathname === "/v1/agent")) {
    return false;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, 4_000_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 400, { ok: false, error: message }, cors);
    return true;
  }
  if (!body || typeof body !== "object") {
    json(res, 400, { ok: false, error: "invalid json" }, cors);
    return true;
  }

  const obj = body as Record<string, unknown>;
  const pageUrl = typeof obj.url === "string" ? obj.url.trim() : "";
  const pageTitle = typeof obj.title === "string" ? obj.title.trim() : null;
  const pageContent = typeof obj.pageContent === "string" ? obj.pageContent : "";
  const messages = obj.messages;
  const modelOverride = typeof obj.model === "string" ? obj.model.trim() : null;
  const tools = Array.isArray(obj.tools)
    ? obj.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const automationEnabled = Boolean(obj.automationEnabled);

  if (!pageUrl) {
    json(res, 400, { ok: false, error: "missing url" }, cors);
    return true;
  }

  const normalizedModelOverride =
    modelOverride && modelOverride.toLowerCase() !== "auto" ? modelOverride : null;
  const runId = `agent-${createRunId()}`;
  const wantsJson = wantsJsonResponse(req, url);
  if (wantsJson) {
    try {
      const assistant = await runWithProcessContext({ runId, source: "agent" }, async () =>
        completeAgentResponse({
          env,
          pageUrl,
          pageTitle,
          pageContent,
          messages,
          modelOverride: normalizedModelOverride,
          tools,
          automationEnabled,
        }),
      );
      json(res, 200, { ok: true, assistant }, cors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[summarize-daemon] agent failed", error);
      json(res, 500, { ok: false, error: message }, cors);
    }
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...cors,
  });

  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on("close", abort);
  res.on("close", abort);

  const writeEvent = (event: SseEvent) => {
    if (res.writableEnded) return;
    res.write(encodeSseEvent(event));
  };

  try {
    await runWithProcessContext({ runId, source: "agent" }, async () =>
      streamAgentResponse({
        env,
        pageUrl,
        pageTitle,
        pageContent,
        messages: messages as Message[],
        modelOverride: normalizedModelOverride,
        tools,
        automationEnabled,
        onChunk: (text) => writeEvent({ event: "chunk", data: { text } }),
        onAssistant: (assistant) => writeEvent({ event: "assistant", data: assistant }),
        signal: controller.signal,
      }),
    );
    writeEvent({ event: "done", data: {} });
    res.end();
  } catch (error) {
    if (controller.signal.aborted) return true;
    const message = error instanceof Error ? error.message : String(error);
    console.error("[summarize-daemon] agent failed", error);
    writeEvent({ event: "error", data: { message } });
    writeEvent({ event: "done", data: {} });
    res.end();
  }

  return true;
}
