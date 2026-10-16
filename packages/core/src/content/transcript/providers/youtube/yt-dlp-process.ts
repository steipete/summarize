import { signalTrackedProcess, spawnTracked } from "../../../../processes.js";
import {
  buildYtDlpDownloadArgs,
  parseYtDlpMetadataOutput,
  parseYtDlpProgressLine,
  type YtDlpMediaMetadata,
} from "./yt-dlp-protocol.js";

const YT_DLP_TIMEOUT_MS = 300_000;
const MAX_STDERR_BYTES = 8192;

type YtDlpDurationRequest = {
  ytDlpPath: string | null;
  url: string;
  timeoutMs?: number;
};

export async function fetchMediaMetadataWithYtDlp({
  ytDlpPath,
  url,
  timeoutMs = 30_000,
}: YtDlpDurationRequest): Promise<YtDlpMediaMetadata | null> {
  if (!ytDlpPath) return null;

  return new Promise((resolve) => {
    const args = ["--skip-download", "--dump-json", "--no-playlist", "--no-warnings", url];
    const { proc } = spawnTracked(ytDlpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: "yt-dlp",
      kind: "yt-dlp",
    });
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(
      () => {
        signalTrackedProcess(proc, "SIGKILL");
        resolve(null);
      },
      Math.max(1, Math.min(timeoutMs, 30_000)),
    );

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 ? parseYtDlpMetadataOutput(stdout) : null);
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

export async function fetchDurationSecondsWithYtDlp(
  request: YtDlpDurationRequest,
): Promise<number | null> {
  return (await fetchMediaMetadataWithYtDlp(request))?.durationSeconds ?? null;
}

export function runYtDlpDownload({
  ytDlpPath,
  url,
  output,
  format,
  extractAudio,
  extraArgs,
  onProgress,
}: {
  ytDlpPath: string;
  url: string;
  output: string;
  format: string;
  extractAudio: boolean;
  extraArgs?: string[];
  onProgress?: ((downloadedBytes: number, totalBytes: number | null) => void) | null;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildYtDlpDownloadArgs({
      url,
      output,
      format,
      extractAudio,
      extraArgs,
      progress: Boolean(onProgress),
    });

    const { proc, handle } = spawnTracked(ytDlpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: "yt-dlp",
      kind: "yt-dlp",
    });
    let stderr = "";
    let progressBuffer = "";
    let lastTotalBytes: number | null = null;

    const reportProgress = (downloadedBytes: number, totalBytes: number | null): void => {
      if (!onProgress) return;
      let normalizedTotal = totalBytes;
      if (typeof normalizedTotal === "number" && Number.isFinite(normalizedTotal)) {
        if (normalizedTotal > 0) {
          if (lastTotalBytes === null || normalizedTotal > lastTotalBytes) {
            lastTotalBytes = normalizedTotal;
          } else if (normalizedTotal < lastTotalBytes) {
            normalizedTotal = lastTotalBytes;
          }
        }
      } else if (lastTotalBytes !== null) {
        normalizedTotal = lastTotalBytes;
      }
      onProgress(downloadedBytes, normalizedTotal);
      if (normalizedTotal && normalizedTotal > 0) {
        const percent = Math.max(
          0,
          Math.min(100, Math.round((downloadedBytes / normalizedTotal) * 100)),
        );
        handle?.setProgress(percent, "download");
      }
    };

    const handleProgressChunk = (chunk: string): void => {
      if (!onProgress) return;
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseYtDlpProgressLine(line);
        if (progress) reportProgress(progress.downloadedBytes, progress.totalBytes);
      }
    };

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", handleProgressChunk);
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          const remaining = MAX_STDERR_BYTES - stderr.length;
          stderr += chunk.slice(0, remaining);
        }
        handleProgressChunk(chunk);
      });
    }

    const timeout = setTimeout(() => {
      signalTrackedProcess(proc, "SIGTERM");
      reject(new Error("yt-dlp download timeout"));
    }, YT_DLP_TIMEOUT_MS);

    proc.on("close", (code, signal) => {
      if (onProgress && progressBuffer.trim().length > 0) {
        const progress = parseYtDlpProgressLine(progressBuffer);
        if (progress) reportProgress(progress.downloadedBytes, progress.totalBytes);
      }
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      if (code === null) {
        reject(new Error(`yt-dlp terminated (${signal ?? "unknown"})${suffix}`));
        return;
      }
      reject(new Error(`yt-dlp exited with code ${code}${suffix}`));
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export { buildYtDlpDownloadArgs };
export type { YtDlpMediaMetadata };
