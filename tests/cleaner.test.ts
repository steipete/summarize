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

  it("decodes each entity once, so an escaped entity stays escaped", () => {
    expect(decodeHtmlEntities("&amp;lt;div&amp;gt;")).toBe("&lt;div&gt;");
    expect(decodeHtmlEntities("&amp;quot;x&amp;quot;")).toBe("&quot;x&quot;");
    expect(decodeHtmlEntities("&amp;nbsp;")).toBe("&nbsp;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&copy; &unknown; 5 &lt; 6")).toBe("&copy; &unknown; 5 < 6");
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

  it("applies a content budget and counts words", () => {
    const content = "Hello world. This is a test.";
    const result = applyContentBudget(content, 10);
    expect(result.truncated).toBe(true);
    expect(result.totalCharacters).toBe(content.length);
    expect(result.content.length).toBeLessThanOrEqual(10);
    expect(result.wordCount).toBeGreaterThan(0);
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
