import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { withUrlAsset } from "../src/run/flows/asset/input.js";

describe("media URL routing", () => {
  it("routes direct media URLs with query parameters to transcription", async () => {
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const summarizeMediaFile = vi.fn(async () => {});
    const ctx = {
      env: {},
      stderr,
      progressEnabled: false,
      timeoutMs: 1000,
      trackedFetch: vi.fn(async () => {
        throw new Error("fetch should not be called");
      }) as unknown as typeof fetch,
      summarizeAsset: vi.fn(async () => {
        throw new Error("summarizeAsset should not be called");
      }),
      summarizeMediaFile,
      setClearProgressBeforeStdout: vi.fn(),
      clearProgressIfCurrent: vi.fn(),
    };

    const handled = await withUrlAsset(
      ctx,
      "https://example.com/audio.mp3?token=abc",
      false,
      async () => {
        throw new Error("handler should not be called");
      },
    );

    expect(handled).toBe(true);
    expect(summarizeMediaFile).toHaveBeenCalledTimes(1);
  });

  it("skips unknown asset probing when the fast website path opts out", async () => {
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    const handled = await withUrlAsset(
      {
        env: {},
        envForRun: {},
        stderr,
        progressEnabled: false,
        timeoutMs: 1000,
        trackedFetch: fetchImpl as unknown as typeof fetch,
        summarizeAsset: vi.fn(async () => {}),
        summarizeMediaFile: vi.fn(async () => {}),
        setClearProgressBeforeStdout: vi.fn(),
        clearProgressIfCurrent: vi.fn(),
      },
      "https://example.com/article?id=123",
      false,
      async () => {
        throw new Error("handler should not be called");
      },
      { detectUnknownAssetUrls: false },
    );

    expect(handled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps HEAD classification for download-shaped extensionless URLs", async () => {
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "Content-Type": "application/pdf" } });
      }
      return new Response("%PDF-1.4\n", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    });
    const handler = vi.fn(async () => {});

    const handled = await withUrlAsset(
      {
        env: {},
        envForRun: {},
        stderr,
        progressEnabled: false,
        timeoutMs: 1000,
        trackedFetch: fetchImpl as unknown as typeof fetch,
        summarizeAsset: vi.fn(async () => {}),
        summarizeMediaFile: vi.fn(async () => {}),
        setClearProgressBeforeStdout: vi.fn(),
        clearProgressIfCurrent: vi.fn(),
      },
      "https://example.com/download?id=123",
      false,
      handler,
      { detectUnknownAssetUrls: false },
    );

    expect(handled).toBe(true);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["HEAD", "GET"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
