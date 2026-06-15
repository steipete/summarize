import { describe, expect, it } from "vitest";
import { readTranscriptTextWithLimit } from "../packages/core/src/content/transcript/providers/response-size-limit.js";

describe("transcript response size limiter", () => {
  it("cancels a present response body when Content-Length is oversized", async () => {
    let canceled = false;
    const res = {
      headers: new Headers({ "content-length": "6" }),
      body: {
        async cancel() {
          canceled = true;
        },
      },
    } as unknown as Response;

    await expect(readTranscriptTextWithLimit(res, 5)).rejects.toThrow(/transcript too large/i);
    expect(canceled).toBe(true);
  });

  it("cancels the response body when a streamed response exceeds the byte cap", async () => {
    let canceled = false;
    let released = false;
    const chunks = [new Uint8Array(4), new Uint8Array(4)];

    const res = {
      headers: new Headers({ "content-type": "text/plain" }),
      body: {
        getReader() {
          return {
            async read() {
              const value = chunks.shift();
              return value ? { done: false, value } : { done: true, value: undefined };
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {
              released = true;
            },
          };
        },
      },
    } as unknown as Response;

    await expect(readTranscriptTextWithLimit(res, 5)).rejects.toThrow(/transcript too large/i);
    expect(canceled).toBe(true);
    expect(released).toBe(true);
  });
});
