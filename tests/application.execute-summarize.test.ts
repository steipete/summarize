import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AssetLikeHtmlFetchError } from "../packages/core/src/content/index.js";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { ExecFileFn } from "../src/markitdown.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";

const mocks = vi.hoisted(() => ({
  extractAssetContent: vi.fn(),
  executeAssetSummary: vi.fn(),
  executeMediaFile: vi.fn(),
  executeUrlFlow: vi.fn(),
}));

vi.mock("../src/run/flows/asset/extract.js", () => ({
  extractAssetContent: mocks.extractAssetContent,
}));
vi.mock("../src/run/flows/asset/summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/flows/asset/summary.js")>()),
  executeAssetSummary: mocks.executeAssetSummary,
}));
vi.mock("../src/run/flows/asset/media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/flows/asset/media.js")>()),
  executeMediaFile: mocks.executeMediaFile,
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

function createPreparedInputResources({
  fetchImpl,
  firecrawlConfigured = false,
}: {
  fetchImpl: typeof fetch;
  firecrawlConfigured?: boolean;
}) {
  const report = {
    llm: [],
    services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
  };
  return {
    urlFlowContext: {
      io: { fetch: fetchImpl },
      flags: {
        timeoutMs: 1_000,
        firecrawlMode: "auto",
        throwOnAssetLikeHtmlError: true,
      },
      model: {
        requestedModelLabel: "openai/gpt-5.4",
        apiStatus: { firecrawlConfigured },
      },
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
        buildReport: vi.fn(async () => report),
        estimateCostUsd: vi.fn(async () => null),
      },
    } as unknown as UrlFlowContext,
    assetSummaryContext: {
      onSummaryCached: null,
      buildReport: vi.fn(async () => report),
      estimateCostUsd: vi.fn(async () => null),
    } as never,
  };
}

