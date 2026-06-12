import {
  attachDnsPinnedAddresses,
  isNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned,
  readDnsPinnedAddresses,
  resolveDnsPinnedFetch,
  supportsDnsPinnedFetch,
} from "@steipete/summarize-core/content";
import { describe, expect, it, vi } from "vitest";
import { createRunMetrics } from "../src/run/run-metrics.js";

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

describe("DNS-pinned fetch capabilities", () => {
  it("does not advertise unwrapped global fetch as an explicit DNS-pinned wrapper", () => {
    expect(supportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
  });

  it("does not advertise Bun global fetch as an explicit DNS-pinned wrapper", async () => {
    await withBunRuntime(() => {
      expect(supportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
    });
  });

  it("recognizes global fetch and bound global fetch as native fetch transports", () => {
    const boundGlobalFetch = globalThis.fetch.bind(globalThis);
    const customFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;

    expect(isNativeOrBoundGlobalFetch(globalThis.fetch)).toBe(true);
    expect(isNativeOrBoundGlobalFetch(boundGlobalFetch)).toBe(true);
    expect(isNativeOrBoundGlobalFetch(customFetch)).toBe(false);
  });

  it("recognizes explicit DNS-pinned markers", () => {
    const marked = markFetchAsDnsPinned(async () => new Response("ok"));
    expect(supportsDnsPinnedFetch(marked)).toBe(true);
    expect(resolveDnsPinnedFetch(marked)).toBe(marked);
  });

  it("preserves pinned address metadata through RequestInit cloning", () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }];
    const init = attachDnsPinnedAddresses({ redirect: "manual" }, addresses);
    expect(readDnsPinnedAddresses({ ...init })).toEqual(addresses);
  });

  it("preserves explicit pinned transports through the run metrics fetch wrapper", async () => {
    const baseFetch = vi.fn(async () => new Response("base")) as unknown as typeof fetch;
    const pinnedFetch = vi.fn(async () => new Response("pinned")) as unknown as typeof fetch;
    const metrics = createRunMetrics({
      env: {},
      fetchImpl: markFetchAsDnsPinned(baseFetch, pinnedFetch),
      maxOutputTokensArg: null,
    });
    const trackedPinnedFetch = resolveDnsPinnedFetch(metrics.trackedFetch);

    expect(trackedPinnedFetch).toBeTruthy();
    await expect(trackedPinnedFetch?.("https://api.firecrawl.dev/scrape")).resolves.toBeInstanceOf(
      Response,
    );

    expect(baseFetch).not.toHaveBeenCalled();
    expect(pinnedFetch).toHaveBeenCalledWith("https://api.firecrawl.dev/scrape", undefined);
    await expect(metrics.buildReport()).resolves.toMatchObject({
      services: { firecrawl: { requests: 1 } },
    });
  });

  it("preserves Bun native pinned transports through the run metrics fetch wrapper", async () => {
    await withBunRuntime(async () => {
      const metrics = createRunMetrics({
        env: {},
        fetchImpl: globalThis.fetch,
        maxOutputTokensArg: null,
      });
      const trackedPinnedFetch = resolveDnsPinnedFetch(metrics.trackedFetch);

      expect(trackedPinnedFetch).toBeTruthy();
      expect(trackedPinnedFetch).not.toBe(globalThis.fetch);
    });
  });
});
