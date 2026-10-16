import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeWithFal } from "../packages/core/src/transcription/whisper/fal.js";

afterEach(() => vi.unstubAllGlobals());

describe("FAL transcription timeout", () => {
  it("aborts the upload when the transcription deadline fires", async () => {
    const fetchImpl = vi.fn((_input: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      transcribeWithFal(new Uint8Array([1, 2, 3]), "audio/mpeg", "fal-key", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("FAL transcription timeout");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
