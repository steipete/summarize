import { describe, expect, it } from "vitest";
import {
  applyContentBudget,
  clipAtSentenceBoundary,
  decodeHtmlEntities,
  normalizeCandidate,
  normalizeForPrompt,
  normalizeWhitespace,
  stripInvisibleUnicode,
} from "../packages/core/src/content/link-preview/content/cleaner.js";

describe("content cleaner utilities", () => {
  it("normalizes whitespace for prompts", () => {
    const input = `Hello\u00A0\u00A0world\t\t\n\n  next \n\n\n line`;
    expect(normalizeForPrompt(input)).toBe("Hello world\nnext\nline");
    expect(normalizeWhitespace(input)).toBe("Hello world\nnext\nline");
  });

  it("strips invisible unicode characters", () => {
    const input = `Hello\u200B\u200Cworld\u202E!\uFEFF\u{E0000}`;
    expect(stripInvisibleUnicode(input)).toBe("Helloworld!");
    expect(normalizeForPrompt(input)).toBe("Helloworld!");
    expect(normalizeWhitespace(input)).toBe("Helloworld!");
  });

  it("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("&lt;tag&gt; &amp; &#39;x&#39;")).toBe("<tag> & 'x'");
  });

  it("normalizes candidates", () => {
    expect(normalizeCandidate(null)).toBeNull();
    expect(normalizeCandidate("   ")).toBeNull();
    expect(normalizeCandidate("  A   B \n C  ")).toBe("A B C");
  });

  it("clips at sentence boundary when possible", () => {
    const input = "First sentence. Second sentence. Third sentence.";
    expect(clipAtSentenceBoundary(input, 22)).toBe("First sentence.");
    expect(clipAtSentenceBoundary(input, 3)).toBe("Fir");
    expect(clipAtSentenceBoundary(input, 200)).toBe(input);
  });

  it("keeps clipped content well-formed at a surrogate pair", () => {
    const input = `${"x".repeat(80)}\u{1F600} and more trailing text here`;
    const result = clipAtSentenceBoundary(input, 81);
    expect(result.isWellFormed()).toBe(true);
    expect(result).toBe("x".repeat(80));
    expect(clipAtSentenceBoundary(input, 82)).toBe(`${"x".repeat(80)}\u{1F600}`);
  });

  it("preserves plain BMP truncation", () => {
    expect(clipAtSentenceBoundary("abcdefgh", 5)).toBe("abcde");
  });

  it("applies a content budget and counts words", () => {
    const content = "Hello world. This is a test.";
    const result = applyContentBudget(content, 10);
    expect(result.truncated).toBe(true);
    expect(result.totalCharacters).toBe(content.length);
    expect(result.content.length).toBeLessThanOrEqual(10);
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it("keeps budgeted content well-formed at a surrogate pair", () => {
    const input = `${"x".repeat(80)}\u{1F600} and more trailing text here`;
    expect(applyContentBudget(input, 81).content.isWellFormed()).toBe(true);
  });

  it("keeps content when under budget and reports empty word count", () => {
    const content = "Short line.";
    const result = applyContentBudget(content, 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
    expect(result.wordCount).toBeGreaterThan(0);

    const empty = applyContentBudget("", 10);
    expect(empty.truncated).toBe(false);
    expect(empty.content).toBe("");
    expect(empty.wordCount).toBe(0);
  });
});
