import { isDirectMediaUrl } from "@steipete/summarize-core/content/url";
import type { BrowserMediaTranscriptionDiagnostics } from "../offscreen/media-transcription";
import { ensureOffscreenDocument, isBrowserMediaUrl } from "./browser-media";
import { getPrimaryMediaInfoInTab } from "./content-script-bridge";

export type BrowserLocalMediaTranscript =
  | {
      diagnostics: BrowserMediaTranscriptionDiagnostics;
      durationSeconds: number | null;
      ok: true;
      source: "direct" | "embedded";
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      url: string;
    }
  | { ok: false; error: string };

const progressCallbacks = new Map<string, (status: string) => void>();
const LOCAL_MEDIA_TRANSCRIPTION_TIMEOUT_MS = 15 * 60 * 1000;
let progressListenerStarted = false;

export async function transcribeBrowserMediaInTab({
  maxChars,
  onStatus,
  tabId,
  tabUrl,
}: {
  maxChars: number;
  onStatus?: ((status: string) => void) | null;
  tabId: number;
  tabUrl: string;
}): Promise<BrowserLocalMediaTranscript> {
  try {
    startBrowserMediaProgressRuntime();
    onStatus?.("Resolving browser media...");
    const inspected = await getPrimaryMediaInfoInTab(tabId);
    const direct = isDirectMediaUrl(tabUrl);
    const mediaUrl = direct ? tabUrl : inspected.ok ? inspected.mediaSrc : null;
    if (!mediaUrl || !isBrowserMediaUrl(mediaUrl)) {
      return {
        ok: false,
        error: inspected.ok
          ? "The active media source is not fetchable outside the page."
          : inspected.error,
      };
    }
    await ensureOffscreenDocument();

    const requestId = crypto.randomUUID();
    if (onStatus) progressCallbacks.set(requestId, onStatus);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = (await Promise.race([
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "browser-media:transcribe",
          credentials: "include",
          requestId,
          mediaUrl,
          maxChars,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Local browser media transcription timed out.")),
            LOCAL_MEDIA_TRANSCRIPTION_TIMEOUT_MS,
          );
        }),
      ])) as
        | {
            diagnostics: BrowserMediaTranscriptionDiagnostics;
            ok: true;
            text: string;
            transcriptTimedText: string;
            truncated: boolean;
          }
        | { ok: false; error: string }
        | undefined;
      if (!response?.ok) {
        return {
          ok: false,
          error: response?.error ?? "Local browser media transcription returned no result.",
        };
      }
      return {
        ...response,
        durationSeconds:
          inspected.ok && inspected.durationSeconds
            ? inspected.durationSeconds
            : response.diagnostics.durationSeconds,
        source: direct ? "direct" : "embedded",
        url: tabUrl,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      progressCallbacks.delete(requestId);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function startBrowserMediaProgressRuntime(): void {
  if (progressListenerStarted) return;
  progressListenerStarted = true;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== "object") return;
    const typed = message as { requestId?: unknown; status?: unknown; type?: unknown };
    if (
      typed.type === "browser-media:progress" &&
      typeof typed.requestId === "string" &&
      typeof typed.status === "string"
    ) {
      progressCallbacks.get(typed.requestId)?.(typed.status);
    }
  });
}
