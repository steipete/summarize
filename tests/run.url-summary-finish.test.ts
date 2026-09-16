import { describe, expect, it } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { ModelAttempt } from "../src/engine/types.js";
import {
  buildFinishExtras,
  buildModelMetaFromAttempt,
  pickModelForFinishLine,
} from "../src/run/flows/url/summary-finish.js";

const baseExtracted: ExtractedLinkContent = {
  url: "https://example.com",
  title: "Example",
  description: null,
  siteName: "Example",
  content: "Hello world",
  truncated: false,
  totalCharacters: 11,
  wordCount: 2,
  transcriptCharacters: null,
  transcriptLines: null,
  transcriptWordCount: null,
  transcriptSource: null,
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  video: null,
  isVideoOnly: false,
  diagnostics: {
    strategy: "html",
    firecrawl: { attempted: false, used: false, cacheMode: "bypass", cacheStatus: "unknown" },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: "bypass",
      cacheStatus: "unknown",
      textProvided: false,
      provider: null,
      attemptedProviders: [],
    },
  },
};

const baseAttempt: ModelAttempt = {
  transport: "native",
  userModelId: "openai/gpt-5.2",
  llmModelId: "openai/gpt-5.2",
  openrouterProviders: null,
  forceOpenRouter: false,
  requiredEnv: "OPENAI_API_KEY",
};

describe("summary finish helpers", () => {
  it("returns null extras when no transcript or transcription cost is present", () => {
    expect(
      buildFinishExtras({
        extracted: baseExtracted,
        metricsDetailed: false,
        transcriptionCostLabel: null,
      }),
    ).toBeNull();
  });

  it("includes transcript summary and transcription cost when present", () => {
    const extracted: ExtractedLinkContent = {
      ...baseExtracted,
      siteName: "YouTube",
      transcriptCharacters: 1_200,
      transcriptWordCount: 200,
      mediaDurationSeconds: 75,
      video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abc123" },
    };

    expect(
      buildFinishExtras({
        extracted,
        metricsDetailed: true,
        transcriptionCostLabel: "$0.02 tx",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "compactTranscript", durationSeconds: 75, words: 200 }),
        expect.objectContaining({
          kind: "length",
          key: "finish.transcriptLength",
          values: { durationSeconds: 75, words: 200, chars: 1200, approximate: false },
        }),
        "$0.02 tx",
      ]),
    );
  });

  it("prefers the latest summary model", () => {
    expect(
      pickModelForFinishLine(
        [
          { purpose: "summary", model: "openai/gpt-4.1" },
          { purpose: "markdown", model: "openai/gpt-4.1-mini" },
          { purpose: "summary", model: "openai/gpt-5.2" },
        ],
        "fallback/model",
      ),
    ).toBe("openai/gpt-5.2");
  });

  it("falls back to markdown, then last call, then explicit fallback", () => {
    expect(
      pickModelForFinishLine(
        [
          { purpose: "extract", model: "openai/gpt-4.1-mini" },
          { purpose: "markdown", model: "openai/gpt-5.2-mini" },
        ],
        "fallback/model",
      ),
    ).toBe("openai/gpt-5.2-mini");

    expect(
      pickModelForFinishLine(
        [{ purpose: "extract", model: "openai/gpt-4.1-mini" }],
        "fallback/model",
      ),
    ).toBe("openai/gpt-4.1-mini");

    expect(pickModelForFinishLine([], "fallback/model")).toBe("fallback/model");
  });

  it("returns cli metadata for cli attempts", () => {
    expect(
      buildModelMetaFromAttempt({
        ...baseAttempt,
        transport: "cli",
        userModelId: "claude-sonnet-4.5",
        llmModelId: null,
        requiredEnv: "CLI_CLAUDE",
      }),
    ).toEqual({ provider: "cli", canonical: "claude-sonnet-4.5" });
  });

  it("preserves explicit openrouter ids for native attempts", () => {
    expect(
      buildModelMetaFromAttempt({
        ...baseAttempt,
        userModelId: "openrouter/anthropic/claude-sonnet-4.5",
        llmModelId: "anthropic/claude-sonnet-4.5",
      }),
    ).toEqual({
      provider: "anthropic",
      canonical: "openrouter/anthropic/claude-sonnet-4.5",
    });
  });

  it("falls back to the parsed canonical model id for native attempts", () => {
    expect(
      buildModelMetaFromAttempt({
        ...baseAttempt,
        userModelId: "gpt-5.2",
        llmModelId: null,
      }),
    ).toEqual({
      provider: "openai",
      canonical: "openai/gpt-5.2",
    });
  });
});
