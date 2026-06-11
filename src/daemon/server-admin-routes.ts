import { promises as fs } from "node:fs";
import http from "node:http";
import { hasBundledFfmpegWasm } from "@steipete/summarize-core/ffmpeg";
import type { SummarizeConfig } from "../config.js";
import type { DaemonLogger } from "../logging/daemon.js";
import { buildModelPickerOptions } from "./models.js";
import {
  buildProcessListResult,
  buildProcessLogsResult,
  type ProcessRegistry,
} from "./process-registry.js";
import { clampNumber, json } from "./server-http.js";

async function readLogTail({
  filePath,
  maxBytes,
  maxLines,
}: {
  filePath: string;
  maxBytes: number;
  maxLines: number;
}): Promise<{ lines: string[]; truncated: boolean; bytesRead: number }> {
  const stat = await fs.stat(filePath);
  const size = stat.size;
  const readBytes = Math.max(0, Math.min(size, maxBytes));
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    const start = Math.max(0, size - readBytes);
    await handle.read(buffer, 0, readBytes, start);
    let text = buffer.toString("utf8");
    let truncated = size > readBytes;
    if (truncated) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
    }
    let lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length > maxLines) {
      lines = lines.slice(lines.length - maxLines);
      truncated = true;
    }
    return { lines, truncated, bytesRead: readBytes };
  } finally {
    await handle.close();
  }
}

export async function handleAdminRoutes({
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
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  cors: Record<string, string>;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  summarizeConfig: SummarizeConfig | null;
  daemonLogger: DaemonLogger;
  daemonLogFile: string;
  daemonLogPaths: { stdoutPath: string; stderrPath: string };
  processRegistry: ProcessRegistry;
  resolveToolPath: (
    binary: string,
    env: Record<string, string | undefined>,
    explicitEnvKey?: string,
  ) => string | null;
}): Promise<boolean> {
  if (req.method === "GET" && pathname === "/v1/ping") {
    json(res, 200, { ok: true }, cors);
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/logs") {
    const source = url.searchParams.get("source")?.trim() || "daemon";
    const tailParam = url.searchParams.get("tail")?.trim() || "";
    const tail = clampNumber(Number(tailParam || "800"), 50, 5000);
    const maxBytes = clampNumber(
      Number(url.searchParams.get("maxBytes") ?? "262144"),
      16_384,
      2_000_000,
    );

    const sources: Record<
      string,
      { filePath: string; format: "json" | "pretty" | "text"; enabled?: boolean }
    > = {
      daemon: {
        filePath: daemonLogFile,
        format: daemonLogger.config?.format ?? "json",
        enabled: daemonLogger.enabled,
      },
      stdout: { filePath: daemonLogPaths.stdoutPath, format: "text" },
      stderr: { filePath: daemonLogPaths.stderrPath, format: "text" },
    };

    const selected = sources[source];
    if (!selected) {
      json(res, 400, { ok: false, error: `Unknown log source "${source}".` }, cors);
      return true;
    }

    const stat = await fs.stat(selected.filePath).catch(() => null);
    if (!stat?.isFile()) {
      const disabledNote =
        source === "daemon" && selected.enabled === false
          ? "Daemon logging is disabled (no log file)."
          : "Log file not found.";
      json(res, 404, { ok: false, error: disabledNote }, cors);
      return true;
    }

    const { lines, truncated, bytesRead } = await readLogTail({
      filePath: selected.filePath,
      maxBytes,
      maxLines: tail,
    });
    const warning =
      source === "daemon" && selected.enabled === false
        ? "Daemon logging disabled; showing existing file only."
        : null;
    json(
      res,
      200,
      {
        ok: true,
        source,
        format: selected.format,
        lines,
        truncated,
        bytesRead,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(warning ? { warning } : {}),
      },
      cors,
    );
    return true;
  }

  const processLogsMatch = pathname.match(/^\/v1\/processes\/([^/]+)\/logs$/);
  if (req.method === "GET" && processLogsMatch) {
    const id = processLogsMatch[1];
    const tail = clampNumber(Number(url.searchParams.get("tail") ?? "200"), 20, 1000);
    const streamRaw = (url.searchParams.get("stream") ?? "merged").toLowerCase();
    const stream =
      streamRaw === "stdout" || streamRaw === "stderr" ? streamRaw : ("merged" as const);
    const result = buildProcessLogsResult(processRegistry, id, { tail, stream });
    if (!result) {
      json(res, 404, { ok: false, error: "not found" }, cors);
      return true;
    }
    json(res, 200, result, cors);
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/processes") {
    const includeCompleted =
      (url.searchParams.get("includeCompleted") ?? "").toLowerCase() === "true" ||
      url.searchParams.get("includeCompleted") === "1";
    const limit = clampNumber(Number(url.searchParams.get("limit") ?? "80"), 10, 200);
    const result = buildProcessListResult(processRegistry, { includeCompleted, limit });
    json(res, 200, result, cors);
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const result = await buildModelPickerOptions({
      env,
      envForRun: env,
      configForCli: summarizeConfig,
      fetchImpl,
    });
    json(res, 200, result, cors);
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/tools") {
    const ytDlpPath = resolveToolPath("yt-dlp", env, "YT_DLP_PATH");
    const ffmpegPath = resolveToolPath("ffmpeg", env, "FFMPEG_PATH");
    const ffmpegFallback = ffmpegPath
      ? null
      : hasBundledFfmpegWasm()
        ? "bundled:ffmpeg-wasm"
        : null;
    const tesseractPath = resolveToolPath("tesseract", env, "TESSERACT_PATH");
    json(
      res,
      200,
      {
        ok: true,
        tools: {
          ytDlp: { available: Boolean(ytDlpPath), path: ytDlpPath },
          ffmpeg: {
            available: Boolean(ffmpegPath || ffmpegFallback),
            path: ffmpegPath ?? ffmpegFallback,
          },
          tesseract: { available: Boolean(tesseractPath), path: tesseractPath },
        },
      },
      cors,
    );
    return true;
  }

  return false;
}
