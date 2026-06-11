import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  Input,
  type WrappedCanvas,
  UrlSource,
} from "mediabunny";
import { BrowserPcmAccumulator } from "./browser-media-audio";

const MAX_BROWSER_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_BROWSER_PCM_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_PCM_CHUNK_BYTES = 64 * 1024 * 1024;
const BROWSER_AUDIO_CHUNK_SECONDS = 15 * 60;
const BROWSER_MEDIA_URL_CACHE_BYTES = 24 * 1024 * 1024;
const TARGET_AUDIO_SAMPLE_RATE = 16_000;
const FRAME_IMAGE_TYPE = "image/jpeg";
const FRAME_IMAGE_QUALITY = 0.82;

class BrowserMediaLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserMediaLimitError";
  }
}

export type BrowserMediaFrame = {
  imageUrl: string;
  timestamp: number;
};

export type BrowserAudioChunk = {
  audio: Float32Array;
  chunkCount: number;
  chunkIndex: number;
  endSeconds: number;
  startSeconds: number;
};

export type BrowserAudioProcessResult = {
  chunkCount: number;
  codec: string;
  durationSeconds: number;
};

export function isBrowserMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchBrowserMediaWithLimit(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  maxNonRangedBytes = MAX_BROWSER_MEDIA_BYTES,
): Promise<Response> {
  const response = await fetchImpl(input, init);
  if (response.status !== 200 || !response.body) {
    return response;
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxNonRangedBytes) {
    await response.body.cancel();
    throw new BrowserMediaLimitError(
      `Media response returned ${contentLength} bytes without partial content; limit is ${maxNonRangedBytes} bytes`,
    );
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        receivedBytes += result.value.byteLength;
        if (receivedBytes > maxNonRangedBytes) {
          await reader.cancel();
          controller.error(
            new BrowserMediaLimitError(
              `Media response streamed more than ${maxNonRangedBytes} bytes without partial content`,
            ),
          );
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function extractBrowserMediaFrames({
  mediaUrl,
  timestamps,
  onStatus,
}: {
  mediaUrl: string;
  timestamps: number[];
  onStatus?: ((status: string) => void) | null;
}): Promise<BrowserMediaFrame[]> {
  onStatus?.("Preparing browser media decoder...");
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "mediabunny:frames",
    mediaUrl,
    timestamps,
  })) as { ok: true; frames: BrowserMediaFrame[] } | { ok: false; error: string } | undefined;
  if (!response?.ok) {
    throw new Error(response?.error || "Browser media decoder failed.");
  }
  return response.frames;
}

export async function extractBrowserMediaFramesInDocument({
  mediaUrl,
  timestamps,
  fetchImpl = fetch,
}: {
  mediaUrl: string;
  timestamps: number[];
  fetchImpl?: typeof fetch;
}): Promise<BrowserMediaFrame[]> {
  if (!isBrowserMediaUrl(mediaUrl)) {
    throw new Error("Browser media decoding requires a fetchable HTTP media URL.");
  }
  if (timestamps.length === 0) return [];

  const input = createMediaUrlInput(mediaUrl, fetchImpl, "include");
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Media contains no video track.");
    if (!(await track.canDecode())) {
      throw new Error(`Browser cannot decode the ${await track.getCodec()} video track.`);
    }
    const sink = new CanvasSink(track, {
      width: 960,
      height: 540,
      fit: "contain",
      poolSize: 1,
    });
    const frames: BrowserMediaFrame[] = [];
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      const timestamp = timestamps[index] ?? 0;
      index += 1;
      if (!wrapped) continue;
      frames.push({
        imageUrl: await browserMediaCanvasToDataUrl(wrapped),
        timestamp,
      });
    }
    if (frames.length === 0) throw new Error("Browser media decoder produced no frames.");
    return frames;
  } finally {
    input.dispose();
  }
}

export async function processBrowserAudioUrlWithMediaBunny({
  mediaUrl,
  credentials = "include",
  fetchImpl = fetch,
  onChunk,
}: {
  mediaUrl: string;
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
  onChunk: (chunk: BrowserAudioChunk) => Promise<boolean | void>;
}): Promise<BrowserAudioProcessResult> {
  if (!isBrowserMediaUrl(mediaUrl)) {
    throw new Error("Browser audio decoding requires a fetchable HTTP media URL.");
  }
  const input = createMediaUrlInput(mediaUrl, fetchImpl, credentials);
  return await processBrowserAudioInput({ input, onChunk });
}

export async function processBrowserAudioBytesWithMediaBunny({
  inputBytes,
  mimeType,
  onChunk,
}: {
  inputBytes: Uint8Array;
  mimeType: string;
  onChunk: (chunk: BrowserAudioChunk) => Promise<boolean | void>;
}): Promise<BrowserAudioProcessResult> {
  if (inputBytes.byteLength === 0) throw new Error("The resolved audio stream is empty.");
  if (inputBytes.byteLength > MAX_BROWSER_MEDIA_BYTES) {
    throw new Error("Audio is too large for buffered in-browser decoding.");
  }
  const input = createMediaInput(inputBytes, mimeType);
  return await processBrowserAudioInput({ input, onChunk });
}

