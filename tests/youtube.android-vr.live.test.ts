import { describe, expect, it } from "vitest";
import {
  extractYoutubePlayerBootstrap,
  resolveYoutubeAudioWithAndroidVr,
} from "../packages/core/src/content/youtube.js";

const LIVE = process.env.SUMMARIZE_LIVE_TESTS === "1";
const VIDEO_ID = process.env.SUMMARIZE_LIVE_YOUTUBE_VIDEO_ID ?? "jNQXAC9IVRw";

describe.runIf(LIVE)("live YouTube Android VR media resolver", () => {
  it("resolves and reads a direct audio stream without yt-dlp", async () => {
    const watchUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    const htmlResponse = await fetch(watchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      },
    });
    expect(htmlResponse.ok).toBe(true);
    const bootstrap = extractYoutubePlayerBootstrap(await htmlResponse.text());
    expect(bootstrap).not.toBeNull();

    const media = await resolveYoutubeAudioWithAndroidVr({
      fetchImpl: fetch,
      videoId: VIDEO_ID,
      apiKey: bootstrap?.apiKey ?? "",
      visitorData: bootstrap?.visitorData ?? null,
      originalUrl: watchUrl,
    });
    expect(media.url).toMatch(/^https:\/\//);
    expect(media.mimeType).toMatch(/^audio\//);

    const range = await fetch(media.url, { headers: { Range: "bytes=0-65535" } });
    expect([200, 206]).toContain(range.status);
    expect((await range.arrayBuffer()).byteLength).toBeGreaterThan(1024);
  }, 45_000);
});
