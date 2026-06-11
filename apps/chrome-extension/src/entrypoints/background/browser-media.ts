import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  Input,
  type WrappedCanvas,
} from "mediabunny";
import { BrowserPcmAccumulator } from "./browser-media-audio";

const MAX_BROWSER_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_BROWSER_PCM_BYTES = 512 * 1024 * 1024;
const TARGET_AUDIO_SAMPLE_RATE = 16_000;
const FRAME_IMAGE_TYPE = "image/jpeg";
const FRAME_IMAGE_QUALITY = 0.82;

export type BrowserMediaFrame = {
  imageUrl: string;
  timestamp: number;
};

export function isBrowserMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

  const response = await fetchImpl(mediaUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Media download failed (${response.status} ${response.statusText}).`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_MEDIA_BYTES) {
    throw new Error("Media is too large for in-browser decoding.");
  }
  const inputBytes = await readResponseWithLimit(response, MAX_BROWSER_MEDIA_BYTES);
  const input = createMediaInput(inputBytes, response.headers.get("content-type"));
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
        imageUrl: await canvasToDataUrl(wrapped),
        timestamp,
      });
    }
    if (frames.length === 0) throw new Error("Browser media decoder produced no frames.");
    return frames;
  } finally {
    input.dispose();
  }
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

  const input = createMediaInput(inputBytes, mimeType);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("Media contains no audio track.");
    if (!(await track.canDecode())) {
      throw new Error(`Browser cannot decode the ${await track.getCodec()} audio track.`);
    }

    const duration = await track.computeDuration();
    const output = new BrowserPcmAccumulator(
      duration,
      TARGET_AUDIO_SAMPLE_RATE,
      MAX_BROWSER_PCM_BYTES,
    );
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples()) {
      try {
        const interleaved = new Float32Array(
          sample.allocationSize({ format: "f32", planeIndex: 0 }) / Float32Array.BYTES_PER_ELEMENT,
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
    if (audio.length === 0) throw new Error("Browser media decoder produced no PCM audio.");
    return audio;
  } finally {
    input.dispose();
  }
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

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Media is too large for in-browser decoding.");
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
      throw new Error("Media is too large for in-browser decoding.");
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

function createMediaInput(bytes: Uint8Array, mimeType: string | null): Input {
  const normalizedType = mimeType?.split(";")[0]?.trim().toLowerCase() || "";
  const blob = new Blob([exactArrayBuffer(bytes)], { type: normalizedType });
  return new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
}

async function canvasToDataUrl({ canvas }: WrappedCanvas): Promise<string> {
  const blob =
    typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: FRAME_IMAGE_TYPE, quality: FRAME_IMAGE_QUALITY })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("Canvas encoding failed."))),
            FRAME_IMAGE_TYPE,
            FRAME_IMAGE_QUALITY,
          ),
        );
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
