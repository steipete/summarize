import { describe, expect, it } from "vitest";
import { tryFetchTranscriptFromFeedXml } from "../packages/core/src/content/transcript/providers/podcast/rss-transcript.js";
import { MAX_REMOTE_TRANSCRIPT_BYTES } from "../packages/core/src/content/transcript/providers/response-size-limit.js";

const MAX_RSS_TRANSCRIPT_BYTES = MAX_REMOTE_TRANSCRIPT_BYTES;

function feedWithTranscript(url: string) {
  return `<?xml version="1.0"?>
    <rss xmlns:podcast="https://podcastindex.org/namespace/1.0">
      <channel>
        <item>
          <title>attacker episode</title>
          <podcast:transcript url="${url}" type="text/plain" />
        </item>
      </channel>
    </rss>`;
}

function repeatedTranscriptStream(
  totalBytes: number,
  chunkBytes = 64 * 1024,
  onCancel?: () => void,
) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill("A".charCodeAt(0)));
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function fetchTranscript(fetchImpl: typeof fetch) {
  const notes: string[] = [];
  const result = await tryFetchTranscriptFromFeedXml({
    fetchImpl,
    feedXml: feedWithTranscript("http://93.184.216.34/huge.txt"),
    episodeTitle: "attacker episode",
    notes,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  return { notes, result };
}

describe("RSS <podcast:transcript> size limits", () => {
  it("rejects oversized transcript responses from Content-Length before reading the body", async () => {
    let bodyRead = false;
    const fetchImpl = async () => {
      const response = new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_RSS_TRANSCRIPT_BYTES + 1),
        },
      });
      response.arrayBuffer = async () => {
        bodyRead = true;
        throw new Error("body should not be read after oversized Content-Length");
      };
      return response;
    };

    const { notes, result } = await fetchTranscript(fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
    expect(bodyRead).toBe(false);
    expect(notes.join("\n")).toMatch(/transcript too large/i);
  });

  it("rejects streamed transcript responses once they exceed the byte cap", async () => {
    const fetchImpl = async () =>
      new Response(repeatedTranscriptStream(MAX_RSS_TRANSCRIPT_BYTES + 1), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    const { notes, result } = await fetchTranscript(fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
    expect(notes.join("\n")).toMatch(/transcript too large/i);
  });

  it("still accepts small RSS transcript responses", async () => {
    const fetchImpl = async () =>
      new Response("small public transcript", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "23",
        },
      });

    const { notes, result } = await fetchTranscript(fetchImpl as unknown as typeof fetch);

    expect(result?.text).toBe("small public transcript");
    expect(notes).toContain("Used RSS <podcast:transcript> (skipped Whisper)");
  });
});
