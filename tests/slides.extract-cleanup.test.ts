import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {
    throw new Error("cleanup failed");
  }),
}));
vi.mock("../src/slides/ingest.js", () => ({
  prepareSlidesInput: vi.fn(async () => ({
    inputPath: "/synthetic/input.mp4",
    inputCleanup: mocks.cleanup,
    warnings: [],
  })),
}));
vi.mock("../src/slides/frame-extraction.js", () => ({
  detectSlideTimestamps: vi.fn(async () => {
    throw new Error("original extraction failure");
  }),
  extractFramesAtTimestamps: vi.fn(),
}));
vi.mock("../src/slides/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/slides/store.js")>();
  return {
    ...actual,
    prepareSlidesDir: vi.fn(async () => {}),
    withSlidesLock: async (_dir: string, run: () => Promise<unknown>) => run(),
  };
});
vi.mock("../src/slides/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/slides/runtime.js")>();
  return { ...actual, resolveRunnableTool: vi.fn(async () => "synthetic-tool") };
});

import { extractSlidesForSource } from "../src/slides/extract.js";
import type { SlideSettings } from "../src/slides/settings.js";

describe("slide extraction cleanup", () => {
  it("preserves the original failure when temporary input deletion fails", async () => {
    await expect(
      extractSlidesForSource({
        source: { kind: "direct", sourceId: "synthetic", url: "https://example.com/video.mp4" },
        settings: { outputDir: "/synthetic/slides", ocr: false } as SlideSettings,
        noCache: true,
        env: {},
        timeoutMs: 1000,
        ytDlpPath: null,
        ffmpegPath: "synthetic-ffmpeg",
        tesseractPath: null,
      }),
    ).rejects.toThrow("original extraction failure");
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
