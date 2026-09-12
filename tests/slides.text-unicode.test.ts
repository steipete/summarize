import { describe, expect, it } from "vitest";
import { getTranscriptTextForSlide, truncateSlideText } from "../packages/core/src/slides/text.js";

describe("slide text character budgets", () => {
  it.each<[string, number, string]>([
    ["a🦞bc", 2, "a..."],
    ["🦞bc", 1, ""],
    ["🦞bc", 2, "🦞..."],
    ["abc defghi", 6, "abc..."],
  ])("truncates %s at %i without splitting a surrogate pair", (text, limit, expected) => {
    expect(truncateSlideText(text, limit)).toBe(expected);
  });

  it("keeps transcript fallback text well formed at the budget boundary", () => {
    const prefix = "a".repeat(79);
    expect(
      getTranscriptTextForSlide({
        slide: { index: 1, timestamp: 0 },
        nextSlide: null,
        segments: [{ startSeconds: 0, text: `${prefix}🦞tail` }],
        budget: 80,
        windowSeconds: 30,
      }),
    ).toBe(`${prefix}...`);
  });
});
