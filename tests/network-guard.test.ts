import { createNetworkGuardedFetch } from "@steipete/summarize-core/content";
import { describe, expect, it, vi } from "vitest";

const sourceUrl = "https://8.8.8.8/start";
const credentials = {
  Authorization: "Bearer synthetic-placeholder",
  "Proxy-Authorization": "Basic synthetic-placeholder",
  Cookie: "session=synthetic-placeholder",
  Cookie2: "legacy=synthetic-placeholder",
  Accept: "text/plain",
};

function redirect(location: string) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    status: 302,
    headers: { location },
  });
  return { response, cancel };
}

describe("network guard redirects", () => {
  it.each(["https://1.1.1.1/content", "http://8.8.8.8/content", "https://8.8.8.8:8443/content"])(
    "strips credentials when following a different origin: %s",
    async (location) => {
      const first = redirect(location);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(new Response("ok"));
      const guarded = createNetworkGuardedFetch(fetchImpl, { targetLabel: "Test URL" });
      const headers = new Headers(credentials);
      await (await guarded(sourceUrl, { headers })).text();

      const [input, init] = fetchImpl.mock.calls[1]!;
      const followed = new Request(input, init);
      expect(followed.url).toBe(location);
      for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2"]) {
        expect(followed.headers.has(name)).toBe(false);
        expect(headers.has(name)).toBe(true);
      }
      expect(followed.headers.get("accept")).toBe("text/plain");
      expect(first.cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "preserves same-origin request state (Request input: %s)",
    async (asRequest) => {
      const first = redirect("/content");
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(new Response("ok"));
      const guarded = createNetworkGuardedFetch(fetchImpl, { targetLabel: "Test URL" });
      const controller = new AbortController();
      const options: RequestInit = {
        headers: credentials,
        method: "HEAD",
        signal: controller.signal,
        credentials: "include",
        cache: "no-store",
      };
      const input = asRequest ? new Request(sourceUrl, options) : sourceUrl;
      await guarded(input, asRequest ? undefined : options);

      const [nextInput, nextInit] = fetchImpl.mock.calls[1]!;
      const followed = new Request(nextInput, nextInit);
      expect(followed.url).toBe("https://8.8.8.8/content");
      expect(followed.method).toBe("HEAD");
      expect(followed.headers.get("authorization")).toBe(credentials.Authorization);
      expect(followed.credentials).toBe("include");
      expect(followed.cache).toBe("no-store");
      controller.abort();
      expect(followed.signal.aborted).toBe(true);
      expect(first.cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not restore Request credentials after crossing an origin", async () => {
    const first = redirect("https://1.1.1.1/content");
    const second = redirect("https://8.8.8.8/return");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(new Response("ok"));
    const guarded = createNetworkGuardedFetch(fetchImpl, { targetLabel: "Test URL" });
    await guarded(new Request(sourceUrl, { headers: credentials }));

    for (const [input, init] of fetchImpl.mock.calls.slice(1)) {
      const request = new Request(input, init);
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.headers.get("accept")).toBe("text/plain");
    }
  });

  it.each([
    { location: "http://127.0.0.1/private", options: {}, init: {}, error: /blocked/ },
    { location: "http://[", options: {}, init: {}, error: /Invalid URL/ },
    { location: "/next", options: { maxRedirects: 0 }, init: {}, error: /too many/ },
    { location: "/next", options: {}, init: { method: "POST" }, error: /non-GET/ },
  ])(
    "cancels discarded bodies before redirect errors: $error",
    async ({ location, options, init, error }) => {
      const first = redirect(location);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(first.response);
      const guarded = createNetworkGuardedFetch(fetchImpl, { targetLabel: "Test URL", ...options });
      await expect(guarded(sourceUrl, init)).rejects.toThrow(error);
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("leaves manual redirects and redirects without a location for the caller to consume", async () => {
    const first = redirect("/next");
    const second = new Response("missing location", { status: 302 });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second);
    const guarded = createNetworkGuardedFetch(fetchImpl, { targetLabel: "Test URL" });
    expect(await guarded(sourceUrl, { redirect: "manual" })).toBe(first.response);
    expect(first.cancel).not.toHaveBeenCalled();
    await first.response.body?.cancel();
    expect(await guarded(sourceUrl)).toBe(second);
    await expect(second.text()).resolves.toBe("missing location");
  });
});
