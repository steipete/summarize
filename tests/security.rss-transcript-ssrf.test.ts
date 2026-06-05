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
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
      lookup,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      publicTranscriptUrl,
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result).toBeNull();
    expect(notes.join(" ")).toMatch(/blocked/i);
  });

  it("rejects transcript hostnames that resolve to private addresses before fetching", async () => {
    const transcriptUrl = "https://attacker-controlled.example/episode.vtt";
    const feedXml = `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Episode 1</title>
            <podcast:transcript url="${transcriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`;
    const lookup = vi.fn(async () => [{ address: "10.0.0.7", family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("hostname resolving to a private address should not be fetched");
    });

    const notes: string[] = [];
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
      lookup,
    });

    expect(lookup).toHaveBeenCalledWith("attacker-controlled.example");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(notes.join(" ")).toMatch(/blocked local network address/i);
  });

  it("revalidates redirect hostnames with DNS before following to private addresses", async () => {
    const publicTranscriptUrl = "https://transcripts.example/episode.vtt";
    const reboundRedirectUrl = "https://rebind.example/internal.vtt";
    const feedXml = `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Episode 1</title>
            <podcast:transcript url="${publicTranscriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`;
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "transcripts.example") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "rebind.example") return [{ address: "127.0.0.1", family: 4 }];
      return [];
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() !== publicTranscriptUrl) throw new Error(`unexpected fetch: ${input}`);
      return new Response(null, { status: 302, headers: { location: reboundRedirectUrl } });
    });

    const notes: string[] = [];
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
      lookup,
    });

    expect(lookup).toHaveBeenCalledWith("transcripts.example");
    expect(lookup).toHaveBeenCalledWith("rebind.example");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(notes.join(" ")).toMatch(/blocked local network address/i);
  });

  it("pins transcript fetches to the DNS addresses that were validated", async () => {
    const transcriptUrl = "https://transcripts.example/episode.vtt";
    const feedXml = `<?xml version="1.0"?>
      <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Episode 1</title>
            <podcast:transcript url="${transcriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`;
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(
      async () =>
        new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nPinned", {
          status: 200,
          headers: { "content-type": "text/vtt" },
        }),
    );

    const notes: string[] = [];
    const result = await tryFetchTranscriptFromFeedXml({
      feedXml,
      episodeTitle: "Episode 1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      notes,
      lookup,
    });

    expect(result?.text).toBe("Pinned");
    expect(fetchImpl).toHaveBeenCalledWith(
      transcriptUrl,
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.any(Object),
      }),
    );
  });
});
