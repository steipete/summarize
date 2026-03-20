import { describe, expect, it } from "vitest";
import {
  buildExtractCacheKey,
  buildPromptContentHash,
  buildPromptHash,
  buildSummaryCacheKey,
  extractTaggedBlock,
  hashString,
} from "../src/cache.js";

describe("cache keys and tags", () => {
  it("extracts tagged blocks", () => {
    const prompt = "<instructions>Do the thing.</instructions>\n<content>Body</content>";
    expect(extractTaggedBlock(prompt, "instructions")).toBe("Do the thing.");
    expect(extractTaggedBlock(prompt, "content")).toBe("Body");
    expect(extractTaggedBlock(prompt, "context")).toBeNull();
    expect(extractTaggedBlock("<context>Site</context>", "context")).toBe("Site");
    expect(extractTaggedBlock("no tags here", "instructions")).toBeNull();
  });

  it("changes prompt hashes when context changes", () => {
    const instructions = "Summarize it.";
    const contextA = "URL: https://a.com";
    const contextB = "URL: https://b.com";
    const prompt1 = `<instructions>${instructions}</instructions>\n<context>${contextA}</context>\n<content></content>`;
    const prompt2 = `<instructions>${instructions}</instructions>\n<context>${contextB}</context>\n<content></content>`;

    const hash1 = buildPromptHash(prompt1);
    const hash2 = buildPromptHash(prompt2);

    expect(hash1).not.toBe(hash2);
  });

  it("hashes instructions-only prompt consistently", () => {
    const promptWithEmptyContext = "<instructions>Summarize.</instructions>\n<context></context>\n<content>Body</content>";
    const promptWithNoContextTag = "<instructions>Summarize.</instructions>\n<content>Body</content>";

    const hash1 = buildPromptHash(promptWithEmptyContext);
    const hash2 = buildPromptHash(promptWithNoContextTag);

    // Both should hash just the instructions since context is empty/missing
    expect(hash1).toBe(hash2);
  });

  it("treats multiple empty tags consistently", () => {
    const p1 = "<instructions></instructions>";
    const p2 = "<context></context>";
    const p3 = "<instructions></instructions><context></context>";
    const p4 = "<instructions>  </instructions>";

    const h1 = buildPromptHash(p1);
    const h2 = buildPromptHash(p2);
    const h3 = buildPromptHash(p3);
    const h4 = buildPromptHash(p4);

    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h3).toBe(h4);
    // They should all hash to an empty string's hash (after trim)
    expect(h1).toBe(hashString(""));
  });

  it("changes summary keys when inputs change", () => {
    const base = buildSummaryCacheKey({
      contentHash: "content",
      promptHash: "prompt",
      model: "openai/gpt-5.2",
      lengthKey: "chars:140",
      languageKey: "en",
    });
    const same = buildSummaryCacheKey({
      contentHash: "content",
      promptHash: "prompt",
      model: "openai/gpt-5.2",
      lengthKey: "chars:140",
      languageKey: "en",
    });
    const diffModel = buildSummaryCacheKey({
      contentHash: "content",
      promptHash: "prompt",
      model: "openai/gpt-4.1",
      lengthKey: "chars:140",
      languageKey: "en",
    });
    const diffLength = buildSummaryCacheKey({
      contentHash: "content",
      promptHash: "prompt",
      model: "openai/gpt-5.2",
      lengthKey: "chars:200",
      languageKey: "en",
    });
    const diffLang = buildSummaryCacheKey({
      contentHash: "content",
      promptHash: "prompt",
      model: "openai/gpt-5.2",
      lengthKey: "chars:140",
      languageKey: "de",
    });

    expect(same).toBe(base);
    expect(diffModel).not.toBe(base);
    expect(diffLength).not.toBe(base);
    expect(diffLang).not.toBe(base);
  });

  it("changes extract keys when transcript timestamp options change", () => {
    const base = buildExtractCacheKey({
      url: "https://example.com/video",
      options: { youtubeTranscript: "auto", transcriptTimestamps: false },
    });
    const withTimestamps = buildExtractCacheKey({
      url: "https://example.com/video",
      options: { youtubeTranscript: "auto", transcriptTimestamps: true },
    });

    expect(withTimestamps).not.toBe(base);
  });

  it("hashes the prompt content block instead of a fallback body", () => {
    const base = buildPromptContentHash({
      prompt: "<instructions>Do it.</instructions><content>Body</content>",
      fallbackContent: "fallback",
    });
    const withSlides = buildPromptContentHash({
      prompt:
        "<instructions>Do it.</instructions><content>Body\n\nSlide timeline:\n[slide:1] hello</content>",
      fallbackContent: "fallback",
    });

    expect(base).not.toBeNull();
    expect(withSlides).not.toBeNull();
    expect(withSlides).not.toBe(base);
  });
});
