import { describe, expect, it } from "vitest";
import {
  buildLengthPartsForFinishLine,
  type ExtractedForLengths,
} from "../src/run/finish-line-lengths.js";
import { buildFinishLineText } from "../src/run/finish-line.js";

const extracted = (url: string): ExtractedForLengths => ({
  url,
  siteName: "Example",
  totalCharacters: 1_000,
  wordCount: 160,
  transcriptCharacters: 960,
  transcriptLines: 10,
  transcriptWordCount: 160,
  transcriptSource: "generic",
  transcriptionProvider: null,
  mediaDurationSeconds: 60,
  video: null,
  isVideoOnly: false,
  diagnostics: { transcript: { cacheStatus: "miss" } },
});

describe("finish line transcript lengths", () => {
  it("does not label lookalike hostnames as YouTube", () => {
    const text = buildFinishLineText({
      elapsedMs: 1000,
      model: null,
      costUsd: null,
      detailed: false,
      report: { llm: [], services: { firecrawl: { requests: 0 }, apify: { requests: 0 } } },
      extraParts: buildLengthPartsForFinishLine(
        extracted("https://notyoutube.com/watch?v=abcdefghijk"),
        false,
      ),
    });
    expect(text.line).toContain("1m podcast · 160 words");
    expect(text.line).not.toContain("YouTube");
  });
});
