import { describe, expect, it, vi } from "vitest";
import { markFetchAsDnsPinned } from "../packages/core/src/content/index.js";
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

async function expectBlockedBeforeFetch(transcriptUrl: string) {
  const fetchImpl = vi.fn(async () => new Response("blocked", { status: 200 }));

  const { notes, result } = await fetchTranscript({
    transcriptUrl,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  expect(result).toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(notes.join("\n")).toMatch(/blocked local network|must use http|invalid/i);
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

  it("fails closed for custom fetch implementations that cannot guarantee DNS pinning", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      return new Response("public transcript", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const { notes, result } = await fetchTranscript({
      transcriptUrl: "https://transcripts.example.test/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(result).toBeNull();
    expect(lookup).toHaveBeenCalledWith("transcripts.example.test");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes.join("\n")).toMatch(/requires native fetch for DNS pinning/i);
  });

  it("passes pinned dispatchers through explicit DNS-pinned fetch wrappers", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = markFetchAsDnsPinned(
      vi.fn(async () => {
        return new Response("public transcript", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as unknown as typeof fetch,
    );

    const { result } = await fetchTranscript({
      transcriptUrl: "https://transcripts.example.test/episode.txt",
      fetchImpl,
      lookup,
    });

    expect(result?.text).toBe("public transcript");
    expect(lookup).toHaveBeenCalledWith("transcripts.example.test");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://transcripts.example.test/episode.txt",
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("allows public IP literals through custom fetch implementations without DNS pinning", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("public transcript", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const { result } = await fetchTranscript({
      transcriptUrl: "http://192.0.1.1/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.text).toBe("public transcript");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.0.1.1/episode.txt",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("blocks reserved documentation IP literals before fetching transcript URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("documentation address", { status: 200 }));

    const { notes, result } = await fetchTranscript({
      transcriptUrl: "http://192.0.2.1/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes.join("\n")).toMatch(/blocked local network address/i);
  });

  it("blocks private, local, multicast, and reserved IP literal ranges", async () => {
    for (const transcriptUrl of [
      "http://0.0.0.0/transcript.txt",
      "http://10.0.0.1/transcript.txt",
      "http://100.64.0.1/transcript.txt",
      "http://169.254.1.1/transcript.txt",
      "http://172.16.0.1/transcript.txt",
      "http://172.31.255.255/transcript.txt",
      "http://192.168.1.1/transcript.txt",
      "http://192.0.0.1/transcript.txt",
      "http://198.18.0.1/transcript.txt",
      "http://198.19.0.1/transcript.txt",
      "http://198.51.100.1/transcript.txt",
      "http://203.0.113.1/transcript.txt",
      "http://224.0.0.1/transcript.txt",
      "http://[::]/transcript.txt",
      "http://[::1]/transcript.txt",
      "http://[::ffff:127.0.0.1]/transcript.txt",
      "http://[::7f00:1]/transcript.txt",
      "http://[64:ff9b::a9fe:a9fe]/transcript.txt",
      "http://[64:ff9b:1::808:808]/transcript.txt",
      "http://[100::1]/transcript.txt",
      "http://[2001:2::1]/transcript.txt",
      "http://[fc00::1]/transcript.txt",
      "http://[fe80::1]/transcript.txt",
      "http://[ff00::1]/transcript.txt",
      "http://[2001:db8::1]/transcript.txt",
      "http://[2002:ac10:1::1]/transcript.txt",
      "http://[3fff::1]/transcript.txt",
      "http://[5f00::1]/transcript.txt",
    ]) {
      await expectBlockedBeforeFetch(transcriptUrl);
    }
  });

  it("allows well-known NAT64 literals when the embedded IPv4 address is public", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("public transcript", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const { result } = await fetchTranscript({
      transcriptUrl: "http://[64:ff9b::808:808]/episode.txt",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.text).toBe("public transcript");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://[64:ff9b::808:808]/episode.txt",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("blocks invalid schemes, invalid URLs, and localhost names", async () => {
    for (const transcriptUrl of [
      "not a url",
      "file:///private/transcript.txt",
      "http://localhost/transcript.txt",
      "http://feed.localhost./transcript.txt",
    ]) {
      await expectBlockedBeforeFetch(transcriptUrl);
    }
  });

  it("rejects empty or malformed DNS answers before fetching transcript URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 200 }));

    await expect(
      fetchTranscript({
        transcriptUrl: "https://empty.example.test/episode.txt",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup: async () => [],
      }),
    ).resolves.toMatchObject({ result: null });

    await expect(
      fetchTranscript({
        transcriptUrl: "https://malformed.example.test/episode.txt",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup: async () => [{ address: "999.1.1.1", family: 4 }],
      }),
    ).resolves.toMatchObject({ result: null });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows public IPv4 and IPv6 literals through custom fetch implementations", async () => {
    const fetchImpl = vi.fn(async () => new Response("public transcript", { status: 200 }));

    for (const transcriptUrl of [
      "http://8.8.8.8/transcript.txt",
      "http://[2606:4700:4700::1111]/transcript.txt",
      "http://[::ffff:8.8.8.8]/transcript.txt",
    ]) {
      const { result } = await fetchTranscript({
        transcriptUrl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result?.text).toBe("public transcript");
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("handles redirects without locations and caps redirect chains", async () => {
    const noLocationFetch = vi.fn(async () => new Response(null, { status: 302 }));
    const noLocation = await fetchTranscript({
      transcriptUrl: "http://8.8.8.8/no-location",
      fetchImpl: noLocationFetch as unknown as typeof fetch,
    });
    expect(noLocation.result).toBeNull();
    expect(noLocation.notes.join("\n")).toMatch(/transcript fetch failed \(302\)/i);

    const redirectFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://8.8.8.8/next" },
      });
    });
    const redirected = await fetchTranscript({
      transcriptUrl: "http://8.8.8.8/redirect",
      fetchImpl: redirectFetch as unknown as typeof fetch,
    });
    expect(redirected.result).toBeNull();
    expect(redirected.notes.join("\n")).toMatch(/redirected too many times/i);
  });
});
