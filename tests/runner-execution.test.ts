import { beforeEach, describe, expect, it, vi } from "vitest";

const extractAssetContent = vi.hoisted(() => vi.fn());
const handleFileInput = vi.hoisted(() => vi.fn());
const withUrlAsset = vi.hoisted(() => vi.fn());
const outputExtractedAsset = vi.hoisted(() => vi.fn());
const runUrlFlow = vi.hoisted(() => vi.fn());
const createTempFileFromStdin = vi.hoisted(() => vi.fn());

vi.mock("../src/run/flows/asset/extract", () => ({
  extractAssetContent,
}));
vi.mock("../src/run/flows/asset/input", () => ({
  handleFileInput,
  withUrlAsset,
}));
vi.mock("../src/run/flows/asset/output", () => ({
  outputExtractedAsset,
}));
vi.mock("../src/run/flows/url/flow", () => ({
  runUrlFlow,
}));
vi.mock("../src/run/stdin-temp-file", () => ({
  createTempFileFromStdin,
}));

import { executeRunnerInput } from "../src/run/runner-execution";

function buildOptions(overrides?: Partial<Parameters<typeof executeRunnerInput>[0]>) {
  return {
    inputTarget: { kind: "url", url: "https://example.com" } as never,
    stdin: process.stdin,
    handleFileInputContext: {},
    url: "https://example.com",
    isYoutubeUrl: false,
    withUrlAssetContext: {},
    slidesEnabled: false,
    extractMode: false,
    progressEnabled: true,
    renderSpinnerStatus: (label: string) => label,
    renderSpinnerStatusWithModel: (label: string, modelId: string) => `${label}:${modelId}`,
    extractAssetContext: {
      env: {},
      envForRun: {},
      execFileImpl: vi.fn() as never,
      timeoutMs: 1_000,
      preprocessMode: "auto" as const,
    },
    outputExtractedAssetContext: {
      io: { env: {}, envForRun: {}, stdout: process.stdout, stderr: process.stderr },
      flags: {
        timeoutMs: 1_000,
        preprocessMode: "auto" as const,
        format: "markdown" as const,
        plain: false,
        json: false,
        metricsEnabled: false,
        metricsDetailed: false,
        shouldComputeReport: false,
        runStartedAtMs: 0,
        verboseColor: false,
      },
      hooks: {
        clearProgressForStdout: vi.fn(),
        restoreProgressAfterStdout: null,
        buildReport: vi.fn(async () => ({}) as never),
        estimateCostUsd: vi.fn(async () => 0),
      },
      apiStatus: {
        xaiApiKey: null,
        apiKey: null,
        openrouterApiKey: null,
        apifyToken: null,
        firecrawlConfigured: false,
        googleConfigured: false,
        anthropicConfigured: false,
      },
    },
    summarizeAsset: vi.fn(async ({ onModelChosen }) => {
      onModelChosen("openai/gpt-5.4");
    }),
    runUrlFlowContext: {},
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

    expect(handleFileInput).toHaveBeenCalledWith({}, { kind: "file", filePath: "/tmp/stdin.txt" });
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

  it("extracts asset urls through outputExtractedAsset", async () => {
    handleFileInput.mockResolvedValue(false);
    extractAssetContent.mockResolvedValue({ content: "body", diagnostics: {} });
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

    await executeRunnerInput(buildOptions({ extractMode: true }));

    expect(extractAssetContent).toHaveBeenCalledTimes(1);
    expect(outputExtractedAsset).toHaveBeenCalledTimes(1);
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

    await executeRunnerInput(buildOptions());

    expect(spinner.setText).toHaveBeenCalledWith("Summarizing");
    expect(spinner.setText).toHaveBeenCalledWith("Summarizing:openai/gpt-5.4");
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
      new Error("Unsupported binary payload for HTML document fetch"),
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
      .mockRejectedValueOnce(
        new Error("Unsupported content-type for HTML document fetch: application/pdf"),
      )
      .mockResolvedValueOnce(undefined);
    withUrlAsset.mockResolvedValue(false);

    await executeRunnerInput(
      buildOptions({
        runUrlFlowContext: {
          flags: { firecrawlMode: "auto", throwOnAssetLikeHtmlError: true },
          model: { apiStatus: { firecrawlConfigured: true } },
        },
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
