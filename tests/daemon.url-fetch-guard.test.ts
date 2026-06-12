import { markFetchAsDnsPinned } from "@steipete/summarize-core/content";
import { describe, expect, it, vi } from "vitest";
import {
  assertDaemonUrlFetchAllowed,
  createDaemonUrlFetchGuard,
} from "../src/daemon/url-fetch-guard.js";

async function withBunRuntime<T>(fn: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  Object.defineProperty(process.versions, "bun", {
    configurable: true,
    value: "1.3.0",
  });
  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.versions, "bun", descriptor);
    } else {
      delete (process.versions as { bun?: string }).bun;
    }
  }
}

describe("daemon URL fetch guard", () => {
  it("validates resolved DNS addresses before URL extraction fetches", async () => {
    await expect(
      assertDaemonUrlFetchAllowed("https://public.example/article", {
        lookup: async () => [{ address: "93.184.216.34" }],
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertDaemonUrlFetchAllowed("https://internal.example/admin", {
        lookup: async () => [{ address: "127.0.0.1" }],
      }),
    ).rejects.toThrow(/blocked local network address/);
  });

  it("handles bracketed IPv6 URL literals without DNS lookup", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1" }]);

    await expect(
      assertDaemonUrlFetchAllowed("https://[2606:4700:4700::1111]/", { lookup }),
    ).resolves.toBeUndefined();
    await expect(assertDaemonUrlFetchAllowed("https://[::1]/", { lookup })).rejects.toThrow(
      /blocked local network address/,
    );
    await expect(
      assertDaemonUrlFetchAllowed("https://[::ffff:0:c0a8:101]/", { lookup }),
    ).rejects.toThrow(/blocked local network address/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("pins fetch DNS resolution to the validated address", async () => {
    const fetchImpl = markFetchAsDnsPinned(
      vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    );
    const guarded = createDaemonUrlFetchGuard(fetchImpl as unknown as typeof fetch, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    await expect(guarded("https://public.example/article")).resolves.toBeInstanceOf(Response);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://public.example/article",
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("routes Bun global fetch through a pinned transport for hostname targets", async () => {
    await withBunRuntime(async () => {
      const pinnedFetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
      const guarded = createDaemonUrlFetchGuard(globalThis.fetch, {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImpl: pinnedFetchImpl as unknown as typeof fetch,
      });

      await expect(guarded("https://public.example/article")).resolves.toBeInstanceOf(Response);

      expect(pinnedFetchImpl).toHaveBeenCalledWith(
        "https://public.example/article",
        expect.objectContaining({
          redirect: "manual",
          dispatcher: expect.any(Object),
        }),
      );
    });
  });

  it("routes bound global fetch through a pinned transport for hostname targets", async () => {
    const pinnedFetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const guarded = createDaemonUrlFetchGuard(globalThis.fetch.bind(globalThis), {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImpl: pinnedFetchImpl as unknown as typeof fetch,
    });

    await expect(guarded("https://public.example/article")).resolves.toBeInstanceOf(Response);

    expect(pinnedFetchImpl).toHaveBeenCalledWith(
      "https://public.example/article",
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("revalidates redirect targets instead of auto-following to private hosts", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8787/v1/logs" },
      });
    });
    const guarded = createDaemonUrlFetchGuard(fetchImpl as unknown as typeof fetch);

    await expect(guarded("http://8.8.8.8/redirect")).rejects.toThrow(
      /blocked local network address/,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://8.8.8.8/redirect",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
