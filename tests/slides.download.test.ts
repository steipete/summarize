import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { downloadRemoteVideo } from "../src/slides/download.js";

describe("slides download", () => {
  it("uses the injected fetch implementation for remote videos", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      });
    });

    const result = await downloadRemoteVideo({
      url: "https://cdn.example/video.mp4",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://cdn.example/video.mp4",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await expect(readFile(result.filePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await result.cleanup();
      expect(existsSync(result.filePath)).toBe(false);
      await rm(result.filePath, { force: true });
    }
  });
});
