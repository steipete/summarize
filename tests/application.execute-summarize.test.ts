import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { ExecFileFn } from "../src/markitdown.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";

const mocks = vi.hoisted(() => ({
  extractAssetContent: vi.fn(),
  executeAssetSummary: vi.fn(),
  executeUrlFlow: vi.fn(),
}));

vi.mock("../src/run/flows/asset/extract.js", () => ({
  extractAssetContent: mocks.extractAssetContent,
}));
vi.mock("../src/run/flows/asset/summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/flows/asset/summary.js")>()),
  executeAssetSummary: mocks.executeAssetSummary,
}));
vi.mock("../src/run/flows/url/flow.js", () => ({
  executeUrlFlow: mocks.executeUrlFlow,
}));

import { executeSummarize } from "../src/application/execute-summarize.js";

const extracted: ExtractedLinkContent = {
  url: "https://example.com/video",
  title: "Video",
  description: null,
  siteName: "Example",
  content: "placeholder",
  truncated: false,
  totalCharacters: 11,
  wordCount: 1,
  transcriptCharacters: null,
  transcriptLines: null,
  transcriptWordCount: null,
  transcriptSource: null,
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  video: { kind: "direct", url: "https://cdn.example.com/video.mp4" },
  isVideoOnly: true,
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

describe("executeSummarize", () => {
  it("returns delegated asset summaries and emits non-streamed output semantically", async () => {
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      ctx.hooks.onModelChosen?.("google/gemini-2.5-pro");
      ctx.hooks.onSummaryCached?.(false);
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Video summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: "https://cdn.example.com/video.mp4",
            mediaType: "video/mp4",
            filename: "video.mp4",
          },
          footerParts: [],
          llm: {
            provider: "google",
            model: "google/gemini-2.5-pro",
            maxCompletionTokens: null,
            strategy: "single",
          },
        },
      };
    });

    const events: Array<{ type: string; text?: string }> = [];
    const result = await executeSummarize(
      {
        input: {
          kind: "url",
          url: extracted.url,
          title: extracted.title,
          maxCharacters: null,
        },
        modelOverride: "google/gemini-2.5-pro",
        promptOverride: null,
        lengthRaw: "long",
        languageRaw: "auto",
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "run-1",
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      (event) => {
        events.push({
          type: event.type,
          ...(event.type === "summary-delta" ? { text: event.text } : {}),
        });
      },
    );

    expect(result).toMatchObject({
      kind: "summary",
      summary: "Video summary.",
      usedModel: "google/gemini-2.5-pro",
      summaryFromCache: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "extraction-started",
      "content-extracted",
      "summary-started",
      "model-selected",
      "summary-cache",
      "summary-delta",
      "run-completed",
    ]);
    expect(events).toContainEqual({ type: "summary-delta", text: "Video summary.\n" });
  });

  it("executes with prepared resources while retaining adapter event hooks", async () => {
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      ctx.hooks.onModelChosen?.("google/gemini-2.5-pro");
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Prepared summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: "https://cdn.example.com/video.mp4",
            mediaType: "video/mp4",
            filename: "video.mp4",
          },
          footerParts: [],
          llm: {
            provider: "google",
            model: "google/gemini-2.5-pro",
            maxCompletionTokens: null,
            strategy: "single",
          },
        },
      };
    });

    const adapterModel = vi.fn();
    const preparedContext = {
      model: { requestedModelLabel: "prepared/model" },
      hooks: {
        onModelChosen: adapterModel,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onSlidesDone: null,
        onSlideChunk: undefined,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        summarizeAsset: vi.fn(),
        buildReport: vi.fn(async () => ({
          llm: [],
          services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
        })),
        estimateCostUsd: vi.fn(async () => null),
      },
    } as unknown as UrlFlowContext;
    const eventTypes: string[] = [];

    const result = await executeSummarize(
      {
        input: {
          kind: "url",
          url: extracted.url,
          title: extracted.title,
          maxCharacters: null,
        },
        modelOverride: "google/gemini-2.5-pro",
        promptOverride: null,
        lengthRaw: "long",
        languageRaw: "auto",
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "run-prepared",
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      (event) => eventTypes.push(event.type),
      { urlFlowContext: preparedContext },
    );

    expect(result).toMatchObject({
      kind: "summary",
      summary: "Prepared summary.",
      usedModel: "google/gemini-2.5-pro",
    });
    expect(adapterModel).toHaveBeenCalledWith("google/gemini-2.5-pro");
    expect(eventTypes).toContain("model-selected");
    expect(eventTypes.at(-1)).toBe("run-completed");
  });

  it("executes resolved assets with byte-free results and semantic events", async () => {
    mocks.executeAssetSummary.mockImplementationOnce(async (ctx, args) => {
      ctx.onSummaryCached?.(true);
      args.onModelChosen?.("openai/gpt-5.4");
      return {
        kind: "summary",
        outcome: "model",
        summary: "Asset summary.",
        summaryEmitted: false,
        summaryFromCache: true,
        prompt: "Prompt",
        extracted: {
          kind: "asset",
          source: args.sourceLabel,
          mediaType: args.attachment.mediaType,
          filename: args.attachment.filename,
        },
        footerParts: [],
        llm: {
          provider: "openai",
          model: "openai/gpt-5.4",
          maxCompletionTokens: 256,
          strategy: "single",
        },
      };
    });
    const assetSummaryContext = {
      onSummaryCached: null,
      buildReport: vi.fn(async () => ({
        llm: [],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      })),
      estimateCostUsd: vi.fn(async () => 0.01),
    };
    const preparedContext = {
      model: { requestedModelLabel: "openai/gpt-5.4" },
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onSlidesDone: null,
        onSlideChunk: undefined,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        summarizeAsset: vi.fn(),
      },
    } as unknown as UrlFlowContext;
    const attachment = {
      kind: "file" as const,
      mediaType: "text/plain",
      filename: "notes.txt",
      bytes: new TextEncoder().encode("Notes"),
    };
    const events: Array<{ type: string; text?: string }> = [];

    const result = await executeSummarize(
      {
        input: {
          kind: "resolved-asset",
          sourceKind: "file",
          sourceLabel: "/tmp/notes.txt",
          attachment,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: "long",
        languageRaw: "auto",
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "asset-run",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
        now: () => 100,
      },
      (event) => {
        events.push({
          type: event.type,
          ...(event.type === "summary-delta" ? { text: event.text } : {}),
        });
      },
      {
        urlFlowContext: preparedContext,
        assetSummaryContext: assetSummaryContext as never,
      },
    );

    expect(result).toMatchObject({
      kind: "asset-summary",
      input: {
        kind: "asset",
        sourceKind: "file",
        source: "/tmp/notes.txt",
        mediaType: "text/plain",
        filename: "notes.txt",
      },
      summary: "Asset summary.",
      usedModel: "openai/gpt-5.4",
      summaryFromCache: true,
      costUsd: 0.01,
    });
    expect(result.input).not.toHaveProperty("attachment");
    expect(events).toEqual([
      { type: "run-started" },
      { type: "summary-started" },
      { type: "summary-cache" },
      { type: "model-selected" },
      { type: "summary-delta", text: "Asset summary.\n" },
      { type: "run-completed" },
    ]);
  });

  it("extracts resolved assets with byte-free event and result metadata", async () => {
    mocks.extractAssetContent.mockResolvedValueOnce({
      content: "Extracted asset",
      diagnostics: {
        strategy: "html",
        firecrawl: { used: false },
        markdown: { used: false, provider: null },
        transcript: { textProvided: false, provider: null },
      },
    });
    const buildReport = vi.fn(async () => ({
      llm: [],
      services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
    }));
    const estimateCostUsd = vi.fn(async () => 0.02);
    const assetSummaryContext = {
      env: {},
      envForRun: {},
      execFileImpl: execFile,
      timeoutMs: 5_000,
      preprocessMode: "auto",
      shouldComputeReport: true,
      metricsEnabled: true,
      buildReport,
      estimateCostUsd,
      onSummaryCached: null,
    };
    const preparedContext = {
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onSlidesDone: null,
        onSlideChunk: undefined,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        summarizeAsset: vi.fn(),
      },
    } as unknown as UrlFlowContext;
    const attachment = {
      kind: "file" as const,
      mediaType: "application/pdf",
      filename: "notes.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    };
    const events: Array<{ type: string; input?: unknown }> = [];

    const result = await executeSummarize(
      {
        input: {
          kind: "resolved-asset",
          sourceKind: "asset-url",
          sourceLabel: "https://example.com/notes.pdf",
          attachment,
        },
        modelOverride: null,
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: true,
        slides: null,
      },
      {
        runId: "asset-extract",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
        now: () => 142,
      },
      (event) => {
        events.push({
          type: event.type,
          ...(event.type === "run-started" ? { input: event.input } : {}),
        });
      },
      {
        urlFlowContext: preparedContext,
        assetSummaryContext: assetSummaryContext as never,
      },
    );

    expect(mocks.extractAssetContent).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        timeoutMs: 5_000,
        preprocessMode: "auto",
      }),
      attachment,
    });
    expect(result).toEqual({
      kind: "asset-extraction",
      input: {
        kind: "asset",
        sourceKind: "asset-url",
        source: "https://example.com/notes.pdf",
        mediaType: "application/pdf",
        filename: "notes.pdf",
      },
      extracted: {
        content: "Extracted asset",
        diagnostics: {
          strategy: "html",
          firecrawl: { used: false },
          markdown: { used: false, provider: null },
          transcript: { textProvided: false, provider: null },
        },
      },
      elapsedMs: 0,
      report: {
        llm: [],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      },
      costUsd: 0.02,
    });
    expect(events[0]).toEqual({
      type: "run-started",
      input: {
        kind: "resolved-asset",
        sourceKind: "asset-url",
        sourceLabel: "https://example.com/notes.pdf",
        mediaType: "application/pdf",
        filename: "notes.pdf",
      },
    });
    expect(events[0]?.input).not.toHaveProperty("attachment");
    expect(events.at(-1)?.type).toBe("run-completed");
  });
});
