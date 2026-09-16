import { describe, expect, it } from "vitest";
import { buildFinishLineText } from "../src/run/finish-line.js";

describe("finish line transcript label de-dupe", () => {
  it("does not repeat YouTube label when transcript label already includes it", () => {
    const text = buildFinishLineText({
      elapsedMs: 12_000,
      label: "YouTube",
      model: "openrouter/xiaomi/mimo-v2-flash:free",
      report: {
        llm: [{ promptTokens: 2600, completionTokens: 386, totalTokens: 2986, calls: 1 }],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      },
      costUsd: null,
      detailed: false,
      extraParts: [
        {
          kind: "compactTranscript",
          durationSeconds: 600,
          approximate: true,
          media: "YouTube",
          words: 1700,
        },
      ],
    });

    const occurrences = text.line.match(/YouTube/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it("drops the site label when transcript label already implies a podcast", () => {
    const text = buildFinishLineText({
      elapsedMs: 12_000,
      label: "Spotify",
      model: "openrouter/xiaomi/mimo-v2-flash:free",
      report: {
        llm: [{ promptTokens: 2600, completionTokens: 386, totalTokens: 2986, calls: 1 }],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      },
      costUsd: null,
      detailed: false,
      extraParts: [
        {
          kind: "compactTranscript",
          durationSeconds: 2700,
          approximate: true,
          media: "podcast",
          words: 12400,
        },
      ],
    });

    expect(text.line).not.toContain("Spotify");
  });
});
