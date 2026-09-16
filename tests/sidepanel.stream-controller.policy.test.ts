import { describe, expect, it } from "vitest";
import {
  getTerminalStreamError,
  shouldSurfaceStreamingStatus,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller-policy";

describe("sidepanel stream controller policy", () => {
  it("uses keyed phases independently of localized status text", () => {
    expect(
      shouldSurfaceStreamingStatus({
        streamedAnyNonWhitespace: true,
        statusText: "Slaytlar hazırlanıyor",
        messageKey: "progress.slides",
      }),
    ).toBe(true);
    expect(
      shouldSurfaceStreamingStatus({
        streamedAnyNonWhitespace: true,
        statusText: "Slides: user-supplied label",
        messageKey: "progress.fetchingPage",
      }),
    ).toBe(false);
  });
  it("keeps slide status visible during streaming output", () => {
    expect(
      shouldSurfaceStreamingStatus({
        streamedAnyNonWhitespace: true,
        statusText: "slides: extracting frames",
      }),
    ).toBe(true);
    expect(
      shouldSurfaceStreamingStatus({
        streamedAnyNonWhitespace: true,
        statusText: "fetching article",
      }),
    ).toBe(false);
  });

  it("normalizes terminal stream completion errors", () => {
    expect(
      getTerminalStreamError({ sawDone: false, streamedAnyNonWhitespace: true })?.message,
    ).toBe("Stream ended unexpectedly. The daemon may have stopped.");
    expect(
      getTerminalStreamError({ sawDone: true, streamedAnyNonWhitespace: false })?.message,
    ).toBe("Model returned no output.");
    expect(getTerminalStreamError({ sawDone: true, streamedAnyNonWhitespace: true })).toBeNull();
  });
});
