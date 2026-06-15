import { describe, expect, it } from "vitest";
import { fetchCaptionTrack } from "../packages/core/src/content/transcript/providers/generic-embedded.js";
import { MAX_REMOTE_TRANSCRIPT_BYTES } from "../packages/core/src/content/transcript/providers/response-size-limit.js";

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

async function fetchTrack(fetchImpl: typeof fetch) {
  const notes: string[] = [];
  const result = await fetchCaptionTrack(
    fetchImpl,
    {
      url: "https://example.com/captions.vtt",
      type: "text/vtt",
      language: "en",
    },
    notes,
    true,
  );
  return { notes, result };
}

describe("embedded caption track size limits", () => {
  it("rejects oversized caption responses from Content-Length before reading the body", async () => {
    let bodyRead = false;
    const fetchImpl = async () => {
      const response = new Response(null, {
        status: 200,
        headers: {
          "content-type": "text/vtt",
          "content-length": String(MAX_REMOTE_TRANSCRIPT_BYTES + 1),
        },
      });
      response.arrayBuffer = async () => {
        bodyRead = true;
        throw new Error("body should not be read after oversized Content-Length");
      };
      return response;
    };

    const { notes, result } = await fetchTrack(fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
    expect(bodyRead).toBe(false);
    expect(notes.join("\n")).toMatch(/transcript too large/i);
  });

  it("rejects streamed caption responses once they exceed the byte cap", async () => {
    const fetchImpl = async () =>
      new Response(repeatedTranscriptStream(MAX_REMOTE_TRANSCRIPT_BYTES + 1), {
        status: 200,
        headers: { "content-type": "text/vtt" },
      });

    const { notes, result } = await fetchTrack(fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
    expect(notes.join("\n")).toMatch(/transcript too large/i);
  });

  it("still accepts small embedded caption responses", async () => {
    const fetchImpl = async () =>
      new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nsmall caption", {
        status: 200,
        headers: {
          "content-type": "text/vtt",
          "content-length": "49",
        },
      });

    const { notes, result } = await fetchTrack(fetchImpl as unknown as typeof fetch);

    expect(notes).toEqual([]);
    expect(result?.text).toBe("small caption");
    expect(result?.segments?.[0]?.text).toBe("small caption");
  });
});
