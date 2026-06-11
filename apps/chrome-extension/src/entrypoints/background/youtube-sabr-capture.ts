import { VideoPlaybackAbrRequest } from "googlevideo/protos";
import { u8ToBase64 } from "googlevideo/utils";

const GOOGLEVIDEO_URLS = ["https://*.googlevideo.com/videoplayback*"];
const CAPTURE_MAX_AGE_MS = 2 * 60_000;

export type CapturedYoutubeSabrRequest = {
  url: string;
  poToken: string | null;
  timestamp: number;
};

const capturedByTab = new Map<number, CapturedYoutubeSabrRequest>();
let started = false;

export function startYoutubeSabrRequestCapture(): void {
  if (started || !chrome.webRequest?.onBeforeRequest) return;
  started = true;
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0 || details.method !== "POST") return;
      const bytes = concatenateRequestBody(details.requestBody?.raw);
      if (!bytes) return;
      capturedByTab.set(details.tabId, {
        url: details.url,
        poToken: extractYoutubePoToken(bytes),
        timestamp: Date.now(),
      });
    },
    { urls: GOOGLEVIDEO_URLS },
    ["requestBody"],
  );
  chrome.tabs.onRemoved.addListener((tabId) => capturedByTab.delete(tabId));
}

export function getCapturedYoutubeSabrRequest(tabId: number): CapturedYoutubeSabrRequest | null {
  const captured = capturedByTab.get(tabId);
  if (!captured) return null;
  if (Date.now() - captured.timestamp > CAPTURE_MAX_AGE_MS) {
    capturedByTab.delete(tabId);
    return null;
  }
  return captured;
}

export function extractYoutubePoToken(bytes: Uint8Array): string | null {
  try {
    const poToken = VideoPlaybackAbrRequest.decode(bytes).streamerContext?.poToken;
    return poToken && poToken.byteLength > 0 ? u8ToBase64(poToken) : null;
  } catch {
    return null;
  }
}

function concatenateRequestBody(
  raw: chrome.webRequest.UploadData[] | undefined,
): Uint8Array | null {
  const buffers = (raw ?? [])
    .map((part) => part.bytes)
    .filter((bytes): bytes is ArrayBuffer => bytes instanceof ArrayBuffer);
  if (buffers.length === 0) return null;
  const totalBytes = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return result;
}
