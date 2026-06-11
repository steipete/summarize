import { describe, expect, it, vi } from "vitest";
import { downloadYoutubeBytesWithRanges } from "../apps/chrome-extension/src/entrypoints/offscreen/youtube-audio.js";

describe("Chrome YouTube ranged audio download", () => {
  it("downloads the complete byte range", async () => {
    const source = Uint8Array.from({ length: 600_000 }, (_, index) => index % 251);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "");
      if (!match) return new Response(null, { status: 400 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(source.slice(start, end + 1), { status: 206 });
    });

    const downloaded = await downloadYoutubeBytesWithRanges({
      url: "https://example.invalid/audio",
      contentLength: source.byteLength,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(downloaded).toEqual(source);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("range")).toBe("bytes=0-599999");
  });

  it("rejects media larger than the browser limit before fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      downloadYoutubeBytesWithRanges({
        url: "https://example.invalid/audio",
        contentLength: 129 * 1024 * 1024,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/too large/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a complete HTTP 200 response when the server ignores the range header", async () => {
    const source = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const fetchImpl = vi.fn(
      async () => new Response(source, { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      downloadYoutubeBytesWithRanges({
        url: "https://example.invalid/audio",
        contentLength: source.byteLength,
        fetchImpl,
      }),
    ).resolves.toEqual(source);
  });

  it("retries transient range failures", async () => {
    const source = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251);
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      const attempt = (attempts.get(range) ?? 0) + 1;
      attempts.set(range, attempt);
      if (attempt === 1) throw new TypeError("Failed to fetch");
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
      if (!match) return new Response(null, { status: 400 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(source.slice(start, end + 1), { status: 206 });
    });

    const downloaded = await downloadYoutubeBytesWithRanges({
      url: "https://example.invalid/audio",
      contentLength: source.byteLength,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(downloaded).toEqual(source);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
