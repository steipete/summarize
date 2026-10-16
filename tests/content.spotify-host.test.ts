import { describe, expect, it } from "vitest";
import { extractSpotifyEpisodeId as extractPreviewEpisodeId } from "../packages/core/src/content/link-preview/content/podcast-utils.js";
import { extractSpotifyEpisodeId as extractTranscriptEpisodeId } from "../packages/core/src/content/transcript/providers/podcast/spotify.js";

describe("Spotify host boundary", () => {
  it.each([extractPreviewEpisodeId, extractTranscriptEpisodeId])(
    "accepts spotify.com and rejects lookalike hosts",
    (extract) => {
      expect(extract("https://open.spotify.com/episode/abc123")).toBe("abc123");
      expect(extract("https://spotify.com/episode/abc123")).toBe("abc123");
      expect(extract("https://notspotify.com/episode/abc123")).toBeNull();
      expect(extract("https://evilspotify.com/episode/abc123")).toBeNull();
    },
  );
});
