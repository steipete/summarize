import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummarizeResult } from "../src/application/summarize-contracts.js";
import type { SlidesTerminalOutput } from "../src/run/flows/url/slides-output.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

const mocks = vi.hoisted(() => ({
  createSlidesTerminalOutput: vi.fn(),
  deriveExtractionUi: vi.fn(() => ({
    contentSizeLabel: "0 B",
    viaSourceLabel: "",
    footerParts: [],
    finishSourceLabel: null,
  })),
  outputExtractedUrl: vi.fn(),
  presentExtractedUrlSummary: vi.fn(),
}));

vi.mock("../src/run/flows/url/slides-output.js", () => ({
  createSlidesTerminalOutput: mocks.createSlidesTerminalOutput,
}));
vi.mock("../src/run/flows/url/extract.js", () => ({
  deriveExtractionUi: mocks.deriveExtractionUi,
}));
vi.mock("../src/run/flows/url/summary.js", () => ({
  outputExtractedUrl: mocks.outputExtractedUrl,
  presentExtractedUrlSummary: mocks.presentExtractedUrlSummary,
}));

import { presentCliSummarizeResult } from "../src/run/cli-summarize-output.js";

describe("CLI summarize output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates slide output for extract-only results with extracted slides", async () => {
    const slidesOutput = { renderFromText: vi.fn() } as unknown as SlidesTerminalOutput;
    mocks.createSlidesTerminalOutput.mockReturnValue(slidesOutput);
    const ctx = {
      io: {},
      flags: {
        json: false,
        plain: true,
        lengthArg: { kind: "preset", preset: "long" },
        slides: { enabled: true },
        slidesDebug: true,
      },
      hooks: {
        clearProgressForStdout: vi.fn(),
        restoreProgressAfterStdout: null,
      },
      model: { openaiWhisperUsdPerMinute: null },
    } as unknown as UrlFlowContext;
    const result = {
      kind: "extraction",
      input: {
        kind: "url",
        url: "file:///tmp/video.mp4",
        title: null,
        maxCharacters: null,
      },
      extracted: {
        content: "",
        transcriptSource: null,
        transcriptionProvider: null,
        mediaDurationSeconds: null,
      },
      slides: {
        slides: [{ index: 1, timestamp: 0, imagePath: "/tmp/slide.png" }],
      },
      details: {
        kind: "url-extraction",
        prompt: "prompt",
        effectiveMarkdownMode: "off",
      },
    } as unknown as SummarizeResult;

    await presentCliSummarizeResult({ ctx, result });

    expect(mocks.createSlidesTerminalOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        slides: result.slides,
        enabled: true,
      }),
    );
    expect(mocks.outputExtractedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        slides: result.slides,
        slidesOutput,
      }),
    );
  });

  it("does not render a planned extraction timeline before slide paths are finalized", async () => {
    mocks.createSlidesTerminalOutput.mockReturnValue(null);
    const ctx = {
      io: {},
      flags: {
        json: false,
        plain: false,
        lengthArg: { kind: "preset", preset: "long" },
        slides: { enabled: true },
        slidesDebug: false,
      },
      hooks: {
        clearProgressForStdout: vi.fn(),
        restoreProgressAfterStdout: null,
      },
      model: { openaiWhisperUsdPerMinute: null },
    } as unknown as UrlFlowContext;
    const result = {
      kind: "extraction",
      input: {
        kind: "url",
        url: "https://example.com/video.mp4",
        title: null,
        maxCharacters: null,
      },
      extracted: {
        content: "Transcript",
        transcriptSource: null,
        transcriptionProvider: null,
        mediaDurationSeconds: 60,
      },
      slides: {
        slides: [{ index: 1, timestamp: 0, imagePath: "" }],
      },
      details: {
        kind: "url-extraction",
        prompt: "prompt",
        effectiveMarkdownMode: "off",
      },
    } as unknown as SummarizeResult;

    await presentCliSummarizeResult({ ctx, result });

    expect(mocks.createSlidesTerminalOutput).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(mocks.outputExtractedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ slidesOutput: null }),
    );
  });
});
