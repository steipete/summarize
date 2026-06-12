import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { encodeSseEvent } from "@steipete/summarize-core/runtime";
import { resolveValidSlideImagePath, type SlideExtractionResult } from "../slides/index.js";
import { json } from "./server-http.js";
import type { Session } from "./server-session.js";
import { attachBufferedSseSession } from "./server-sse.js";
import { buildSlidesPayload } from "./server-summarize-execution.js";
import { resolveHomeDir } from "./server-summarize-request.js";

export async function handleSessionRoutes(options: {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse<import("node:http").IncomingMessage>;
  pathname: string;
  cors: Record<string, string>;
  env: Record<string, string | undefined>;
  port: number;
  sessions: Map<string, Session>;
  refreshSessions: Map<string, Session>;
}) {
  const { req, res, pathname, cors, env, port, sessions, refreshSessions } = options;

  const slidesMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides$/);
  if (req.method === "GET" && slidesMatch) {
    const id = slidesMatch[1];
    const session = id ? sessions.get(id) : null;
    if (!session || !session.slides) {
      json(res, 200, { ok: false, error: "not found" }, cors);
      return true;
    }
    json(
      res,
      200,
      {
        ok: true,
        slides: buildSlidesPayload({
          slides: session.slides,
          port,
          transcriptTimedText: session.transcriptTimedText,
        }),
      },
      cors,
    );
    return true;
  }

  const slideImageMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides\/(\d+)$/);
  if (req.method === "GET" && slideImageMatch) {
    const id = slideImageMatch[1];
    const index = Number(slideImageMatch[2]);
    const session = id ? sessions.get(id) : null;
    if (!session || !session.slides || !Number.isFinite(index)) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }
    const slide = session.slides.slides.find((item) => item.index === index);
    if (!slide) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }
    try {
      const stat = await fs.stat(slide.imagePath);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": stat.size.toString(),
        "cache-control": "no-cache",
        ...cors,
      });
      const stream = createReadStream(slide.imagePath);
      stream.pipe(res);
      stream.on("error", () => res.end());
    } catch {
      json(res, 404, { ok: false, error: "not found" }, cors);
    }
    return true;
  }

  const stableSlideImageMatch = pathname.match(/^\/v1\/slides\/([^/]+)\/(\d+)$/);
  if (req.method === "GET" && stableSlideImageMatch) {
    const sourceId = stableSlideImageMatch[1];
    const index = Number(stableSlideImageMatch[2]);
    if (!sourceId || !Number.isFinite(index) || index <= 0) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }

    const slidesRoot = path.resolve(resolveHomeDir(env), ".summarize", "slides");
    const slidesDir = path.join(slidesRoot, sourceId);
    const payloadPath = path.join(slidesDir, "slides.json");

    const resolveFromDisk = async (): Promise<string | null> => {
      const raw = await fs.readFile(payloadPath, "utf8").catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as SlideExtractionResult;
          const slide = parsed?.slides?.find?.((item) => item?.index === index);
          if (slide?.imagePath) {
            const resolved = await resolveValidSlideImagePath(slidesDir, slide.imagePath);
            if (resolved) return resolved;
          }
        } catch {
          // fall through
        }
      }
      const prefix = `slide_${String(index).padStart(4, "0")}`;
      const entries = await fs.readdir(slidesDir).catch(() => null);
      if (!entries) return null;
      const candidates = entries
        .filter((name) => name.startsWith(prefix) && name.endsWith(".png"))
        .map((name) => path.join(slidesDir, name));
      if (candidates.length === 0) return null;
      let best: { filePath: string; mtimeMs: number } | null = null;
      for (const filePath of candidates) {
        const resolved = await resolveValidSlideImagePath(slidesDir, path.basename(filePath));
        if (!resolved) continue;
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isFile()) continue;
        const mtimeMs = stat.mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) best = { filePath: resolved, mtimeMs };
      }
      return best?.filePath ?? null;
    };

    const filePath = await resolveFromDisk();
    if (!filePath) {
      const placeholder = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
        "base64",
      );
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": placeholder.length.toString(),
        "cache-control": "no-store",
        "x-summarize-slide-ready": "0",
        ...cors,
      });
      res.end(placeholder);
      return true;
    }

    try {
      const stat = await fs.stat(filePath);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": stat.size.toString(),
        "cache-control": "no-store",
        "x-summarize-slide-ready": "1",
        ...cors,
      });
      const stream = createReadStream(filePath);
      stream.pipe(res);
      stream.on("error", () => res.end());
    } catch {
      json(res, 404, { ok: false, error: "not found" }, cors);
    }
    return true;
  }

  const eventsMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const id = eventsMatch[1];
    if (!id) {
      json(res, 404, { ok: false }, cors);
      return true;
    }
    const session = sessions.get(id);
    if (!session) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }
    attachBufferedSseSession({
      res,
      cors,
      buffer: session.buffer,
      clients: session.clients,
      done: session.done,
    });
    return true;
  }

  const slidesEventsMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides\/events$/);
  if (req.method === "GET" && slidesEventsMatch) {
    const id = slidesEventsMatch[1];
    if (!id) {
      json(res, 404, { ok: false }, cors);
      return true;
    }
    const session = sessions.get(id);
    if (!session || !session.slidesRequested) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }

    attachBufferedSseSession({
      res,
      cors,
      buffer: session.slidesBuffer,
      clients: session.slidesClients,
      done: session.slidesDone,
      afterReplay: () => {
        const hasSlidesEvent = session.slidesBuffer.some((entry) => entry.event.event === "slides");
        if (!hasSlidesEvent && session.slides) {
          res.write(
            encodeSseEvent({
              event: "slides",
              data: buildSlidesPayload({
                slides: session.slides,
                port,
                transcriptTimedText: session.transcriptTimedText,
              }),
            }),
          );
        }

        const hasStatusEvent = session.slidesBuffer.some((entry) => entry.event.event === "status");
        if (!hasStatusEvent && session.slidesLastStatus) {
          res.write(encodeSseEvent({ event: "status", data: { text: session.slidesLastStatus } }));
        }
      },
    });
    return true;
  }

  const refreshEventsMatch = pathname.match(/^\/v1\/refresh-free\/([^/]+)\/events$/);
  if (req.method === "GET" && refreshEventsMatch) {
    const id = refreshEventsMatch[1];
    if (!id) {
      json(res, 404, { ok: false }, cors);
      return true;
    }
    const session = refreshSessions.get(id);
    if (!session) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }

    attachBufferedSseSession({
      res,
      cors,
      buffer: session.buffer,
      clients: session.clients,
      done: session.done,
    });
    return true;
  }

  return false;
}
