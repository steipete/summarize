import http from "node:http";
import { encodeSseEvent, type SseEvent } from "@steipete/summarize-core/runtime";

export function attachBufferedSseSession({
  res,
  cors,
  buffer,
  clients,
  done,
  afterReplay,
}: {
  res: http.ServerResponse;
  cors: Record<string, string>;
  buffer: Array<{ event: SseEvent }>;
  clients: Set<http.ServerResponse>;
  done: boolean;
  afterReplay?: (() => void) | null;
}) {
  res.writeHead(200, {
    ...cors,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  clients.add(res);

  for (const entry of buffer) {
    res.write(encodeSseEvent(entry.event));
  }
  afterReplay?.();

  if (done) {
    res.end();
    clients.delete(res);
    return;
  }

  const keepalive = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, 15_000);
  keepalive.unref();

  res.on("close", () => {
    clearInterval(keepalive);
    clients.delete(res);
  });
}
