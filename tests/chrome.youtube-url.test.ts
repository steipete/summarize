import { describe, expect, it } from "vitest";
import { isYouTubeWatchUrl } from "../apps/chrome-extension/src/lib/youtube-url.js";

describe("chrome/youtube-url", () => {
  it("accepts real YouTube watch URLs", () => {
    expect(isYouTubeWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeWatchUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeWatchUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
  });

  it("rejects malicious YouTube-like hostnames", () => {
    expect(isYouTubeWatchUrl("https://youtube.com.attacker.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isYouTubeWatchUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isYouTubeWatchUrl("https://attacker-youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
  });
});
