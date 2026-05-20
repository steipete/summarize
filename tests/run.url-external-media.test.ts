import { describe, expect, it, vi } from "vitest";
import { resolveUrlFlowYtDlpPath } from "../src/run/flows/url/external-media.js";

describe("URL flow external media downloader policy", () => {
  it("keeps yt-dlp available for unguarded CLI URL flows", () => {
    expect(resolveUrlFlowYtDlpPath({ ytDlpPath: "/usr/bin/yt-dlp" })).toBe("/usr/bin/yt-dlp");
  });

  it("disables yt-dlp when guarded daemon URL fetches are active", () => {
    const guardedFetch = vi.fn() as unknown as typeof fetch;

    expect(
      resolveUrlFlowYtDlpPath({
        urlFetch: guardedFetch,
        ytDlpPath: "/usr/bin/yt-dlp",
      }),
    ).toBeNull();
  });
});
