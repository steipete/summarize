import { describe, expect, it } from "vitest";
import {
  buildLengthPartsForFinishLine,
  type ExtractedForLengths,
} from "../src/run/finish-line-lengths.js";

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
    expect(
      buildLengthPartsForFinishLine(extracted("https://notyoutube.com/watch?v=abcdefghijk"), false),
    ).toEqual(["txc=1m podcast · 160 words"]);
  });
});
