const MAX_BROWSER_MEDIA_BYTES = 128 * 1024 * 1024;
const BROWSER_FFMPEG_TIMEOUT_MS = 120_000;

type BrowserFfmpegWorkerResponse =
  | {
      error: string;
      id: number;
      ok: false;
      stderrText: string;
    }
  | {
      exitCode: number;
      files: Array<{ path: string; buffer: ArrayBuffer }>;
      id: number;
      ok: true;
      stderrText: string;
    };

export type BrowserFfmpegFrame = {
  imageUrl: string;
  timestamp: number;
};

export function isBrowserFfmpegMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function extractBrowserFfmpegFrames({
  mediaUrl,
  timestamps,
  onStatus,
}: {
  mediaUrl: string;
  timestamps: number[];
  onStatus?: ((status: string) => void) | null;
}): Promise<BrowserFfmpegFrame[]> {
  onStatus?.("Preparing FFmpeg WebAssembly...");
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "ffmpeg-wasm:frames",
    mediaUrl,
    timestamps,
  })) as { ok: true; frames: BrowserFfmpegFrame[] } | { ok: false; error: string } | undefined;
  if (!response?.ok) {
    throw new Error(response?.error || "FFmpeg WebAssembly offscreen runtime failed.");
  }
  return response.frames;
}

export async function extractBrowserFfmpegFramesInDocument({
  mediaUrl,
  timestamps,
  fetchImpl = fetch,
}: {
  mediaUrl: string;
  timestamps: number[];
  fetchImpl?: typeof fetch;
}): Promise<BrowserFfmpegFrame[]> {
  if (!isBrowserFfmpegMediaUrl(mediaUrl)) {
    throw new Error("FFmpeg WebAssembly requires a fetchable HTTP media URL.");
  }
  if (timestamps.length === 0) return [];

  const response = await fetchImpl(mediaUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Media download failed (${response.status} ${response.statusText}).`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_MEDIA_BYTES) {
    throw new Error("Media is too large for in-browser FFmpeg.");
  }
  const inputBytes = await readResponseWithLimit(response, MAX_BROWSER_MEDIA_BYTES);
  const inputPath = `/input${mediaExtension(mediaUrl, response.headers.get("content-type"))}`;
  const outputPaths = timestamps.map(
    (_timestamp, index) => `/slide_${String(index + 1).padStart(4, "0")}.png`,
  );
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const timestamp of timestamps) {
    args.push("-ss", String(timestamp), "-i", inputPath);
  }
  for (const [index, outputPath] of outputPaths.entries()) {
    args.push(
      "-map",
      `${index}:v:0`,
      "-frames:v",
      "1",
      "-vf",
      "scale=960:540:force_original_aspect_ratio=decrease",
      "-an",
      "-sn",
      outputPath,
    );
  }

  const files = await runBrowserFfmpeg({
    args,
    inputBytes,
    inputPath,
    outputPaths,
  });
  return await Promise.all(
    files.map(async (file, index) => ({
      imageUrl: await bytesToDataUrl(new Uint8Array(file.buffer), "image/png"),
      timestamp: timestamps[index] ?? 0,
    })),
  );
}

let creatingOffscreenDocument: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("Chrome offscreen documents are unavailable.");
  }
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreenDocument ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run local FFmpeg WebAssembly workers for daemonless media processing.",
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });
  await creatingOffscreenDocument;
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Media is too large for in-browser FFmpeg.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Media is too large for in-browser FFmpeg.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function mediaExtension(mediaUrl: string, contentType: string | null): string {
  const normalizedType = contentType?.split(";")[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  if (normalizedType && byType[normalizedType]) return byType[normalizedType];
  try {
    const pathname = new URL(mediaUrl).pathname;
    const match = /\.[a-z0-9]{2,5}$/iu.exec(pathname);
    return match?.[0]?.toLowerCase() ?? ".mp4";
  } catch {
    return ".mp4";
  }
}

function runBrowserFfmpeg({
  args,
  inputBytes,
  inputPath,
  outputPaths,
}: {
  args: string[];
  inputBytes: Uint8Array;
  inputPath: string;
  outputPaths: string[];
}): Promise<Array<{ path: string; buffer: ArrayBuffer }>> {
  const id = Date.now();
  const inputBuffer = exactArrayBuffer(inputBytes);
  const worker = new Worker(new URL("./browser-ffmpeg.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("FFmpeg WebAssembly timed out."));
    }, BROWSER_FFMPEG_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.addEventListener("error", (event) => {
      finish();
      reject(new Error(event.message || "FFmpeg WebAssembly worker failed."));
    });
    worker.addEventListener("message", (event: MessageEvent<BrowserFfmpegWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      finish();
      if (!response.ok) {
        reject(new Error(response.stderrText || response.error));
        return;
      }
      if (response.exitCode !== 0) {
        reject(
          new Error(
            response.stderrText || `FFmpeg WebAssembly exited with code ${response.exitCode}.`,
          ),
        );
        return;
      }
      resolve(response.files);
    });
    const assetBaseUrl = chrome.runtime.getURL("ffmpeg-wasm/");
    worker.postMessage(
      {
        args,
        assetBaseUrl,
        id,
        inputBuffer,
        inputPath,
        moduleUrl: chrome.runtime.getURL("ffmpeg-wasm/ffmpeg.js"),
        outputPaths,
      },
      [inputBuffer],
    );
  });
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function bytesToDataUrl(bytes: Uint8Array, type: string): Promise<string> {
  const blob = new Blob([exactArrayBuffer(bytes)], { type });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error ?? new Error("File read failed.")));
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.readAsDataURL(blob);
  });
}
