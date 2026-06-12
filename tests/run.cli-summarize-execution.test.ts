import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SummarizeRequest,
  SummarizeResult,
  SummarizeRuntime,
} from "../src/application/summarize-contracts.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";

const mocks = vi.hoisted(() => ({
  executeSummarize: vi.fn(),
  outputExtractedAsset: vi.fn(),
  presentCliSummarizeResult: vi.fn(),
  presentAssetSummary: vi.fn(),
  presentMediaFileResult: vi.fn(),
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
vi.mock("../src/run/flows/asset/media.js", () => ({
  presentMediaFileResult: mocks.presentMediaFileResult,
}));
vi.mock("../src/run/flows/asset/summary.js", () => ({
  presentAssetSummary: mocks.presentAssetSummary,
}));

import { createCliSummarizeExecutor } from "../src/run/cli-summarize-execution.js";

function createExecutor(result: SummarizeResult) {
  const request: SummarizeRequest = {
    input: { kind: "file", filePath: "/tmp/input.txt" },
    modelOverride: null,
    promptOverride: null,
    lengthRaw: null,
    languageRaw: null,
    format: "text",
    overrides: createEmptyRunOverrides(),
    extractOnly: false,
    slides: null,
  };
  const runtime = {} as SummarizeRuntime;
  const prepared = {
    urlFlowContext: {} as UrlFlowContext,
    assetSummaryContext: {} as never,
  };
  const presentationContext = {} as never;
  const extractionOutputContext = { io: {} } as never;
  const progress = {
    handleEvent: vi.fn(),
    stop: vi.fn(),
  };
  mocks.executeSummarize.mockImplementationOnce(async (_request, _runtime, events) => {
    events?.({ type: "model-selected", modelId: "openai/gpt-5.4" });
    return result;
  });
  return {
    execute: createCliSummarizeExecutor({
      request,
      runtime,
      prepared,
      presentationContext,
      extractionOutputContext,
      progress,
    }),
    request,
    runtime,
    prepared,
    presentationContext,
    extractionOutputContext,
    progress,
  };
}

describe("CLI summarize execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes the planned request and presents URL results", async () => {
    const result = {
      kind: "summary",
      input: { kind: "url" },
      details: { kind: "visible-page" },
    } as SummarizeResult;
    const fixture = createExecutor(result);

    await fixture.execute();

    expect(mocks.executeSummarize).toHaveBeenCalledWith(
      fixture.request,
      fixture.runtime,
      fixture.progress.handleEvent,
      fixture.prepared,
    );
    expect(mocks.presentCliSummarizeResult).toHaveBeenCalledWith({
      ctx: fixture.prepared.urlFlowContext,
      result,
    });
    expect(fixture.progress.stop).toHaveBeenCalledOnce();
  });

  it("presents asset summaries from byte-free application metadata", async () => {
    const details = { kind: "summary", summary: "Asset summary" };
    const result = {
      kind: "asset-summary",
      input: {
        kind: "asset",
        sourceKind: "file",
        source: "/tmp/input.png",
        mediaType: "image/png",
        filename: "input.png",
      },
      details,
    } as SummarizeResult;
    const fixture = createExecutor(result);

    await fixture.execute();

    expect(mocks.presentAssetSummary).toHaveBeenCalledWith(
      fixture.presentationContext,
      {
        sourceKind: "file",
        sourceLabel: "/tmp/input.png",
        attachment: {
          kind: "image",
          mediaType: "image/png",
          filename: "input.png",
        },
      },
      details,
    );
  });

  it("presents delegated URL video summaries through the asset presenter", async () => {
    const summary = {
      kind: "summary",
      outcome: "model",
      summary: "Video summary",
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
        maxCompletionTokens: 256,
        strategy: "single",
      },
    } as const;
    const result = {
      kind: "summary",
      input: {
        kind: "url",
        url: "https://example.com/video",
        title: null,
        maxCharacters: null,
      },
      details: {
        kind: "delegated-asset",
        summaryEmitted: false,
        summary,
      },
    } as SummarizeResult;
    const fixture = createExecutor(result);

    await fixture.execute();

    expect(mocks.presentAssetSummary).toHaveBeenCalledWith(
      fixture.presentationContext,
      {
        sourceKind: "asset-url",
        sourceLabel: "https://cdn.example.com/video.mp4",
        attachment: {
          kind: "file",
          mediaType: "video/mp4",
          filename: "video.mp4",
        },
      },
      summary,
    );
    expect(mocks.presentCliSummarizeResult).not.toHaveBeenCalled();
  });

  it("presents asset extraction from application metrics", async () => {
    const extracted = { content: "Extracted", diagnostics: { strategy: "html" } };
    const result = {
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
    } as SummarizeResult;
    const fixture = createExecutor(result);

    await fixture.execute();

    expect(mocks.outputExtractedAsset).toHaveBeenCalledWith({
      ...fixture.extractionOutputContext,
      url: "https://example.com/file.pdf",
      sourceLabel: "https://example.com/file.pdf",
      attachment: result.input,
      extracted,
      elapsedMs: 42,
      report: { llm: [], services: {} },
      costUsd: 0.01,
    });
  });

  it("presents media results and always stops progress", async () => {
    const details = { kind: "extraction", extracted: { content: "Transcript" } };
    const fixture = createExecutor({
      kind: "asset-media",
      input: {
        kind: "asset",
        sourceKind: "file",
        source: "/tmp/audio.mp3",
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
      },
      details,
    } as SummarizeResult);

    await fixture.execute();

    expect(mocks.presentMediaFileResult).toHaveBeenCalledWith(fixture.presentationContext, details);
    expect(fixture.progress.stop).toHaveBeenCalledOnce();
  });

  it("stops progress when execution fails", async () => {
    const fixture = createExecutor({ kind: "summary" } as SummarizeResult);
    mocks.executeSummarize.mockReset();
    mocks.executeSummarize.mockRejectedValueOnce(new Error("boom"));

    await expect(fixture.execute()).rejects.toThrow("boom");

    expect(fixture.progress.stop).toHaveBeenCalledOnce();
  });
});
