import {
  decodeBrowserAudioBytesWithMediaBunny,
  decodeBrowserAudioBytesWithWebAudio,
  extractBrowserMediaFramesInDocument,
} from "../background/browser-media";
import type { BrowserYoutubeMediaContext } from "../background/youtube-media";
import type { CapturedYoutubeSabrRequest } from "../background/youtube-sabr-capture";
import { transcribePcmWithWhisper } from "./whisper";
import { downloadYoutubeAudio } from "./youtube-audio";

type BrowserMediaRequest = {
  target?: string;
  type?: string;
  mediaUrl?: string;
  timestamps?: number[];
  requestId?: string;
  context?: BrowserYoutubeMediaContext;
  capturedSabr?: CapturedYoutubeSabrRequest | null;
  maxChars?: number;
};

chrome.runtime.onMessage.addListener((message: BrowserMediaRequest, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  if (message.type === "youtube-local:transcribe") {
    if (
      typeof message.requestId !== "string" ||
      !message.context ||
      typeof message.maxChars !== "number"
    ) {
      sendResponse({ ok: false, error: "Invalid local YouTube transcription request." });
      return;
    }
    const report = (status: string) => {
      void chrome.runtime.sendMessage({
        type: "youtube-local:progress",
        requestId: message.requestId,
        status,
      });
    };
    void (async () => {
      report("Downloading YouTube audio...");
      const downloaded = await downloadYoutubeAudio({
        context: message.context as BrowserYoutubeMediaContext,
        capturedSabr: message.capturedSabr ?? null,
      });
      report("Preparing audio in the browser...");
      const audio = await decodeBrowserAudioBytesWithWebAudio(downloaded.bytes).catch(async () => {
        report("Preparing audio with browser media decoder...");
        return await decodeBrowserAudioBytesWithMediaBunny({
          inputBytes: downloaded.bytes,
          mimeType: downloaded.mimeType,
        });
      });
      const transcript = await transcribePcmWithWhisper({
        audio,
        maxChars: message.maxChars as number,
        onStatus: report,
      });
      return {
        ok: true as const,
        url: (message.context as BrowserYoutubeMediaContext).url,
        ...transcript,
        durationSeconds: (message.context as BrowserYoutubeMediaContext).durationSeconds,
        mediaSource: downloaded.mediaSource,
      };
    })().then(
      (result) => sendResponse(result),
      (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type !== "mediabunny:frames") return;
  if (typeof message.mediaUrl !== "string" || !Array.isArray(message.timestamps)) {
    sendResponse({ ok: false, error: "Invalid browser media request." });
    return;
  }
  void extractBrowserMediaFramesInDocument({
    mediaUrl: message.mediaUrl,
    timestamps: message.timestamps,
  }).then(
    (frames) => sendResponse({ ok: true, frames }),
    (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
