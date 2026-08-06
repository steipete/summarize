import { describe, expect, it, vi } from "vitest";
import type { AcquiredAssetExecutor } from "../src/application/asset-execution.js";
import type {
  SummarizeEventSink,
  SummarizeRequest,
} from "../src/application/summarize-contracts.js";
import { resolveInitialUrlInput } from "../src/application/url-routing.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

// Regression guard for an SSRF-filter bypass: remote asset classification and
// download must go through the SSRF-guarded `io.urlFetch` (the daemon's
// network-guarded fetch that blocks private/link-local targets and
// re-validates redirects) rather than the raw `io.fetch`, matching every
// other user-URL flow (extraction-session, video-only, slides-session).
describe("url-routing remote asset SSRF guard", () => {
  function pdfResponse(): Response {
    return new Response("%PDF-1.4\n", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }

  function buildContext(guardedFetch: typeof fetch, rawFetch: typeof fetch): UrlFlowContext {
    return {
      io: { fetch: rawFetch, urlFetch: guardedFetch },
      flags: { timeoutMs: 1000 },
    } as unknown as UrlFlowContext;
  }

  it("downloads remote assets through the guarded urlFetch, never the raw fetch", async () => {
    const guardedFetch = vi.fn(async () => pdfResponse()) as unknown as typeof fetch;
    const rawFetch = vi.fn(async () => {
      throw new Error("raw io.fetch must not be used for user-URL asset downloads");
    }) as unknown as typeof fetch;

    const assetExecutor = {
      execute: vi.fn(),
      emitProgress: vi.fn(),
    } as unknown as AcquiredAssetExecutor;
    const emit: SummarizeEventSink = vi.fn();

    const result = await resolveInitialUrlInput({
      input: {
        kind: "input-url",
        url: "https://example.com/report.pdf",
        title: null,
        maxCharacters: null,
      },
      request: { slides: false } as unknown as SummarizeRequest,
      isYoutubeUrl: false,
      ctx: buildContext(guardedFetch, rawFetch),
      assetExecutor,
      emit,
    });

    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(rawFetch).not.toHaveBeenCalled();
    expect(result.input).toMatchObject({ kind: "resolved-asset" });
  });
});