function mockAssetSummary(summary: string) {
  mocks.executeAssetSummary.mockImplementationOnce(async (_ctx, args) => ({
    kind: "summary",
    outcome: "model",
    summary,
    summaryEmitted: false,
    summaryFromCache: false,
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
  }));
}

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
      details: {
        kind: "delegated-asset",
        summaryEmitted: false,
        summary: {
          summary: "Video summary.",
          extracted: {
            source: "https://cdn.example.com/video.mp4",
            mediaType: "video/mp4",
            filename: "video.mp4",
          },
        },
      },
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

  it("acquires and executes raw local files inside the application boundary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "summarize-raw-file-"));
    const filePath = path.join(dir, "notes.txt");
    await writeFile(filePath, "Raw file content");
    let executionFormat: string | null = null;
    mocks.executeAssetSummary.mockImplementationOnce(async (ctx, args) => {
      executionFormat = ctx.format;
      return {
        kind: "summary",
        outcome: "short-content",
        summary: new TextDecoder().decode(args.attachment.bytes),
        summaryEmitted: false,
        summaryFromCache: false,
        prompt: "Prompt",
        extracted: {
          kind: "asset",
          source: args.sourceLabel,
          mediaType: args.attachment.mediaType,
          filename: args.attachment.filename,
        },
        footerParts: [],
        llm: null,
      };
    });
    const events: Array<{ type: string; phase?: string; input?: unknown }> = [];

    try {
      const result = await executeSummarize(
        {
          input: { kind: "file", filePath },
          modelOverride: "openai/gpt-5.4",
          promptOverride: null,
          lengthRaw: null,
          languageRaw: null,
          format: "markdown",
          overrides: createEmptyRunOverrides(),
          extractOnly: false,
          slides: null,
        },
        {
          runId: "raw-file",
          env: { OPENAI_API_KEY: "test-key" },
          fetch: globalThis.fetch,
          execFile: execFile as unknown as ExecFileFn,
          cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
          mediaCache: null,
        },
        (event) => {
          events.push({
            type: event.type,
            ...(event.type === "run-started" ? { input: event.input } : {}),
            ...(event.type === "input-progress" ? { phase: event.phase } : {}),
          });
        },
      );

      expect(result).toMatchObject({
        kind: "asset-summary",
        input: {
          sourceKind: "file",
          source: filePath,
          mediaType: "text/plain",
          filename: "notes.txt",
        },
        summary: "Raw file content",
      });
      expect(executionFormat).toBe("markdown");
      expect(events.slice(0, 3)).toEqual([
        { type: "run-started", input: { kind: "file", filePath } },
        { type: "input-progress", phase: "loading" },
        { type: "input-progress", phase: "summarizing" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("owns stdin temp-file cleanup through raw application execution", async () => {
    let acquiredPath: string | null = null;
    mocks.executeAssetSummary.mockImplementationOnce(async (_ctx, args) => {
      acquiredPath = args.sourceLabel;
      return {
        kind: "summary",
        outcome: "short-content",
        summary: new TextDecoder().decode(args.attachment.bytes),
        summaryEmitted: false,
        summaryFromCache: false,
        prompt: "Prompt",
        extracted: {
          kind: "asset",
          source: args.sourceLabel,
          mediaType: args.attachment.mediaType,
          filename: args.attachment.filename,
        },
        footerParts: [],
        llm: null,
      };
    });
    const assetSummaryContext = {
      onSummaryCached: null,
      buildReport: vi.fn(async () => ({
        llm: [],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      })),
      estimateCostUsd: vi.fn(async () => null),
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
    const events: Array<{ type: string; input?: unknown }> = [];

    const result = await executeSummarize(
      {
        input: { kind: "stdin" },
        modelOverride: null,
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "raw-stdin",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
        stdin: Readable.from(["stdin content"]),
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

    expect(result).toMatchObject({ kind: "asset-summary", summary: "stdin content" });
    expect(events[0]).toEqual({ type: "run-started", input: { kind: "stdin" } });
    expect(acquiredPath).toMatch(/summarize-stdin-/);
    await expect(access(acquiredPath ?? "")).rejects.toThrow();
  });

  it("acquires known asset URLs before website execution", async () => {
    mocks.executeUrlFlow.mockClear();
    let executionFormat: string | null = null;
    mocks.executeAssetSummary.mockImplementationOnce(async (ctx, args) => {
      executionFormat = ctx.format;
      return {
        kind: "summary",
        outcome: "model",
        summary: "Remote asset summary.",
        summaryEmitted: false,
        summaryFromCache: false,
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

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/report.pdf",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "markdown",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "raw-url-asset",
        env: { OPENAI_API_KEY: "test-key" },
        fetch: async () =>
          new Response("%PDF-1.4\n", {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
    );

    expect(result).toMatchObject({
      kind: "asset-summary",
      summary: "Remote asset summary.",
      input: {
        sourceKind: "asset-url",
        source: "https://example.com/report.pdf",
        mediaType: "application/pdf",
      },
    });
    expect(executionFormat).toBe("markdown");
    expect(mocks.executeUrlFlow).not.toHaveBeenCalled();
  });

  it("routes header-detected remote media through transcription", async () => {
    mocks.executeAssetSummary.mockClear();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "HEAD") {
        throw new Error("media body should not be downloaded during input acquisition");
      }
      return new Response(null, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="episode.mp3"',
          "content-length": String(500 * 1024 * 1024),
          "content-type": "audio/mpeg",
        },
      });
    }) as typeof fetch;
    mocks.executeMediaFile.mockImplementationOnce(async (_ctx, args) => ({
      kind: "extraction",
      extracted: {
        ...extracted,
        url: args.sourceLabel,
        title: args.attachment.filename,
      },
    }));

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/download?id=audio",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: true,
        slides: null,
      },
      {
        runId: "raw-url-media",
        env: { OPENAI_API_KEY: "test-key" },
        fetch: fetchImpl,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
    );

    expect(result).toMatchObject({
      kind: "asset-media",
      input: {
        sourceKind: "asset-url",
        source: "https://example.com/download?id=audio",
        mediaType: "audio/mpeg",
        filename: "download",
      },
      details: { kind: "extraction" },
    });
    expect(mocks.executeMediaFile).toHaveBeenCalledOnce();
    expect(mocks.executeAssetSummary).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps direct media URLs in the URL flow when slides are requested", async () => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Slides media summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: extracted.url,
            mediaType: "text/plain",
            filename: null,
          },
          footerParts: [],
          llm: {
            provider: "openai",
            model: "openai/gpt-5.4",
            maxCompletionTokens: 256,
            strategy: "single",
          },
        },
      };
    });

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/video.mp4",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: {
          enabled: true,
          ocr: false,
          outputDir: "/tmp/slides",
          sceneThreshold: 0.3,
          autoTuneThreshold: true,
          maxSlides: 6,
          minDurationSeconds: 2,
        },
      },
      {
        runId: "raw-url-media-slides",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      undefined,
      createPreparedInputResources({ fetchImpl: globalThis.fetch }),
    );

    expect(result).toMatchObject({ kind: "summary", summary: "Slides media summary." });
    expect(mocks.executeUrlFlow).toHaveBeenCalledOnce();
  });

  it("keeps header-detected video URLs in the URL flow when slides are requested", async () => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Header video summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: extracted.url,
            mediaType: "text/plain",
            filename: null,
          },
          footerParts: [],
          llm: {
            provider: "openai",
            model: "openai/gpt-5.4",
            maxCompletionTokens: 256,
            strategy: "single",
          },
        },
      };
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "HEAD") throw new Error("video body should not be downloaded");
      return new Response(null, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as typeof fetch;

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/download?id=video",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: {
          enabled: true,
          ocr: false,
          outputDir: "/tmp/slides",
          sceneThreshold: 0.3,
          autoTuneThreshold: true,
          maxSlides: 6,
          minDurationSeconds: 2,
        },
      },
      {
        runId: "raw-header-video-slides",
        env: {},
        fetch: fetchImpl,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      undefined,
      createPreparedInputResources({ fetchImpl }),
    );

    expect(result).toMatchObject({ kind: "summary", summary: "Header video summary." });
    expect(mocks.executeUrlFlow).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "local audio",
      input: { kind: "file" as const, filePath: "/tmp/episode.mp3" },
    },
    {
      label: "remote audio",
      input: {
        kind: "input-url" as const,
        url: "https://example.com/episode.mp3",
        title: null,
        maxCharacters: null,
      },
    },
  ])("keeps $label on media execution when slides are requested", async ({ input }) => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeMediaFile.mockClear();
    mocks.executeMediaFile.mockImplementationOnce(async () => ({
      kind: "extraction",
      extracted,
    }));

    const result = await executeSummarize(
      {
        input,
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: true,
        slides: {
          enabled: true,
          ocr: false,
          outputDir: "/tmp/slides",
          sceneThreshold: 0.3,
          autoTuneThreshold: true,
          maxSlides: 6,
          minDurationSeconds: 2,
        },
      },
      {
        runId: "raw-audio-slides",
        env: { OPENAI_API_KEY: "test-key" },
        fetch: async () => {
          throw new Error("audio body should not be fetched");
        },
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
    );

    expect(result.kind).toBe("asset-media");
    expect(mocks.executeMediaFile).toHaveBeenCalledOnce();
    expect(mocks.executeUrlFlow).not.toHaveBeenCalled();
  });

  it("recovers asset-like website failures through remote acquisition", async () => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeUrlFlow.mockRejectedValueOnce(
      new AssetLikeHtmlFetchError("content-type", "application/pdf"),
    );
    mockAssetSummary("Recovered asset summary.");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD" || new Headers(init?.headers).has("range")) {
        return new Response(null, { status: 503 });
      }
      return new Response("%PDF-1.4\n", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }) as typeof fetch;
    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/article?id=123",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "raw-url-recovery",
        env: { OPENAI_API_KEY: "test-key" },
        fetch: fetchImpl,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
    );

    expect(result).toMatchObject({
      kind: "asset-summary",
      summary: "Recovered asset summary.",
    });
    expect(mocks.executeUrlFlow).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("materializes fallback video downloads for slide extraction", async () => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeMediaFile.mockClear();
    let materializedPath: string | null = null;
    mocks.executeUrlFlow
      .mockRejectedValueOnce(new AssetLikeHtmlFetchError("content-type", "video/mp4"))
      .mockImplementationOnce(async ({ ctx, url }) => {
        materializedPath = fileURLToPath(url);
        expect(path.extname(materializedPath)).toBe(".mp4");
        await expect(access(materializedPath)).resolves.toBeUndefined();
        ctx.hooks.onExtracted?.(extracted);
        return {
          kind: "delegated-summary",
          extracted,
          slides: null,
          summary: {
            kind: "summary",
            outcome: "model",
            summary: "Recovered video summary.",
            summaryEmitted: false,
            summaryFromCache: false,
            prompt: "Prompt",
            extracted: {
              kind: "asset",
              source: url,
              mediaType: "video/mp4",
              filename: path.basename(materializedPath),
            },
            footerParts: [],
            llm: {
              provider: "openai",
              model: "openai/gpt-5.4",
              maxCompletionTokens: 256,
              strategy: "single",
            },
          },
        };
      });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD" || new Headers(init?.headers).has("range")) {
        return new Response(null, { status: 503 });
      }
      return new Response("video", {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as typeof fetch;

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/download?id=video",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: {
          enabled: true,
          ocr: false,
          outputDir: "/tmp/slides",
          sceneThreshold: 0.3,
          autoTuneThreshold: true,
          maxSlides: 6,
          minDurationSeconds: 2,
        },
      },
      {
        runId: "raw-url-video-recovery",
        env: { OPENAI_API_KEY: "test-key" },
        fetch: fetchImpl,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
    );

    expect(result).toMatchObject({ kind: "summary", summary: "Recovered video summary." });
    expect(mocks.executeUrlFlow).toHaveBeenCalledTimes(2);
    expect(mocks.executeMediaFile).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await expect(access(materializedPath ?? "")).rejects.toThrow();
  });

  it("retries website execution with Firecrawl after an asset acquisition miss", async () => {
    mocks.executeUrlFlow.mockReset();
    mocks.executeUrlFlow
      .mockRejectedValueOnce(new AssetLikeHtmlFetchError("binary-payload"))
      .mockImplementationOnce(async ({ ctx }) => {
        ctx.hooks.onExtracted?.(extracted);
        return {
          kind: "delegated-summary",
          extracted,
          slides: null,
          summary: {
            kind: "summary",
            outcome: "model",
            summary: "Firecrawl summary.",
            summaryEmitted: false,
            summaryFromCache: false,
            prompt: "Prompt",
            extracted: {
              kind: "asset",
              source: extracted.url,
              mediaType: "text/plain",
              filename: null,
            },
            footerParts: [],
            llm: {
              provider: "openai",
              model: "openai/gpt-5.4",
              maxCompletionTokens: 256,
              strategy: "single",
            },
          },
        };
      });
    const prepared = createPreparedInputResources({
      firecrawlConfigured: true,
      fetchImpl: async () =>
        new Response("<html><body>website</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    const result = await executeSummarize(
      {
        input: {
          kind: "input-url",
          url: "https://example.com/download",
          title: null,
          maxCharacters: null,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "raw-url-firecrawl",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      undefined,
      prepared,
    );

    expect(result).toMatchObject({ kind: "summary", summary: "Firecrawl summary." });
    expect(mocks.executeUrlFlow).toHaveBeenCalledTimes(2);
    expect(mocks.executeUrlFlow.mock.calls[1]?.[0]).toMatchObject({
      ctx: { flags: { throwOnAssetLikeHtmlError: false } },
    });
  });

  it("executes resolved media with byte-free result metadata", async () => {
    mocks.executeMediaFile.mockImplementationOnce(async (_ctx, args) => {
      args.onModelChosen?.("openai/gpt-5.4");
      return {
        kind: "summary",
        extracted,
        summaryArgs: {
          sourceKind: "file",
          sourceLabel: `${args.sourceLabel} (transcript)`,
          attachment: {
            kind: "file",
            mediaType: "text/plain",
            filename: "audio.mp3.transcript.txt",
          },
        },
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Media summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: `${args.sourceLabel} (transcript)`,
            mediaType: "text/plain",
            filename: "audio.mp3.transcript.txt",
          },
          footerParts: [],
          llm: {
            provider: "openai",
            model: "openai/gpt-5.4",
            maxCompletionTokens: 256,
            strategy: "single",
          },
        },
      };
    });
    const assetSummaryContext = {
      onSummaryCached: null,
      buildReport: vi.fn(async () => ({
        llm: [],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      })),
      estimateCostUsd: vi.fn(async () => 0.03),
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
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      bytes: new Uint8Array(),
    };
    const events: Array<{ type: string; input?: unknown; text?: string }> = [];

    const result = await executeSummarize(
      {
        input: {
          kind: "resolved-media",
          sourceKind: "file",
          sourceLabel: "/tmp/audio.mp3",
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
        runId: "media-run",
        env: {},
        fetch: globalThis.fetch,
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
        now: () => 200,
      },
      (event) => {
        events.push({
          type: event.type,
          ...(event.type === "run-started" ? { input: event.input } : {}),
          ...(event.type === "summary-delta" ? { text: event.text } : {}),
        });
      },
      {
        urlFlowContext: preparedContext,
        assetSummaryContext: assetSummaryContext as never,
      },
    );

    expect(result).toMatchObject({
      kind: "asset-media",
      input: {
        kind: "asset",
        sourceKind: "file",
        source: "/tmp/audio.mp3",
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
      },
      usedModel: "openai/gpt-5.4",
      summaryFromCache: false,
      costUsd: 0.03,
      details: {
        kind: "summary",
        summaryArgs: {
          attachment: {
            kind: "file",
            mediaType: "text/plain",
            filename: "audio.mp3.transcript.txt",
          },
        },
      },
    });
    expect(result.input).not.toHaveProperty("attachment");
    if (result.kind !== "asset-media" || result.details.kind !== "summary") {
      throw new Error("Expected media summary result");
    }
    expect(result.details.summaryArgs.attachment).not.toHaveProperty("bytes");
    expect(events[0]?.input).not.toHaveProperty("attachment");
    expect(events).toContainEqual({ type: "summary-delta", text: "Media summary.\n" });
    expect(events.at(-1)?.type).toBe("run-completed");
  });
});
