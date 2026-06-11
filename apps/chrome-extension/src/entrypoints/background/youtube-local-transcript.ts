import type { BrowserMediaTranscriptionDiagnostics } from "../offscreen/media-transcription";
import { ensureOffscreenDocument } from "./browser-media";
import { getYoutubeMediaContextInTab } from "./youtube-media";
import {
  getCapturedYoutubeSabrRequest,
  startYoutubeSabrRequestCapture,
} from "./youtube-sabr-capture";

export type BrowserYoutubeLocalTranscript =
  | {
      ok: true;
      diagnostics: BrowserMediaTranscriptionDiagnostics;
      url: string;
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      durationSeconds: number | null;
      mediaSource: "sabr" | "player" | "android-vr";
    }
  | { ok: false; error: string };

const progressCallbacks = new Map<string, (status: string) => void>();
const LOCAL_TRANSCRIPTION_TIMEOUT_MS = 15 * 60 * 1000;
let progressListenerStarted = false;

export function startYoutubeLocalTranscriptionRuntime(): void {
  startYoutubeSabrRequestCapture();
  if (progressListenerStarted) return;
  progressListenerStarted = true;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return;
    const typed = message as {
      type?: unknown;
      requestId?: unknown;
      status?: unknown;
    };
    if (
      typed.type === "youtube-local:progress" &&
      typeof typed.requestId === "string" &&
      typeof typed.status === "string"
    ) {
      progressCallbacks.get(typed.requestId)?.(typed.status);
    }
  });
}

export async function transcribeYoutubeAudioInTab({
  tabId,
  maxChars,
  onStatus,
}: {
  tabId: number;
  maxChars: number;
  onStatus?: ((status: string) => void) | null;
}): Promise<BrowserYoutubeLocalTranscript> {
  try {
    onStatus?.("Resolving YouTube audio...");
    const context = await getYoutubeMediaContextInTab(tabId);
    if (!context) return { ok: false, error: "YouTube player media data is unavailable." };
    await ensureOffscreenDocument();

    const requestId = crypto.randomUUID();
    if (onStatus) progressCallbacks.set(requestId, onStatus);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = (await Promise.race([
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "youtube-local:transcribe",
          requestId,
          context,
          capturedSabr: getCapturedYoutubeSabrRequest(tabId),
          maxChars,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Local YouTube transcription timed out.")),
            LOCAL_TRANSCRIPTION_TIMEOUT_MS,
          );
        }),
      ])) as BrowserYoutubeLocalTranscript | undefined;
      return response ?? { ok: false, error: "Local YouTube transcription returned no result." };
    } finally {
      if (timeout) clearTimeout(timeout);
      progressCallbacks.delete(requestId);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
