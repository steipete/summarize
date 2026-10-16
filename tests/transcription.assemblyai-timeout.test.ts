import { describe, expect, it, vi } from "vitest";
import { transcribeWithAssemblyAi } from "../packages/core/src/transcription/whisper/assemblyai.js";

describe("AssemblyAI request timeout", () => {
  it("stops a stalled upload instead of waiting for the next poll", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    await expect(
      transcribeWithAssemblyAi(new Uint8Array([1, 2, 3]), "audio/mpeg", "assembly-key", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
