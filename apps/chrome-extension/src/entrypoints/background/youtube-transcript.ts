import {
  fetchYouTubeCaptionText,
  readYouTubePageCaptionSource,
  readYouTubeTranscriptPanel,
  resolveYouTubePageTranscript,
  type BrowserYouTubeTranscript,
} from "../../lib/youtube-page-transcript";

export async function hasYouTubeCaptionTracksInTab(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readYouTubePageCaptionSource,
    });
    return (result?.result.tracks.length ?? 0) > 0;
  } catch {
    return true;
  }
}

export async function extractYouTubeTranscriptInTab(
  tabId: number,
  maxChars: number,
): Promise<BrowserYouTubeTranscript> {
  try {
    const [sourceResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readYouTubePageCaptionSource,
    });
    const source = sourceResult?.result;
    if (!source) return { ok: false, error: "No transcript result returned." };
    return await resolveYouTubePageTranscript({
      source,
      limit: maxChars,
      loadCaptionText: async (url) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [url, source.url],
          func: fetchYouTubeCaptionText,
        });
        return result?.result ?? null;
      },
      loadPanel: async () => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [source.url],
          func: readYouTubeTranscriptPanel,
        });
        return result?.result ?? null;
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
