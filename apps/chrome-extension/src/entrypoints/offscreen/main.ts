import { extractBrowserMediaFramesInDocument } from "../background/browser-media";
import type { BrowserYoutubeMediaContext } from "../background/youtube-media";
import type { CapturedYoutubeSabrRequest } from "../background/youtube-sabr-capture";
import { transcribeBrowserMediaBytes, transcribeBrowserMediaUrl } from "./media-transcription";
import { downloadYoutubeAudio, resolveYoutubeDirectAudio } from "./youtube-audio";

type BrowserMediaRequest = {
  target?: string;
  type?: string;
  mediaUrl?: string;
  timestamps?: number[];
  requestId?: string;
  context?: BrowserYoutubeMediaContext;
  capturedSabr?: CapturedYoutubeSabrRequest | null;
  maxChars?: number;
  credentials?: RequestCredentials;
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
      const context = message.context as BrowserYoutubeMediaContext;
      let mediaSource: "sabr" | "player" | "android-vr";
      let transcript;
      try {
        const direct = await resolveYoutubeDirectAudio(context);
        mediaSource = direct.mediaSource;
        transcript = await transcribeBrowserMediaUrl({
          credentials: "omit",
          maxChars: message.maxChars as number,
          mediaUrl: direct.url,
          onStatus: report,
        });
      } catch (directError) {
        report("Direct audio streaming failed; downloading fallback audio...");
        const downloaded = await downloadYoutubeAudio({
          context,
          capturedSabr: message.capturedSabr ?? null,
          ignoreContextDirect: true,
        });
        mediaSource = downloaded.mediaSource;
        transcript = await transcribeBrowserMediaBytes({
          inputBytes: downloaded.bytes,
          maxChars: message.maxChars as number,
          mimeType: downloaded.mimeType,
          onStatus: report,
        }).catch((bufferedError) => {
          const directMessage =
            directError instanceof Error ? directError.message : String(directError);
          const bufferedMessage =
            bufferedError instanceof Error ? bufferedError.message : String(bufferedError);
          throw new Error(
            `Direct audio streaming failed: ${directMessage} Buffered fallback failed: ${bufferedMessage}`,
          );
        });
      }
      return {
        ok: true as const,
        url: context.url,
        ...transcript,
        durationSeconds: context.durationSeconds ?? transcript.diagnostics.durationSeconds,
        mediaSource,
      };
    })().then(
      (result) => sendResponse(result),
      (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type === "browser-media:transcribe") {
    if (
      typeof message.requestId !== "string" ||
      typeof message.mediaUrl !== "string" ||
      typeof message.maxChars !== "number"
    ) {
      sendResponse({ ok: false, error: "Invalid browser media transcription request." });
      return;
    }
    const report = (status: string) => {
      void chrome.runtime.sendMessage({
        type: "browser-media:progress",
        requestId: message.requestId,
        status,
      });
    };
    void transcribeBrowserMediaUrl({
      credentials: message.credentials ?? "include",
      maxChars: message.maxChars,
      mediaUrl: message.mediaUrl,
      onStatus: report,
    }).then(
      (transcript) => sendResponse({ ok: true, ...transcript }),
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
