import { describe, expect, it } from "vitest";
import { extractYoutubePoToken } from "../apps/chrome-extension/src/entrypoints/background/youtube-sabr-capture.js";

describe("Chrome YouTube SABR capture", () => {
  it("extracts the active playback PO token", () => {
    // VideoPlaybackAbrRequest field 19 (streamerContext), nested field 2 (poToken).
    expect(extractYoutubePoToken(new Uint8Array([0x9a, 0x01, 0x06, 0x12, 0x04, 1, 2, 3, 4]))).toBe(
      "AQIDBA==",
    );
  });

  it("ignores invalid request bodies", () => {
    expect(extractYoutubePoToken(new Uint8Array([255, 255]))).toBeNull();
  });
});
