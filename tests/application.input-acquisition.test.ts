import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLocalAssetInput,
  acquireRemoteAssetInput,
  createRemoteMediaInput,
  isPdfAssetPath,
  isTranscribableAssetPath,
  resolveUrlAssetRoute,
} from "../src/application/input-acquisition.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("application input acquisition", () => {
  it("routes direct local media without reading it as a bounded attachment", async () => {
    const input = await acquireLocalAssetInput({ filePath: "/missing/large-video.mp4" });

    expect(input).toEqual({
      kind: "resolved-media",
      sourceKind: "file",
      sourceLabel: "/missing/large-video.mp4",
      attachment: {
        kind: "file",
        filename: "large-video.mp4",
        mediaType: "audio/mpeg",
        bytes: new Uint8Array(0),
      },
    });
  });

  it("loads local assets and routes sniffed media to media execution", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "summarize-acquisition-"));
    tempDirs.push(dir);
    const textPath = path.join(dir, "notes.txt");
    const mediaPath = path.join(dir, "recording.bin");
    await writeFile(textPath, "hello");
    await writeFile(
      mediaPath,
      Buffer.from(
        "524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000",
        "hex",
      ),
    );

    await expect(acquireLocalAssetInput({ filePath: textPath })).resolves.toMatchObject({
      kind: "resolved-asset",
      sourceKind: "file",
      sourceLabel: textPath,
      attachment: { mediaType: "text/plain", filename: "notes.txt" },
    });
    await expect(acquireLocalAssetInput({ filePath: mediaPath })).resolves.toMatchObject({
      kind: "resolved-media",
      sourceKind: "file",
      sourceLabel: mediaPath,
      attachment: { mediaType: "audio/wav", filename: "recording.bin" },
    });
  });

  it("resolves URL routes without downloading asset bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    await expect(
      resolveUrlAssetRoute({
        url: "https://example.com/audio.mp3?token=abc",
        isYoutubeUrl: false,
        fetchImpl,
        timeoutMs: 1000,
      }),
    ).resolves.toBe("media");
    await expect(
      resolveUrlAssetRoute({
        url: "https://example.com/article?id=123",
        isYoutubeUrl: false,
        fetchImpl,
        timeoutMs: 1000,
        detectUnknownAssetUrls: false,
      }),
    ).resolves.toBe("none");
    await expect(
      resolveUrlAssetRoute({
        url: "https://example.com/article?id=123",
        isYoutubeUrl: false,
        fetchImpl,
        timeoutMs: 1000,
        assumeAsset: true,
      }),
    ).resolves.toBe("asset");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads remote assets and treats HTML responses as an acquisition miss", async () => {
    const asset = await acquireRemoteAssetInput({
      url: "https://example.com/report.pdf",
      timeoutMs: 1000,
      fetchImpl: async () =>
        new Response("%PDF-1.4\n", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });
    const html = await acquireRemoteAssetInput({
      url: "https://example.com/download",
      timeoutMs: 1000,
      fetchImpl: async () =>
        new Response("<html><body>hello</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    expect(asset).toMatchObject({
      kind: "resolved-asset",
      sourceKind: "asset-url",
      sourceLabel: "https://example.com/report.pdf",
      attachment: { mediaType: "application/pdf", filename: "report.pdf" },
    });
    expect(html).toBeNull();
  });

  it("keeps extension and remote media metadata policy in one module", () => {
    expect(isPdfAssetPath("https://example.com/report.PDF?download=1")).toBe(true);
    expect(isTranscribableAssetPath("https://example.com/video.webm?token=1")).toBe(true);
    expect(createRemoteMediaInput("https://example.com/path/audio.mp3?token=1")).toMatchObject({
      kind: "resolved-media",
      sourceKind: "asset-url",
      sourceLabel: "https://example.com/path/audio.mp3?token=1",
      attachment: { filename: "audio.mp3", mediaType: "audio/mpeg" },
    });
  });
});
