import { extractBrowserFfmpegFramesInDocument } from "../background/browser-ffmpeg";

type BrowserFfmpegRequest = {
  target?: string;
  type?: string;
  mediaUrl?: string;
  timestamps?: number[];
};

chrome.runtime.onMessage.addListener((message: BrowserFfmpegRequest, _sender, sendResponse) => {
  if (message.target !== "offscreen" || message.type !== "ffmpeg-wasm:frames") return;
  if (typeof message.mediaUrl !== "string" || !Array.isArray(message.timestamps)) {
    sendResponse({ ok: false, error: "Invalid FFmpeg WebAssembly request." });
    return;
  }
  void extractBrowserFfmpegFramesInDocument({
    mediaUrl: message.mediaUrl,
    timestamps: message.timestamps,
  }).then(
    (frames) => sendResponse({ ok: true, frames }),
    (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
