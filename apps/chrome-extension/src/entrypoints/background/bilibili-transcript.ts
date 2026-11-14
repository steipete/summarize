import {
  fetchBilibiliPageTranscript,
  parseBilibiliPageVideo,
  type BrowserBilibiliTranscript,
} from "../../lib/bilibili-page-transcript";

export async function extractBilibiliTranscriptInTab(
  tabId: number,
  maxChars: number,
  expectedPageUrl: string,
): Promise<BrowserBilibiliTranscript> {
  const video = parseBilibiliPageVideo(expectedPageUrl);
  if (!video) return { ok: false, reason: "failed", error: "Unsupported Bilibili video URL." };
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [video, maxChars],
      func: fetchBilibiliPageTranscript,
    });
    return (
      result?.result ?? {
        ok: false,
        reason: "failed",
        error: "No Bilibili transcript result returned.",
      }
    );
  } catch {
    return {
      ok: false,
      reason: "failed",
      error: "Could not retrieve Bilibili captions from this tab.",
    };
  }
}
