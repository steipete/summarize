import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssetLikeHtmlFetchError } from "../packages/core/src/content/index.js";
import type { AssetInputContext } from "../src/run/flows/asset/input.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

const handleFileInput = vi.hoisted(() => vi.fn());
const loadLocalAsset = vi.hoisted(() => vi.fn());
const withUrlAsset = vi.hoisted(() => vi.fn());
const runUrlFlow = vi.hoisted(() => vi.fn());
const createTempFileFromStdin = vi.hoisted(() => vi.fn());

vi.mock("../src/content/asset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/content/asset.js")>()),
  loadLocalAsset,
}));
vi.mock("../src/run/flows/asset/input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/run/flows/asset/input.js")>()),
  handleFileInput,
  withUrlAsset,
}));
vi.mock("../src/run/flows/url/flow", () => ({
  runUrlFlow,
}));
vi.mock("../src/run/stdin-temp-file", () => ({
  createTempFileFromStdin,
}));

import { executeRunnerInput, type RunnerExecutionOptions } from "../src/run/runner-execution";

function buildOptions(overrides?: Partial<RunnerExecutionOptions>): RunnerExecutionOptions {
  const setClearProgressBeforeStdout = vi.fn();
  const clearProgressIfCurrent = vi.fn();
  return {
    inputTarget: { kind: "url", url: "https://example.com" } as never,
    stdin: process.stdin,
    handleFileInputContext: {
      stderr: process.stderr,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    } as unknown as AssetInputContext,
    url: "https://example.com",
    isYoutubeUrl: false,
    withUrlAssetContext: {} as AssetInputContext,
    slidesEnabled: false,
    extractMode: false,
    progressEnabled: true,
    renderSpinnerStatus: (label: string) => label,
    renderSpinnerStatusWithModel: (label: string, modelId: string) => `${label}:${modelId}`,
    resolvedAsset: {
      summarize: vi.fn(async ({ onModelChosen }) => {
        onModelChosen?.("openai/gpt-5.4");
        return {} as never;
      }),
      extract: vi.fn(async () => ({ content: "body", diagnostics: {} }) as never),
    },
    runUrlFlowContext: {} as UrlFlowContext,
    executeUrlSummary: async (options) => {
      await runUrlFlow(options);
    },
    ...overrides,
  };
}

