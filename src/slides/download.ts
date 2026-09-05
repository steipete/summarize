import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSharedVideoMediaCacheKey } from "@steipete/summarize-core/content";
import type { ProcessHandle } from "../processes.js";
import { runProcess, runProcessCapture } from "./process.js";

const YT_DLP_TIMEOUT_MS = 300_000;

export function buildYtDlpCookiesArgs(cookiesFromBrowser?: string | null): string[] {
  const value = typeof cookiesFromBrowser === "string" ? cookiesFromBrowser.trim() : "";
  return value.length > 0 ? ["--cookies-from-browser", value] : [];
}

export function buildSlidesMediaCacheKey(url: string): string {
  return buildSharedVideoMediaCacheKey(url);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0] ?? "B";
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

export async function downloadYoutubeVideo(options: {
  ytDlpPath: string;
  url: string;
  timeoutMs: number;
  format: string;
  cookiesFromBrowser?: string | null;
  onProgress?: ((percent: number, detail?: string) => void) | null;
}): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const { ytDlpPath, url, timeoutMs, format, cookiesFromBrowser, onProgress } = options;
  return withDownloadDirectory(async (dir) => {
    const outputTemplate = path.join(dir, "video.%(ext)s");
    const progressTemplate =
      "progress:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s";
    const args = [
      "-f",
      format,
      "--no-playlist",
      "--no-warnings",
      "--concurrent-fragments",
      "4",
      ...buildYtDlpCookiesArgs(cookiesFromBrowser),
      ...(onProgress ? ["--progress", "--newline", "--progress-template", progressTemplate] : []),
      "-o",
      outputTemplate,
      url,
    ];
    const reportProgress = (line: string, handle: ProcessHandle | null, allowStandard = false) => {
      if (!onProgress) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("progress:")) {
        const payload = trimmed.slice("progress:".length);
        const [downloadedRaw, totalRaw, estimateRaw] = payload.split("|");
        const downloaded = Number.parseFloat(downloadedRaw);
        if (!Number.isFinite(downloaded) || downloaded < 0) return;
        const totalCandidate = Number.parseFloat(totalRaw);
        const estimateCandidate = Number.parseFloat(estimateRaw);
        const totalBytes =
          Number.isFinite(totalCandidate) && totalCandidate > 0
            ? totalCandidate
            : Number.isFinite(estimateCandidate) && estimateCandidate > 0
              ? estimateCandidate
              : null;
        if (!totalBytes || totalBytes <= 0) return;
        const percent = Math.max(0, Math.min(100, Math.round((downloaded / totalBytes) * 100)));
        const detail = `(${formatBytes(downloaded)}/${formatBytes(totalBytes)})`;
        onProgress(percent, detail);
        handle?.setProgress(percent, detail);
        return;
      }
      if (!allowStandard || !trimmed.startsWith("[download]")) return;
      const percentMatch = trimmed.match(/\b(\d{1,3}(?:\.\d+)?)%(?=\s|$)/);
      if (!percentMatch) return;
      const percent = Number(percentMatch[1]);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
      const etaMatch = trimmed.match(/\bETA\s+(\S+)\b/);
      const speedMatch = trimmed.match(/\bat\s+(\S+)\b/);
      const detailParts = [
        speedMatch?.[1] ? `at ${speedMatch[1]}` : null,
        etaMatch?.[1] ? `ETA ${etaMatch[1]}` : null,
      ].filter(Boolean);
      const detail = detailParts.length ? detailParts.join(" ") : undefined;
      onProgress(percent, detail);
      handle?.setProgress(percent, detail ?? null);
    };
    await runProcess({
      command: ytDlpPath,
      args,
      timeoutMs: Math.max(timeoutMs, YT_DLP_TIMEOUT_MS),
      errorLabel: "yt-dlp",
      onStderrLine: (line, handle) => reportProgress(line, handle, true),
      onStdoutLine: onProgress ? reportProgress : undefined,
    });

    const files = await fs.readdir(dir);
    const candidates = [];
    for (const entry of files) {
      if (entry.endsWith(".part") || entry.endsWith(".ytdl")) continue;
      const filePath = path.join(dir, entry);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) {
        candidates.push({ filePath, size: stat.size });
      }
    }
    if (candidates.length === 0) {
      throw new Error("yt-dlp completed but no video file was downloaded.");
    }
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0].filePath;
  });
}

export async function downloadRemoteVideo(options: {
  url: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onProgress?: ((percent: number, detail?: string) => void) | null;
}): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const { url, timeoutMs, fetchImpl = fetch, onProgress } = options;
  return withDownloadDirectory(async (dir) => {
    let suffix = ".bin";
    try {
      const parsed = new URL(url);
      const ext = path.extname(parsed.pathname);
      if (ext) suffix = ext;
    } catch {
      // ignore
    }
    const filePath = path.join(dir, `video${suffix}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }
      const totalRaw = res.headers.get("content-length");
      const total = totalRaw ? Number(totalRaw) : 0;
      const hasTotal = Number.isFinite(total) && total > 0;
      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("Download failed: missing response body");
      }
      const handle = await fs.open(filePath, "w");
      let downloaded = 0;
      let lastPercent = -1;
      let lastReportedBytes = 0;
      const reportProgress = () => {
        if (!onProgress) return;
        if (hasTotal) {
          const percent = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
          if (percent === lastPercent) return;
          lastPercent = percent;
          const detail = `(${formatBytes(downloaded)}/${formatBytes(total)})`;
          onProgress(percent, detail);
          return;
        }
        if (downloaded - lastReportedBytes < 2 * 1024 * 1024) return;
        lastReportedBytes = downloaded;
        onProgress(0, `(${formatBytes(downloaded)})`);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          await handle.write(value);
          downloaded += value.byteLength;
          reportProgress();
        }
      } finally {
        await handle.close();
      }
      if (hasTotal) {
        onProgress?.(100, `(${formatBytes(downloaded)}/${formatBytes(total)})`);
      }
      return filePath;
    } finally {
      clearTimeout(timeout);
    }
  });
}

export async function resolveYoutubeStreamUrl(options: {
  ytDlpPath: string;
  url: string;
  timeoutMs: number;
  format: string;
  cookiesFromBrowser?: string | null;
}): Promise<string> {
  const { ytDlpPath, url, timeoutMs, format, cookiesFromBrowser } = options;
  const args = ["-f", format, ...buildYtDlpCookiesArgs(cookiesFromBrowser), "-g", url];
  const output = await runProcessCapture({
    command: ytDlpPath,
    args,
    timeoutMs: Math.max(timeoutMs, YT_DLP_TIMEOUT_MS),
    errorLabel: "yt-dlp",
  });
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("yt-dlp did not return a stream URL.");
  }
  return lines[0];
}

async function withDownloadDirectory(download: (directory: string) => Promise<string>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "summarize-slides-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    return { filePath: await download(directory), cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
