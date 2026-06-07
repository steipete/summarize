import { describe, expect, it } from "vitest";
import {
  mergeSlidesPayload,
  normalizeSlidesPayload,
  resolveSlidesPayload,
  slidesPayloadChanged,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-payload";
import type { SseSlidesData } from "../src/shared/sse-events";

function buildSlidesPayload({
  sourceId = "youtube-abc123",
  count,
  withImages,
  textPrefix = "Slide",
}: {
  sourceId?: string;
  count: number;
  withImages: boolean;
  textPrefix?: string;
}): SseSlidesData {
  return {
    sourceUrl: `https://www.youtube.com/watch?v=${sourceId.replace(/^youtube-/, "")}`,
    sourceId,
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: Array.from({ length: count }, (_, index) => {
      const slideIndex = index + 1;
      return {
        index: slideIndex,
        timestamp: index * 10,
        imageUrl: withImages ? `http://127.0.0.1:8787/v1/slides/${sourceId}/${slideIndex}?v=1` : "",
        ocrText: `${textPrefix} ${slideIndex}`,
        ocrConfidence: 0.9,
      };
    }),
  };
}

describe("sidepanel slides payload policy", () => {
  it("merges same-source payloads when the previous payload is already resolved and the next one is partial", () => {
    const initial = buildSlidesPayload({ count: 2, withImages: true, textPrefix: "Initial" });
    const partial: SseSlidesData = {
      ...initial,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "",
          ocrText: "Updated 1",
          ocrConfidence: 0.8,
        },
      ],
    };

    const next = resolveSlidesPayload(initial, partial, {
      activeSlidesRunId: "slides-a",
      appliedSlidesRunId: "slides-a",
    });

    expect(next.slides).toHaveLength(2);
    expect(next.slides[0]?.ocrText).toBe("Updated 1");
    expect(next.slides[1]?.ocrText).toBe("Initial 2");
  });

  it("replaces unresolved placeholders with a resolved smaller payload for the same source", () => {
    const seeded = buildSlidesPayload({ count: 2, withImages: false, textPrefix: "Seeded" });
    const resolved = buildSlidesPayload({ count: 1, withImages: true, textPrefix: "Real" });

    const next = resolveSlidesPayload(seeded, resolved, {
      seededSourceId: null,
      activeSlidesRunId: "slides-a",
      appliedSlidesRunId: "slides-a",
    });

    expect(next.slides).toHaveLength(1);
    expect(next.slides[0]?.ocrText).toBe("Real 1");
    expect(next.slides[0]?.imageUrl).toContain("/1?v=1");
  });

  it("replaces a resolved payload when a rerun for the same source returns fewer slides", () => {
    const initial = buildSlidesPayload({ count: 3, withImages: true, textPrefix: "First run" });
    const rerun = buildSlidesPayload({ count: 1, withImages: true, textPrefix: "Second run" });

    const next = resolveSlidesPayload(initial, rerun, {
      activeSlidesRunId: "slides-b",
      appliedSlidesRunId: "slides-b",
    });

    expect(next.slides).toHaveLength(1);
    expect(next.slides[0]?.ocrText).toBe("Second run 1");
  });

  it("marks unchanged authoritative payloads as unchanged", () => {
    const payload = buildSlidesPayload({ count: 1, withImages: true });

    expect(slidesPayloadChanged(payload, payload)).toBe(false);
  });

  it("marks changed payloads when slide metadata changes", () => {
    const payload = buildSlidesPayload({ count: 1, withImages: true });
    const changed: SseSlidesData = {
      ...payload,
      ocrAvailable: false,
      slides: [{ ...payload.slides[0], imageUrl: `${payload.slides[0]?.imageUrl}&v=2` }],
    };

    expect(slidesPayloadChanged(payload, changed)).toBe(true);
  });

  it("preserves timed transcript text from the slides stream", () => {
    const normalized = normalizeSlidesPayload({
      ...buildSlidesPayload({ count: 1, withImages: true }),
      transcriptTimedText: "[00:01] intro",
    });

    expect(normalized?.transcriptTimedText).toBe("[00:01] intro");
    expect(slidesPayloadChanged({ ...normalized!, transcriptTimedText: null }, normalized!)).toBe(
      true,
    );
  });

  it("preserves explicit slide runtime metadata", () => {
    const browserPayload = normalizeSlidesPayload({
      ...buildSlidesPayload({ count: 1, withImages: true }),
      slideRuntime: "browser",
    });
    const daemonPayload = normalizeSlidesPayload({
      ...buildSlidesPayload({ count: 1, withImages: true }),
      slideRuntime: "daemon",
    });
    const invalidPayload = normalizeSlidesPayload({
      ...buildSlidesPayload({ count: 1, withImages: true }),
      slideRuntime: "native",
    });

    expect(browserPayload?.slideRuntime).toBe("browser");
    expect(daemonPayload?.slideRuntime).toBe("daemon");
    expect(invalidPayload).not.toHaveProperty("slideRuntime");
  });

  it("tracks slide runtime changes while treating missing runtime as daemon", () => {
    const payload = buildSlidesPayload({ count: 1, withImages: true });
    const browserPayload = { ...payload, slideRuntime: "browser" as const };
    const daemonPayload = { ...payload, slideRuntime: "daemon" as const };

    expect(slidesPayloadChanged(payload, browserPayload)).toBe(true);
    expect(slidesPayloadChanged(payload, daemonPayload)).toBe(false);
    expect(slidesPayloadChanged(daemonPayload, payload)).toBe(false);
  });

  it("treats repeated malformed timestamps as unchanged after normalization", () => {
    const normalized = normalizeSlidesPayload({
      sourceUrl: "https://example.com",
      sourceId: "youtube-abc123",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: "bad", imageUrl: "" }],
    });

    expect(normalized).not.toBeNull();
    expect(slidesPayloadChanged(normalized, normalized!)).toBe(false);
  });

  it("replaces when the seeded source marker still matches", () => {
    const seeded = buildSlidesPayload({ count: 2, withImages: false, textPrefix: "Seeded" });
    const resolved = buildSlidesPayload({ count: 2, withImages: true, textPrefix: "Resolved" });

    const next = resolveSlidesPayload(seeded, resolved, {
      seededSourceId: "youtube-abc123",
      activeSlidesRunId: "slides-a",
      appliedSlidesRunId: "slides-a",
    });

    expect(next.slides[0]?.ocrText).toBe("Resolved 1");
    expect(next.slides[1]?.imageUrl).toContain("/2?v=1");
  });

  it("replaces when a different slides run becomes active", () => {
    const initial = buildSlidesPayload({ count: 2, withImages: true, textPrefix: "Initial" });
    const rerun = buildSlidesPayload({ count: 1, withImages: true, textPrefix: "Rerun" });

    const next = resolveSlidesPayload(initial, rerun, {
      activeSlidesRunId: "slides-b",
      appliedSlidesRunId: "slides-a",
    });

    expect(next.slides).toHaveLength(1);
    expect(next.slides[0]?.ocrText).toBe("Rerun 1");
  });

  it("merges explicit payloads by slide index", () => {
    const initial = buildSlidesPayload({ count: 2, withImages: true, textPrefix: "Initial" });
    const merged = mergeSlidesPayload(initial, {
      ...initial,
      ocrAvailable: false,
      slides: [
        {
          index: 2,
          timestamp: 12,
          imageUrl: initial.slides[1]?.imageUrl ?? "",
          ocrText: "Merged 2",
          ocrConfidence: 0.5,
        },
      ],
    });

    expect(merged.ocrAvailable).toBe(false);
    expect(merged.slides).toHaveLength(2);
    expect(merged.slides[1]?.ocrText).toBe("Merged 2");
    expect(merged.slides[1]?.timestamp).toBe(12);
  });

  it("normalizes network payloads before slide rendering uses them", () => {
    const normalized = normalizeSlidesPayload({
      sourceUrl: 123,
      sourceId: " youtube-abc123 ",
      sourceKind: null,
      ocrAvailable: "yes",
      slides: [
        { index: 2, timestamp: 20, imageUrl: "  http://example.com/2.png  ", ocrText: 42 },
        { index: 0, timestamp: 0, imageUrl: "bad" },
        { index: Number.NaN, timestamp: 0, imageUrl: "bad" },
        { index: 1, timestamp: "not-a-number", imageUrl: null, ocrConfidence: Number.NaN },
        { index: 2, timestamp: 25, imageUrl: "http://example.com/2b.png", ocrText: "latest" },
      ],
    });

    expect(normalized?.sourceId).toBe("youtube-abc123");
    expect(normalized?.sourceKind).toBe("unknown");
    expect(normalized?.ocrAvailable).toBe(false);
    expect(normalized?.slides).toHaveLength(2);
    expect(normalized?.slides.map((slide) => slide.index)).toEqual([1, 2]);
    expect(Number.isNaN(normalized?.slides[0]?.timestamp)).toBe(true);
    expect(normalized?.slides[1]?.timestamp).toBe(25);
    expect(normalized?.slides[1]?.imageUrl).toBe("http://example.com/2b.png");
    expect(normalized?.slides[1]?.ocrText).toBe("latest");
  });

  it("rejects payloads when every slide entry is malformed", () => {
    const normalized = normalizeSlidesPayload({
      sourceUrl: "https://example.com",
      sourceId: "youtube-abc123",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 0, timestamp: 0, imageUrl: "bad" },
        { index: Number.NaN, timestamp: 1, imageUrl: "bad" },
      ],
    });

    expect(normalized).toBeNull();
  });
});