describe("runner execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles stdin via a temp file and cleans up", async () => {
    const cleanup = vi.fn(async () => {});
    createTempFileFromStdin.mockResolvedValue({ filePath: "/tmp/stdin.txt", cleanup });
    handleFileInput.mockResolvedValueOnce(true);

    await executeRunnerInput(buildOptions({ inputTarget: { kind: "stdin" } as never }));

    expect(handleFileInput).toHaveBeenCalledWith(expect.any(Object), {
      kind: "file",
      filePath: "/tmp/stdin.txt",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("throws when stdin conversion still cannot be handled", async () => {
    const cleanup = vi.fn(async () => {});
    createTempFileFromStdin.mockResolvedValue({ filePath: "/tmp/stdin.txt", cleanup });
    handleFileInput.mockResolvedValueOnce(false);

    await expect(
      executeRunnerInput(buildOptions({ inputTarget: { kind: "stdin" } as never })),
    ).rejects.toThrow("Failed to process stdin input");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("registers local PDF extraction progress for clearing before stdout", async () => {
    const attachment = {
      kind: "file" as const,
      mediaType: "application/pdf",
      filename: "notes.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    };
    loadLocalAsset.mockResolvedValue({
      sourceLabel: "/tmp/notes.pdf",
      attachment,
    });
    let clearBeforeStdout: (() => void) | null = null;
    const setClearProgressBeforeStdout = vi.fn((clear) => {
      clearBeforeStdout = clear;
    });
    const clearProgressIfCurrent = vi.fn();
    const options = buildOptions({
      inputTarget: { kind: "file", filePath: "/tmp/notes.pdf" } as never,
      extractMode: true,
      progressEnabled: false,
      handleFileInputContext: {
        stderr: process.stderr,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
      } as unknown as AssetInputContext,
    });
    vi.mocked(options.resolvedAsset.extract).mockImplementationOnce(async () => {
      clearBeforeStdout?.();
      return { content: "Extracted", diagnostics: {} } as never;
    });

    await executeRunnerInput(options);

    expect(setClearProgressBeforeStdout).toHaveBeenCalledWith(expect.any(Function));
    expect(options.resolvedAsset.extract).toHaveBeenCalledWith({
      sourceKind: "file",
      sourceLabel: "/tmp/notes.pdf",
      attachment,
    });
    expect(clearProgressIfCurrent).toHaveBeenCalledWith(expect.any(Function));
  });

  it("extracts asset urls through resolved asset execution", async () => {
    handleFileInput.mockResolvedValue(false);
    withUrlAsset.mockImplementation(async (_ctx, _url, _isYoutube, fn) => {
      await fn({
        loaded: {
          attachment: { kind: "file", mediaType: "text/html", filename: "index.html" },
          sourceLabel: "Example",
        },
        spinner: { setText: vi.fn() },
      });
      return true;
    });

    const options = buildOptions({ extractMode: true });
    await executeRunnerInput(options);

    expect(options.resolvedAsset.extract).toHaveBeenCalledWith({
      sourceKind: "asset-url",
      sourceLabel: "Example",
      attachment: { kind: "file", mediaType: "text/html", filename: "index.html" },
    });
    expect(runUrlFlow).not.toHaveBeenCalled();
  });

  it("summarizes asset urls and updates spinner with model name", async () => {
    const spinner = { setText: vi.fn() };
    handleFileInput.mockResolvedValue(false);
    withUrlAsset.mockImplementation(async (_ctx, _url, _isYoutube, fn) => {
      await fn({
        loaded: {
          attachment: { kind: "file", mediaType: "text/html", filename: "index.html" },
          sourceLabel: "Example",
        },
        spinner,
      });
      return true;
    });

    const options = buildOptions();
    await executeRunnerInput(options);

    expect(spinner.setText).toHaveBeenCalledWith("Summarizing");
    expect(spinner.setText).toHaveBeenCalledWith("Summarizing:openai/gpt-5.4");
    expect(options.resolvedAsset.summarize).toHaveBeenCalledTimes(1);
    expect(runUrlFlow).not.toHaveBeenCalled();
  });

  it("falls through to URL flow or throws for missing url", async () => {
    handleFileInput.mockResolvedValue(false);
    withUrlAsset.mockResolvedValue(false);

    await executeRunnerInput(buildOptions());
    expect(withUrlAsset).toHaveBeenCalledWith(
      {},
      "https://example.com",
      false,
      expect.any(Function),
      { detectUnknownAssetUrls: false, assumeAsset: false },
    );
    expect(runUrlFlow).toHaveBeenCalledWith({
      ctx: {},
      url: "https://example.com",
      isYoutubeUrl: false,
    });

    await expect(executeRunnerInput(buildOptions({ url: null }))).rejects.toThrow(
      "Only HTTP and HTTPS URLs can be summarized",
    );
  });

  it("falls back to slower unknown asset detection only after URL flow fails", async () => {
    handleFileInput.mockResolvedValue(false);
    runUrlFlow.mockRejectedValueOnce(
      new Error("wrapped extraction failure", {
        cause: new AssetLikeHtmlFetchError("binary-payload"),
      }),
    );
    withUrlAsset.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await executeRunnerInput(buildOptions());

    expect(runUrlFlow).toHaveBeenCalledTimes(1);
    expect(withUrlAsset).toHaveBeenNthCalledWith(
      1,
      {},
      "https://example.com",
      false,
      expect.any(Function),
      { detectUnknownAssetUrls: false, assumeAsset: false },
    );
    expect(withUrlAsset).toHaveBeenNthCalledWith(
      2,
      {},
      "https://example.com",
      false,
      expect.any(Function),
      { detectUnknownAssetUrls: true, assumeAsset: true },
    );
  });

  it("allows Firecrawl fallback when unknown asset retry misses", async () => {
    handleFileInput.mockResolvedValue(false);
    runUrlFlow
      .mockRejectedValueOnce(new AssetLikeHtmlFetchError("content-type", "application/pdf"))
      .mockResolvedValueOnce(undefined);
    withUrlAsset.mockResolvedValue(false);

    await executeRunnerInput(
      buildOptions({
        runUrlFlowContext: {
          flags: { firecrawlMode: "auto", throwOnAssetLikeHtmlError: true },
          model: { apiStatus: { firecrawlConfigured: true } },
        } as UrlFlowContext,
      }),
    );

    expect(runUrlFlow).toHaveBeenCalledTimes(2);
    expect(runUrlFlow.mock.calls[1]?.[0]).toMatchObject({
      ctx: { flags: { firecrawlMode: "auto", throwOnAssetLikeHtmlError: false } },
      url: "https://example.com",
      isYoutubeUrl: false,
    });
    expect(withUrlAsset).toHaveBeenCalledTimes(2);
  });

  it("does not run slow unknown asset detection for ordinary URL flow failures", async () => {
    handleFileInput.mockResolvedValue(false);
    runUrlFlow.mockRejectedValueOnce(new Error("Fetching HTML document timed out"));
    withUrlAsset.mockResolvedValueOnce(false);

    await expect(executeRunnerInput(buildOptions())).rejects.toThrow(
      "Fetching HTML document timed out",
    );

    expect(withUrlAsset).toHaveBeenCalledTimes(1);
    expect(withUrlAsset).toHaveBeenNthCalledWith(
      1,
      {},
      "https://example.com",
      false,
      expect.any(Function),
      { detectUnknownAssetUrls: false, assumeAsset: false },
    );
  });

  it("routes local media files through URL flow when slides are enabled", async () => {
    await executeRunnerInput(
      buildOptions({
        inputTarget: { kind: "file", filePath: "/tmp/video.webm" } as never,
        url: null,
        slidesEnabled: true,
      }),
    );

    expect(handleFileInput).not.toHaveBeenCalled();
    expect(runUrlFlow).toHaveBeenCalledWith({
      ctx: {},
      url: "file:///tmp/video.webm",
      isYoutubeUrl: false,
    });
  });

  it("routes direct media URLs through URL flow when slides are enabled", async () => {
    await executeRunnerInput(
      buildOptions({
        inputTarget: { kind: "url", url: "https://cdn.example.com/video.mp4" } as never,
        url: "https://cdn.example.com/video.mp4",
        slidesEnabled: true,
      }),
    );

    expect(withUrlAsset).not.toHaveBeenCalled();
    expect(runUrlFlow).toHaveBeenCalledWith({
      ctx: {},
      url: "https://cdn.example.com/video.mp4",
      isYoutubeUrl: false,
    });
  });
});
