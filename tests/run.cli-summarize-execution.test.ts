import { describe, expect, it, vi } from "vitest";
import type { SummarizeResult, SummarizeRuntime } from "../src/application/summarize-contracts.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";
import type { SlideSettings } from "../src/slides/index.js";

const mocks = vi.hoisted(() => ({
  executeSummarize: vi.fn(),
  outputExtractedAsset: vi.fn(),
  presentCliSummarizeResult: vi.fn(),
  presentAssetSummary: vi.fn(),
}));

vi.mock("../src/application/execute-summarize.js", () => ({
  executeSummarize: mocks.executeSummarize,
}));
vi.mock("../src/run/cli-summarize-output.js", () => ({
  presentCliSummarizeResult: mocks.presentCliSummarizeResult,
}));
vi.mock("../src/run/flows/asset/output.js", () => ({
  outputExtractedAsset: mocks.outputExtractedAsset,
}));
vi.mock("../src/run/flows/asset/summary.js", () => ({
  presentAssetSummary: mocks.presentAssetSummary,
}));

import {
  createCliResolvedAssetExecutor,
  createCliUrlSummaryExecutor,
} from "../src/run/cli-summarize-execution.js";

describe("CLI summarize execution", () => {
  it("adapts planned inputs to URL application execution and presentation", async () => {
    const result = { kind: "summary" } as SummarizeResult;
    mocks.executeSummarize.mockResolvedValue(result);
    const runtime = {
      runId: "cli-1",
      env: {},
      fetch: globalThis.fetch,
      execFile: vi.fn(),
      cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
      mediaCache: null,
    } as SummarizeRuntime;
    const ctx = {} as UrlFlowContext;
    const slides: SlideSettings = {
      enabled: true,
      ocr: false,
      outputDir: "/tmp/slides",
      sceneThreshold: 0.3,
      autoTuneThreshold: true,
      maxSlides: 6,
      minDurationSeconds: 2,
    };
    const execute = createCliUrlSummaryExecutor({
      baseRequest: {
        input: { kind: "file", filePath: "/tmp/input.pdf" },
        modelOverride: "openai/gpt-5.4",
        promptOverride: "Prompt",
        lengthRaw: "medium",
        languageRaw: "French",
        format: "markdown",
        overrides: createEmptyRunOverrides(),
        extractOnly: true,
        slides: null,
      },
      runtime,
      slides,
      maxExtractCharacters: 12_000,
    });

    await execute({
      ctx,
      url: "https://example.com/article",
      isYoutubeUrl: true,
    });

    expect(mocks.executeSummarize).toHaveBeenCalledWith(
      {
        input: {
          kind: "url",
          url: "https://example.com/article",
          title: null,
          maxCharacters: 12_000,
        },
        modelOverride: "openai/gpt-5.4",
        promptOverride: "Prompt",
        lengthRaw: "medium",
        languageRaw: "French",
        format: "markdown",
        overrides: expect.any(Object),
        extractOnly: true,
        slides,
      },
      runtime,
      undefined,
      { urlFlowContext: ctx, isYoutubeUrl: true },
    );
    expect(mocks.presentCliSummarizeResult).toHaveBeenCalledWith({ ctx, result });
  });

  it("executes resolved assets through the application and preserves CLI presentation", async () => {
    const details = { kind: "summary", summary: "Asset summary" };
    mocks.executeSummarize.mockImplementation(async (_request, _runtime, events) => {
      events?.({ type: "model-selected", modelId: "openai/gpt-5.4" });
      return {
        kind: "asset-summary",
        details,
      };
    });
    const runtime = {} as SummarizeRuntime;
    const presentationContext = {} as never;
    const prepared = { urlFlowContext: {} as UrlFlowContext };
    const execute = createCliResolvedAssetExecutor({
      baseRequest: {
        input: { kind: "file", filePath: "/tmp/input.txt" },
        modelOverride: null,
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      runtime,
      prepared,
      presentationContext,
      extractionOutputContext: {} as never,
    });
    const args = {
      sourceKind: "file" as const,
      sourceLabel: "/tmp/input.txt",
      attachment: {
        kind: "file" as const,
        mediaType: "text/plain",
        filename: "input.txt",
        bytes: new TextEncoder().encode("Input"),
      },
      onModelChosen: vi.fn(),
    };

    const result = await execute.summarize(args);

    expect(mocks.executeSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          kind: "resolved-asset",
          sourceKind: "file",
          sourceLabel: "/tmp/input.txt",
          attachment: args.attachment,
        },
        slides: null,
      }),
      runtime,
      expect.any(Function),
      prepared,
    );
    expect(args.onModelChosen).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(mocks.presentAssetSummary).toHaveBeenCalledWith(presentationContext, args, details);
    expect(result).toBe(details);
  });

  it("presents resolved asset extraction from application metadata", async () => {
    const extracted = { content: "Extracted", diagnostics: { strategy: "html" } };
    mocks.executeSummarize.mockResolvedValue({
      kind: "asset-extraction",
      input: {
        kind: "asset",
        sourceKind: "asset-url",
        source: "https://example.com/file.pdf",
        mediaType: "application/pdf",
        filename: "file.pdf",
      },
      extracted,
      elapsedMs: 42,
      report: { llm: [], services: {} },
      costUsd: 0.01,
    });
    const runtime = {} as SummarizeRuntime;
    const prepared = { urlFlowContext: {} as UrlFlowContext };
    const extractionOutputContext = { io: {} } as never;
    const execute = createCliResolvedAssetExecutor({
      baseRequest: {
        input: { kind: "url", url: "https://example.com/file.pdf" },
        modelOverride: null,
        promptOverride: null,
        lengthRaw: null,
        languageRaw: null,
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: true,
        slides: null,
      },
      runtime,
      prepared,
      presentationContext: {} as never,
      extractionOutputContext,
    });
    const args = {
      sourceKind: "asset-url" as const,
      sourceLabel: "https://example.com/file.pdf",
      attachment: {
        kind: "file" as const,
        mediaType: "application/pdf",
        filename: "file.pdf",
        bytes: new Uint8Array([1, 2, 3]),
      },
    };

    const result = await execute.extract(args);

    expect(mocks.executeSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ kind: "resolved-asset", attachment: args.attachment }),
        extractOnly: true,
      }),
      runtime,
      expect.any(Function),
      prepared,
    );
    expect(mocks.outputExtractedAsset).toHaveBeenCalledWith({
      ...extractionOutputContext,
      url: "https://example.com/file.pdf",
      sourceLabel: "https://example.com/file.pdf",
      attachment: expect.objectContaining({
        mediaType: "application/pdf",
        filename: "file.pdf",
      }),
      extracted,
      elapsedMs: 42,
      report: { llm: [], services: {} },
      costUsd: 0.01,
    });
    expect(result).toBe(extracted);
  });
});
