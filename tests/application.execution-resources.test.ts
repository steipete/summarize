import { describe, expect, it } from "vitest";
import {
  createSummarizeFlowFlags,
  type SummarizeFlowOptions,
} from "../src/application/execution-resources.js";
import type { ResolvedSummarizeSpec } from "../src/application/run-spec.js";

const spec: ResolvedSummarizeSpec = {
  format: "markdown",
  maxExtractCharacters: 12_000,
  timeoutMs: 30_000,
  retries: 2,
  markdownMode: "readability",
  preprocessMode: "auto",
  youtubeMode: "yt-dlp",
  firecrawlMode: "auto",
  videoMode: "transcript",
  embeddedVideoMode: "prefer",
  transcriptTimestamps: true,
  transcriptDiarization: "openai",
  outputLanguage: { kind: "fixed", code: "fr", label: "French" },
  lengthArg: { kind: "preset", preset: "medium" },
  forceSummary: true,
  promptOverride: "Prompt",
  lengthInstruction: "Length",
  languageInstruction: "Language",
  maxOutputTokensArg: 512,
  allowAutoCliFallback: false,
  model: {
    requestedModelInput: "openai/gpt-5.4",
    requestedModelLabel: "openai/gpt-5.4",
    requestedModel: {
      kind: "fixed",
      provider: "openai",
      modelId: "gpt-5.4",
      userModelId: "openai/gpt-5.4",
    },
    fixedModelSpec: {
      kind: "fixed",
      provider: "openai",
      modelId: "gpt-5.4",
      userModelId: "openai/gpt-5.4",
    },
    isFallbackModel: false,
    isImplicitAutoSelection: false,
    wantsFreeNamedModel: false,
    isNamedModelSelection: true,
    desiredOutputTokens: 512,
  },
  configPath: "/tmp/config.json",
  configModelLabel: "openai/gpt-5.4",
};

const baseFlow: SummarizeFlowOptions = {
  runStartedAtMs: 123,
  streamingEnabled: true,
  extractMode: false,
};

describe("summarize flow flags", () => {
  it("inherits execution policy from the resolved run", () => {
    expect(createSummarizeFlowFlags(spec, baseFlow)).toMatchObject({
      timeoutMs: 30_000,
      maxExtractCharacters: 12_000,
      format: "markdown",
      transcriptTimestamps: true,
      transcriptDiarization: "openai",
      promptOverride: "Prompt",
      streamMode: "on",
      plain: true,
      configPath: "/tmp/config.json",
    });
  });

  it("preserves explicit adapter overrides, including null extraction limits", () => {
    expect(
      createSummarizeFlowFlags(spec, {
        ...baseFlow,
        maxExtractCharacters: null,
        transcriptTimestamps: false,
        summaryCacheBypass: true,
        json: true,
        metricsEnabled: true,
        streamMode: "off",
        plain: false,
        slidesOutput: true,
        throwOnAssetLikeHtmlError: true,
      }),
    ).toMatchObject({
      maxExtractCharacters: null,
      transcriptTimestamps: false,
      summaryCacheBypass: true,
      json: true,
      metricsEnabled: true,
      streamMode: "off",
      plain: false,
      slidesOutput: true,
      throwOnAssetLikeHtmlError: true,
    });
  });
});