export async function decodeBrowserAudioBytesWithMediaBunny({
  inputBytes,
  mimeType,
}: {
  inputBytes: Uint8Array;
  mimeType: string;
}): Promise<Float32Array> {
  if (inputBytes.byteLength === 0) throw new Error("The resolved audio stream is empty.");
  if (inputBytes.byteLength > MAX_BROWSER_MEDIA_BYTES) {
    throw new Error("Audio is too large for in-browser decoding.");
  }

  const chunks: Float32Array[] = [];
  let totalBytes = 0;
  await processBrowserAudioBytesWithMediaBunny({
    inputBytes,
    mimeType,
    onChunk: async ({ audio }) => {
      totalBytes += audio.byteLength;
      if (totalBytes > MAX_BROWSER_PCM_BYTES) {
        throw new Error("Decoded audio is too long for buffered in-browser transcription.");
      }
      chunks.push(audio);
    },
  });
  return concatenateFloat32(chunks);
}

export async function decodeBrowserAudioBytesWithWebAudio(
  inputBytes: Uint8Array,
): Promise<Float32Array> {
  if (inputBytes.byteLength === 0) throw new Error("The resolved audio stream is empty.");
  if (inputBytes.byteLength > MAX_BROWSER_MEDIA_BYTES) {
    throw new Error("Audio is too large for in-browser decoding.");
  }

  const context = new OfflineAudioContext(1, 1, TARGET_AUDIO_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(exactArrayBuffer(inputBytes));
  const output = new Float32Array(decoded.length);
  for (let channelIndex = 0; channelIndex < decoded.numberOfChannels; channelIndex += 1) {
    const channel = decoded.getChannelData(channelIndex);
    for (let index = 0; index < channel.length; index += 1) {
      output[index] = (output[index] ?? 0) + channel[index] / decoded.numberOfChannels;
    }
  }
  return output;
}

let creatingOffscreenDocument: Promise<void> | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("Chrome offscreen documents are unavailable.");
  }
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreenDocument ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run local browser media decoding for daemonless media processing.",
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });
  await creatingOffscreenDocument;
}

function createMediaInput(bytes: Uint8Array, mimeType: string | null): Input {
  const normalizedType = mimeType?.split(";")[0]?.trim().toLowerCase() || "";
  const blob = new Blob([exactArrayBuffer(bytes)], { type: normalizedType });
  return new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
}

function createMediaUrlInput(
  mediaUrl: string,
  fetchImpl: typeof fetch,
  credentials: RequestCredentials,
): Input {
  return new Input({
    source: new UrlSource(mediaUrl, {
      fetchFn: (input, init) => fetchBrowserMediaWithLimit(fetchImpl, input, init),
      getRetryDelay: (previousAttempts, error) =>
        error instanceof BrowserMediaLimitError ? null : previousAttempts < 2 ? 0.1 : null,
      maxCacheSize: BROWSER_MEDIA_URL_CACHE_BYTES,
      parallelism: 2,
      requestInit: { credentials },
    }),
    formats: ALL_FORMATS,
  });
}

async function processBrowserAudioInput({
  input,
  onChunk,
}: {
  input: Input;
  onChunk: (chunk: BrowserAudioChunk) => Promise<boolean | void>;
}): Promise<BrowserAudioProcessResult> {
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("Media contains no audio track.");
    const codec = await track.getCodec();
    if (!(await track.canDecode())) {
      throw new Error(`Browser cannot decode the ${codec} audio track.`);
    }

    const durationSeconds = await track.computeDuration();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Media audio duration is unavailable.");
    }
    const chunkCount = Math.max(1, Math.ceil(durationSeconds / BROWSER_AUDIO_CHUNK_SECONDS));
    const sink = new AudioSampleSink(track);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const startSeconds = chunkIndex * BROWSER_AUDIO_CHUNK_SECONDS;
      const endSeconds = Math.min(durationSeconds, startSeconds + BROWSER_AUDIO_CHUNK_SECONDS);
      const output = new BrowserPcmAccumulator(
        endSeconds - startSeconds,
        TARGET_AUDIO_SAMPLE_RATE,
        MAX_BROWSER_PCM_CHUNK_BYTES,
        startSeconds,
      );
      for await (const sample of sink.samples(startSeconds, endSeconds)) {
        try {
          const interleaved = new Float32Array(
            sample.allocationSize({ format: "f32", planeIndex: 0 }) /
              Float32Array.BYTES_PER_ELEMENT,
          );
          sample.copyTo(interleaved, { format: "f32", planeIndex: 0 });
          output.add({
            duration: sample.duration,
            interleaved,
            numberOfChannels: sample.numberOfChannels,
            numberOfFrames: sample.numberOfFrames,
            sampleRate: sample.sampleRate,
            timestamp: sample.timestamp,
          });
        } finally {
          sample.close();
        }
      }
      const audio = output.finish();
      if (audio.length === 0) {
        throw new Error(`Browser media decoder produced no PCM audio for chunk ${chunkIndex + 1}.`);
      }
      const shouldContinue = await onChunk({
        audio,
        chunkCount,
        chunkIndex,
        endSeconds,
        startSeconds,
      });
      if (shouldContinue === false) break;
    }
    return { chunkCount, codec, durationSeconds };
  } finally {
    input.dispose();
  }
}

function concatenateFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export async function browserMediaCanvasToDataUrl({ canvas }: WrappedCanvas): Promise<string> {
  if (!(typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas)) {
    // Chrome throttles HTMLCanvasElement.toBlob() to roughly one callback per second in offscreen documents.
    return canvas.toDataURL(FRAME_IMAGE_TYPE, FRAME_IMAGE_QUALITY);
  }
  const blob = await canvas.convertToBlob({
    type: FRAME_IMAGE_TYPE,
    quality: FRAME_IMAGE_QUALITY,
  });
  return await bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
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
