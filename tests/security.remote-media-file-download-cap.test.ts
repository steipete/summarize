import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  downloadCappedBytes,
  downloadToFile,
} from "../packages/core/src/content/transcript/providers/podcast/media.js";
import {
  REMOTE_MEDIA_MAX_BYTES_ENV,
  normalizeRemoteMediaMaxBytes,
  resolveTranscriptionConfig,
} from "../packages/core/src/content/transcript/transcription-config.js";

function oversizedStream({
  firstChunkBytes,
  secondChunkBytes,
}: {
  firstChunkBytes: number;
  secondChunkBytes: number;
}) {
  let chunkIndex = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      chunkIndex += 1;
      if (chunkIndex === 1) {
        controller.enqueue(new Uint8Array(firstChunkBytes));
        return;
      }
      if (chunkIndex === 2) {
        controller.enqueue(new Uint8Array(secondChunkBytes));
        return;
      }
      controller.close();
    },
  });
}

describe("remote media temp-file download cap", () => {
  it("keeps the built-in 512 MB cap unless an explicit finite opt-in is configured", () => {
    expect(resolveTranscriptionConfig({}).remoteMediaMaxBytes).toBeNull();
    expect(
      resolveTranscriptionConfig({
        env: { [REMOTE_MEDIA_MAX_BYTES_ENV]: String(768 * 1024 * 1024) },
      }).remoteMediaMaxBytes,
    ).toBe(768 * 1024 * 1024);
    expect(
      resolveTranscriptionConfig({
        env: { [REMOTE_MEDIA_MAX_BYTES_ENV]: "not-a-number" },
      }).remoteMediaMaxBytes,
    ).toBeNull();
    expect(normalizeRemoteMediaMaxBytes(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeRemoteMediaMaxBytes(-1)).toBeNull();
    expect(normalizeRemoteMediaMaxBytes(0.5)).toBeNull();
    expect(normalizeRemoteMediaMaxBytes("1.5")).toBeNull();
  });

  it("allows callers to opt in to a larger finite cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "summarize-media-cap-"));
    const filePath = join(dir, "episode.mp3");
    const defaultMaxBytes = 64 * 1024;
    const optInMaxBytes = defaultMaxBytes + 1;

    const fetchImpl = async () =>
      new Response(oversizedStream({ firstChunkBytes: defaultMaxBytes, secondChunkBytes: 1 }), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });

    try {
      await expect(
        downloadToFile(
          fetchImpl as unknown as typeof fetch,
          "https://example.com/episode.mp3",
          filePath,
          {
            maxBytes: optInMaxBytes,
            totalBytes: null,
          },
        ),
      ).resolves.toBe(optInMaxBytes);

      await expect(stat(filePath).then((entry) => entry.size)).resolves.toBe(optInMaxBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects capped in-memory streams that continue after the configured byte limit", async () => {
    const maxBytes = 64 * 1024;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: `bytes=0-${maxBytes - 1}` });
      return new Response(oversizedStream({ firstChunkBytes: maxBytes, secondChunkBytes: 1 }), {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-range": `bytes 0-${maxBytes - 1}/${maxBytes + 1}`,
        },
      });
    };

    await expect(
      downloadCappedBytes(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/episode.mp3",
        maxBytes,
        {
          rejectAboveBytes: maxBytes,
          totalBytes: null,
        },
      ),
    ).rejects.toThrow("Remote media too large");
  });

  it("checks strict overflow beyond the retained in-memory prefix", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: "bytes=0-2" });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-2/6" },
      });
    };

    await expect(
      downloadCappedBytes(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/episode.mp3",
        3,
        {
          rejectAboveBytes: 5,
          totalBytes: null,
        },
      ),
    ).rejects.toThrow("Remote media too large");
  });

  it("rejects ranged responses that stream beyond their declared range", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: "bytes=0-2" });
      return new Response(oversizedStream({ firstChunkBytes: 3, secondChunkBytes: 1 }), {
        status: 206,
        headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-2/3" },
      });
    };

    await expect(
      downloadCappedBytes(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/episode.mp3",
        3,
        {
          rejectAboveBytes: 5,
          totalBytes: null,
        },
      ),
    ).rejects.toThrow("range response exceeded declared length");
  });

  it("rejects under-reported in-memory streams that exceed the configured byte limit", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: "bytes=0-2" });
      return new Response(oversizedStream({ firstChunkBytes: 3, secondChunkBytes: 3 }), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "3" },
      });
    };

    await expect(
      downloadCappedBytes(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/episode.mp3",
        3,
        {
          rejectAboveBytes: 5,
          totalBytes: null,
        },
      ),
    ).rejects.toThrow("Remote media too large");
  });

  it("does not read past the retained prefix for declared safe larger bodies", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: "bytes=0-2" });
      return new Response(oversizedStream({ firstChunkBytes: 3, secondChunkBytes: 3 }), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "4" },
      });
    };

    const bytes = await downloadCappedBytes(
      fetchImpl as unknown as typeof fetch,
      "https://example.com/episode.mp3",
      3,
      {
        rejectAboveBytes: 5,
        totalBytes: 3,
      },
    );

    expect(bytes.byteLength).toBe(3);
  });

  it("checks unknown in-memory response sizes by reading beyond the retained prefix", async () => {
    const maxBytes = 64 * 1024;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: `bytes=0-${maxBytes - 1}` });
      return new Response(oversizedStream({ firstChunkBytes: maxBytes, secondChunkBytes: 1 }), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };

    await expect(
      downloadCappedBytes(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/episode.mp3",
        maxBytes,
        {
          rejectAboveBytes: maxBytes,
          totalBytes: null,
        },
      ),
    ).rejects.toThrow("Remote media too large");
  });

  it("rejects streaming downloads before writing past the configured byte limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "summarize-media-cap-"));
    const filePath = join(dir, "episode.mp3");
    const maxBytes = 64 * 1024;

    const fetchImpl = async () =>
      new Response(oversizedStream({ firstChunkBytes: maxBytes, secondChunkBytes: 1 }), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": String(maxBytes) },
      });

    try {
      await expect(
        downloadToFile(
          fetchImpl as unknown as typeof fetch,
          "https://example.com/episode.mp3",
          filePath,
          {
            maxBytes,
            totalBytes: maxBytes,
          },
        ),
      ).rejects.toThrow("Remote media too large");

      await expect(stat(filePath).then((entry) => entry.size)).resolves.toBe(maxBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-streaming downloads before writing files above the configured byte limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "summarize-media-cap-"));
    const filePath = join(dir, "episode.mp3");
    const maxBytes = 64 * 1024;

    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        body: null,
        async arrayBuffer() {
          return new Uint8Array(maxBytes + 1).buffer;
        },
      }) as Response;

    try {
      await expect(
        downloadToFile(
          fetchImpl as unknown as typeof fetch,
          "https://example.com/episode.mp3",
          filePath,
          {
            maxBytes,
            totalBytes: null,
          },
        ),
      ).rejects.toThrow("Remote media too large");
      await expect(readFile(filePath)).rejects.toThrow();
    } finally {
      await unlink(filePath).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
