import { describe, expect, it, vi } from "vitest";
import { tryFetchTranscriptFromFeedXml } from "../packages/core/src/content/transcript/providers/podcast/rss-transcript.js";

const feedWithTranscript = (url: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <item>
      <title>Security Episode</title>
      <podcast:transcript url="${url}" type="text/plain" />
    </item>
  </channel>
</rss>`;

async function fetchTranscript(args: {
  transcriptUrl: string;
  fetchImpl: typeof fetch;
  lookup?: (hostname: string) => Promise<{ address: string; family?: number }[]>;
}) {
  const notes: string[] = [];
  const result = await tryFetchTranscriptFromFeedXml({
    fetchImpl: args.fetchImpl,
    feedXml: feedWithTranscript(args.transcriptUrl),
    episodeTitle: "Security Episode",
    notes,
    lookup: args.lookup,
  });
  return { notes, result };
}

describe("RSS <podcast:transcript> SSRF guard", () => {
  it("blocks loopback URL literals before fetching attacker-controlled transcript URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("internal secret", { status: 200 }));

    const { notes, result } = await fetchTranscript({
      transcriptUrl: "http://127.0.0.1:8080/admin/transcript.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes.join("\n")).toMatch(/blocked local network/i);
  });

  it("resolves hostnames and blocks DNS answers that point at private addresses", async () => {
    const lookup = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response("metadata token", { status: 200 }));

    const { notes, result } = await fetchTranscript({
      transcriptUrl: "https://transcripts.attacker.example/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(result).toBeNull();
    expect(lookup).toHaveBeenCalledWith("transcripts.attacker.example");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes.join("\n")).toMatch(/blocked local network address/i);
  });

  it("uses manual redirects and revalidates redirected transcript targets", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:7777/private-transcript" },
      });
    });

    const { notes, result } = await fetchTranscript({
      transcriptUrl: "http://8.8.8.8/redirect-transcript",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://8.8.8.8/redirect-transcript",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(notes.join("\n")).toMatch(/blocked local network address/i);
  });

  it("pins fetch DNS resolution to the addresses validated before the transcript fetch", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      return new Response("public transcript", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const { result } = await fetchTranscript({
      transcriptUrl: "https://transcripts.example.test/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(result?.text).toBe("public transcript");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://transcripts.example.test/episode.txt",
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.any(Object),
      }),
    );
  });
});
