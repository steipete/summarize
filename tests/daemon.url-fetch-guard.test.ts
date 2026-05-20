import { describe, expect, it, vi } from "vitest";
import {
  assertDaemonUrlFetchAllowed,
  createDaemonUrlFetchGuard,
  isBlockedNetworkAddress,
} from "../src/daemon/url-fetch-guard.js";

describe("daemon URL fetch guard", () => {
  it("blocks local and private network targets", async () => {
    expect(isBlockedNetworkAddress("127.0.0.1")).toBe(true);
    expect(isBlockedNetworkAddress("10.1.2.3")).toBe(true);
    expect(isBlockedNetworkAddress("172.16.0.1")).toBe(true);
    expect(isBlockedNetworkAddress("192.168.0.1")).toBe(true);
    expect(isBlockedNetworkAddress("169.254.169.254")).toBe(true);
    expect(isBlockedNetworkAddress("::1")).toBe(true);
    expect(isBlockedNetworkAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedNetworkAddress("::7f00:1")).toBe(true);
    expect(isBlockedNetworkAddress("fc00::1")).toBe(true);
    expect(isBlockedNetworkAddress("fe80::1")).toBe(true);
    expect(isBlockedNetworkAddress("8.8.8.8")).toBe(false);
    expect(isBlockedNetworkAddress("[2606:4700:4700::1111]")).toBe(false);
  });

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
    expect(lookup).not.toHaveBeenCalled();
  });

  it("pins fetch DNS resolution to the validated address", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
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
