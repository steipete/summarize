import { describe, expect, it } from "vitest";
import {
  buildExtractCacheKey,
  buildPromptContentHash,
  buildPromptHash,
  buildSummaryCacheKey,
  extractTaggedBlock,
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
