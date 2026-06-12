import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { UrlExtractionUi } from "../src/run/flows/url/extract.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { handleVideoOnlyExtractedContent } from "../src/run/flows/url/video-only.js";

const mocks = vi.hoisted(() => ({
  loadRemoteAsset: vi.fn(),
  assertAssetMediaTypeSupported: vi.fn(),
  writeVerbose: vi.fn(),
}));

vi.mock("../src/content/asset.js", () => ({
  loadRemoteAsset: mocks.loadRemoteAsset,
}));

vi.mock("../src/run/attachments.js", () => ({
  assertAssetMediaTypeSupported: mocks.assertAssetMediaTypeSupported,
}));

vi.mock("../src/run/logging.js", () => ({
  writeVerbose: mocks.writeVerbose,
}));

const createWritable = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

const baseExtracted: ExtractedLinkContent = {
  url: "https://example.com/video-only",
  title: "Video Only",
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
  transcriptMetadata: null,
  transcriptionProvider: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  video: { kind: "url", url: "https://cdn.example.com/video.mp4" },
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

const baseUi: UrlExtractionUi = {
  contentSizeLabel: "11B",
  viaSourceLabel: "",
  footerParts: ["html", "video url"],
  finishSourceLabel: "summary",
};

function makeCtx(overrides?: {
  progressEnabled?: boolean;
  videoMode?: "auto" | "transcript" | "understand";
  googleConfigured?: boolean;
  requestedModelKind?: "auto" | "fixed";
  fixedModelSpec?: UrlFlowContext["model"]["fixedModelSpec"];
  summarizeAsset?: UrlFlowContext["hooks"]["summarizeAsset"];
  onExtracted?: UrlFlowContext["hooks"]["onExtracted"];
  onModelChosen?: UrlFlowContext["hooks"]["onModelChosen"];
  writeViaFooter?: UrlFlowContext["hooks"]["writeViaFooter"];
}): UrlFlowContext {
  return {
    io: {
      stderr: createWritable(),
      fetch: vi.fn() as unknown as typeof fetch,
      envForRun: {},
    },
    flags: {
      verbose: false,
      verboseColor: false,
      progressEnabled: overrides?.progressEnabled ?? true,
      timeoutMs: 2_000,
      videoMode: overrides?.videoMode ?? "auto",
    },
    model: {
      apiStatus: {
        googleConfigured: overrides?.googleConfigured ?? false,
      },
      requestedModel: {
        kind: overrides?.requestedModelKind ?? "auto",
      },
      fixedModelSpec: overrides?.fixedModelSpec ?? null,
    },
    hooks: {
      onExtracted: overrides?.onExtracted ?? null,
      onModelChosen: overrides?.onModelChosen ?? null,
      summarizeAsset:
        overrides?.summarizeAsset ??
        vi.fn(async ({ onModelChosen }) => {
          onModelChosen?.("google/gemini-2.5-flash");
        }),
      writeViaFooter: overrides?.writeViaFooter ?? vi.fn(),
    },
  } as unknown as UrlFlowContext;
}

describe("handleVideoOnlyExtractedContent", () => {
  it("skips local file videos", async () => {
    const fetchWithCache = vi.fn();
    const runSlidesExtraction = vi.fn();
    const spinner = { setText: vi.fn() };

    const result = await handleVideoOnlyExtractedContent({
      ctx: makeCtx(),
      extracted: {
        ...baseExtracted,
        video: { kind: "url", url: "file:///Users/peter/video.mp4" },
      },
      extractionUi: baseUi,
      isYoutubeUrl: false,
      fetchWithCache,
      runSlidesExtraction,
      renderStatus: (label, detail = "") => `${label}${detail}`,
      renderStatusWithMeta: (label, meta) => `${label} ${meta}`,
      spinner,
      styleDim: (text) => text,
      updateSummaryProgress: vi.fn(),
      accent: (text) => text,
    });

    expect(result).toEqual({ handled: false, extracted: expect.any(Object), extractionUi: baseUi });
    expect(fetchWithCache).not.toHaveBeenCalled();
    expect(runSlidesExtraction).not.toHaveBeenCalled();
    expect(spinner.setText).not.toHaveBeenCalled();
  });

  it("switches video-only pages to the embedded YouTube URL", async () => {
    const nextExtracted: ExtractedLinkContent = {
      ...baseExtracted,
      url: "https://www.youtube.com/watch?v=abc123",
      siteName: "YouTube",
      content: "Transcript",
      video: null,
      isVideoOnly: false,
      transcriptCharacters: 10,
      transcriptWordCount: 1,
      transcriptSource: "youtube",
      diagnostics: {
        ...baseExtracted.diagnostics,
        strategy: "youtube",
        transcript: {
          ...baseExtracted.diagnostics.transcript,
          textProvided: true,
          provider: "youtube",
          attemptedProviders: ["youtube"],
        },
      },
    };
    const fetchWithCache = vi.fn(async () => nextExtracted);
    const runSlidesExtraction = vi.fn();
    const spinner = { setText: vi.fn() };

    const result = await handleVideoOnlyExtractedContent({
      ctx: makeCtx(),
      extracted: {
        ...baseExtracted,
        video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abc123" },
      },
      extractionUi: baseUi,
      isYoutubeUrl: false,
      fetchWithCache,
      runSlidesExtraction,
      renderStatus: (label, detail = "") => `${label}${detail}`,
      renderStatusWithMeta: (label, meta) => `${label} ${meta}`,
      spinner,
      styleDim: (text) => text,
      updateSummaryProgress: vi.fn(),
      accent: (text) => text,
    });

    expect(fetchWithCache).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    expect(runSlidesExtraction).not.toHaveBeenCalled();
    expect(spinner.setText).toHaveBeenCalledWith("Video-only page: fetching YouTube transcript…");
    expect(result).toEqual({
      handled: false,
      extracted: nextExtracted,
      extractionUi: expect.objectContaining({
        footerParts: expect.arrayContaining(["transcript youtube"]),
      }),
    });
  });

  it("stops before remote download when video understanding is unavailable", async () => {
    const runSlidesExtraction = vi.fn(async () => null);
    const spinner = { setText: vi.fn() };

    const result = await handleVideoOnlyExtractedContent({
      ctx: makeCtx({ googleConfigured: false, videoMode: "understand" }),
      extracted: baseExtracted,
      extractionUi: baseUi,
      isYoutubeUrl: false,
      fetchWithCache: vi.fn(),
      runSlidesExtraction,
      renderStatus: (label, detail = "") => `${label}${detail}`,
      renderStatusWithMeta: (label, meta) => `${label} ${meta}`,
      spinner,
      styleDim: (text) => text,
      updateSummaryProgress: vi.fn(),
      accent: (text) => text,
    });

    expect(runSlidesExtraction).toHaveBeenCalledTimes(1);
    expect(mocks.loadRemoteAsset).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false, extracted: baseExtracted, extractionUi: baseUi });
  });

  it("downloads and summarizes direct video when google video understanding is available", async () => {
    const onExtracted = vi.fn();
    const onModelChosen = vi.fn();
    const writeViaFooter = vi.fn();
    const summarizeAsset = vi.fn(async ({ onModelChosen: reportModel }) => {
      reportModel?.("google/gemini-2.5-pro");
      return {
        kind: "summary" as const,
        outcome: "model" as const,
        summary: "Video summary.",
        summaryEmitted: false,
        summaryFromCache: false,
        prompt: "Prompt",
        extracted: {
          kind: "asset" as const,
          source: "https://cdn.example.com/video.mp4",
          mediaType: "video/mp4",
          filename: "video.mp4",
        },
        footerParts: [],
        llm: {
          provider: "google" as const,
          model: "google/gemini-2.5-pro",
          maxCompletionTokens: null,
          strategy: "single" as const,
        },
      };
    });
    const updateSummaryProgress = vi.fn();
    const spinner = { setText: vi.fn() };
    const asset = {
      sourceLabel: "https://cdn.example.com/video.mp4",
      attachment: {
        filename: "video.mp4",
        mediaType: "video/mp4",
        data: Buffer.from("video"),
      },
    };

    mocks.loadRemoteAsset.mockResolvedValueOnce(asset);

    const result = await handleVideoOnlyExtractedContent({
      ctx: makeCtx({
        googleConfigured: true,
        videoMode: "auto",
        requestedModelKind: "auto",
        summarizeAsset,
        onExtracted,
        onModelChosen,
        writeViaFooter,
      }),
      extracted: baseExtracted,
      extractionUi: baseUi,
      isYoutubeUrl: false,
      fetchWithCache: vi.fn(),
      runSlidesExtraction: vi.fn(async () => ({
        sourceUrl: baseExtracted.video?.url ?? "",
        sourceKind: "video-url",
        sourceId: "vid123",
        slidesDir: "/tmp/slides",
        sceneThreshold: 0.3,
        autoTuneThreshold: true,
        autoTune: { enabled: false, chosenThreshold: 0.3, confidence: 0, strategy: "none" },
        maxSlides: 100,
        minSlideDuration: 2,
        ocrRequested: false,
        ocrAvailable: false,
        slides: [
          { index: 1, timestamp: 1, imagePath: "/tmp/slide-1.png" },
          { index: 2, timestamp: 2, imagePath: "/tmp/slide-2.png" },
        ],
        warnings: [],
      })),
      renderStatus: (label, detail = "") => `${label}${detail}`,
      renderStatusWithMeta: (label, meta) => `${label} ${meta}`,
      spinner,
      styleDim: (text) => text,
      updateSummaryProgress,
      accent: (text) => text,
    });

    expect(result).toMatchObject({
      handled: true,
      extracted: baseExtracted,
      slides: { sourceId: "vid123", slides: [{ index: 1 }, { index: 2 }] },
      summary: {
        summary: "Video summary.",
        footerParts: ["html", "video url", "slides 2"],
        llm: { model: "google/gemini-2.5-pro" },
      },
    });
    expect(onExtracted).toHaveBeenCalledWith(baseExtracted);
    expect(mocks.loadRemoteAsset).toHaveBeenCalledWith({
      url: "https://cdn.example.com/video.mp4",
      fetchImpl: expect.any(Function),
      timeoutMs: 2_000,
    });
    expect(mocks.assertAssetMediaTypeSupported).toHaveBeenCalledWith({
      attachment: asset.attachment,
      sizeLabel: null,
    });
    expect(summarizeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "asset-url",
        sourceLabel: asset.sourceLabel,
        attachment: asset.attachment,
      }),
    );
    expect(onModelChosen).toHaveBeenCalledWith("google/gemini-2.5-pro");
    expect(writeViaFooter).not.toHaveBeenCalled();
    expect(updateSummaryProgress).toHaveBeenCalledTimes(1);
    expect(spinner.setText).toHaveBeenCalledWith("Downloading video");
    expect(spinner.setText).toHaveBeenCalledWith("Summarizing video");
    expect(spinner.setText).toHaveBeenCalledWith(
      "Summarizing video (model: google/gemini-2.5-pro)",
    );
  });
});
