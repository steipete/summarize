import { describe, expect, it, vi } from "vitest";
import { tryFetchTranscriptFromFeedXml } from "../packages/core/src/content/transcript/providers/podcast/rss-transcript.js";

describe("RSS podcast transcript URL handling", () => {
  it("rejects loopback transcript URLs from feed XML before fetching them", async () => {
    const internalTranscriptUrl = "http://127.0.0.1:65535/admin/metadata?token=[REDACTED]";
    const feedXml = `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Episode 1</title>
            <guid>episode-1</guid>
            <enclosure url="https://cdn.example/episode.mp3" type="audio/mpeg" />
            <podcast:transcript url="${internalTranscriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`;

    const fetchImpl = vi.fn(async () => {
      throw new Error("internal transcript URL should not be fetched");
    });

    const notes: string[] = [];
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(notes.join(" ")).toMatch(/blocked/i);
  });

  it("rejects redirects from public transcript URLs to loopback targets", async () => {
    const publicTranscriptUrl = "https://transcripts.example/episode.vtt";
    const internalRedirectUrl = "http://127.0.0.1:65535/admin/metadata?token=[REDACTED]";
    const feedXml = `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Episode 1</title>
            <guid>episode-1</guid>
            <podcast:transcript url="${publicTranscriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === publicTranscriptUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: internalRedirectUrl },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const notes: string[] = [];
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      publicTranscriptUrl,
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result).toBeNull();
    expect(notes.join(" ")).toMatch(/blocked/i);
  });
});
