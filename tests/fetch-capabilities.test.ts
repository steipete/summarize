import { describe, expect, it, vi } from "vitest";
import {
  attachDnsPinnedAddresses as attachCoreDnsPinnedAddresses,
  isNativeOrBoundGlobalFetch as isCoreNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned as markCoreFetchAsDnsPinned,
  readDnsPinnedAddresses as readCoreDnsPinnedAddresses,
  resolveDnsPinnedFetch as resolveCoreDnsPinnedFetch,
  supportsDnsPinnedFetch as coreSupportsDnsPinnedFetch,
} from "../packages/core/src/content/index.js";
import { createRunMetrics } from "../src/run/run-metrics.js";
import {
  attachDnsPinnedAddresses as attachRootDnsPinnedAddresses,
  isNativeOrBoundGlobalFetch as isRootNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned as markRootFetchAsDnsPinned,
  readDnsPinnedAddresses as readRootDnsPinnedAddresses,
  resolveDnsPinnedFetch as resolveRootDnsPinnedFetch,
  supportsDnsPinnedFetch as rootSupportsDnsPinnedFetch,
} from "../src/shared/fetch-capabilities.js";

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
    expect(coreSupportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
    expect(rootSupportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
  });

  it("does not advertise Bun global fetch as an explicit DNS-pinned wrapper", async () => {
    await withBunRuntime(() => {
      expect(coreSupportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
      expect(rootSupportsDnsPinnedFetch(globalThis.fetch)).toBe(false);
    });
  });

  it("recognizes global fetch and bound global fetch as native fetch transports", () => {
    const boundGlobalFetch = globalThis.fetch.bind(globalThis);
    const customFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;

    expect(isCoreNativeOrBoundGlobalFetch(globalThis.fetch)).toBe(true);
    expect(isRootNativeOrBoundGlobalFetch(globalThis.fetch)).toBe(true);
    expect(isCoreNativeOrBoundGlobalFetch(boundGlobalFetch)).toBe(true);
    expect(isRootNativeOrBoundGlobalFetch(boundGlobalFetch)).toBe(true);
    expect(isCoreNativeOrBoundGlobalFetch(customFetch)).toBe(false);
    expect(isRootNativeOrBoundGlobalFetch(customFetch)).toBe(false);
  });

  it("shares explicit DNS-pinned markers across core and root helpers", () => {
    const coreMarked = markCoreFetchAsDnsPinned(async () => new Response("ok"));
    const rootMarked = markRootFetchAsDnsPinned(async () => new Response("ok"));

    expect(rootSupportsDnsPinnedFetch(coreMarked)).toBe(true);
    expect(coreSupportsDnsPinnedFetch(rootMarked)).toBe(true);
    expect(resolveRootDnsPinnedFetch(coreMarked)).toBe(coreMarked);
    expect(resolveCoreDnsPinnedFetch(rootMarked)).toBe(rootMarked);
  });

  it("preserves pinned address metadata through RequestInit cloning", () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }];

    const rootInit = attachRootDnsPinnedAddresses({ redirect: "manual" }, addresses);
    const coreInit = attachCoreDnsPinnedAddresses({ redirect: "manual" }, addresses);

    expect(readRootDnsPinnedAddresses({ ...rootInit })).toEqual(addresses);
    expect(readCoreDnsPinnedAddresses({ ...coreInit })).toEqual(addresses);
  });

  it("preserves explicit pinned transports through the run metrics fetch wrapper", async () => {
    const baseFetch = vi.fn(async () => new Response("base")) as unknown as typeof fetch;
    const pinnedFetch = vi.fn(async () => new Response("pinned")) as unknown as typeof fetch;
    const metrics = createRunMetrics({
      env: {},
      fetchImpl: markRootFetchAsDnsPinned(baseFetch, pinnedFetch),
      maxOutputTokensArg: null,
    });
    const trackedPinnedFetch = resolveRootDnsPinnedFetch(metrics.trackedFetch);

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
      const trackedPinnedFetch = resolveRootDnsPinnedFetch(metrics.trackedFetch);

      expect(trackedPinnedFetch).toBeTruthy();
      expect(trackedPinnedFetch).not.toBe(globalThis.fetch);
    });
  });
});
