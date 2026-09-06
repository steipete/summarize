import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSlideSettings } from "../src/slides/settings.js";
import {
  buildSlidesDirId,
  readSlidesCacheIfValid,
  resolveSlideImagePath,
  resolveSlidesDir,
  resolveValidSlideImagePath,
  serializeSlideImagePath,
  validateSlidesCache,
} from "../src/slides/store.js";
import { SLIDE_EXTRACTION_VERSION, type SlideExtractionResult } from "../src/slides/types.js";

describe("slides store", () => {
  it("serializes relative paths and resolves cached slides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-store-"));
    const settings = resolveSlideSettings({ slides: true, cwd: root });
    expect(settings).not.toBeNull();
    if (!settings) return;

    const source = {
      url: "https://example.com/video.mp4",
      kind: "direct" as const,
      sourceId: "video-abc",
    };
    const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId);
    await fs.mkdir(slidesDir, { recursive: true });
    const imagePath = path.join(slidesDir, "slide_0001.png");
    await fs.writeFile(imagePath, "fake");

    const payload: SlideExtractionResult = {
      extractorVersion: SLIDE_EXTRACTION_VERSION,
      sourceUrl: source.url,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      slidesDir,
      slidesDirId: buildSlidesDirId(slidesDir),
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      autoTune: {
        enabled: false,
        chosenThreshold: settings.sceneThreshold,
        confidence: 0,
        strategy: "none",
      },
      maxSlides: settings.maxSlides,
      minSlideDuration: settings.minDurationSeconds,
      ocrRequested: settings.ocr,
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 12.3,
          imagePath: serializeSlideImagePath(slidesDir, imagePath),
        },
      ],
      warnings: [],
    };

    await fs.writeFile(
      path.join(slidesDir, "slides.json"),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
    const cached = await readSlidesCacheIfValid({ source, settings });
    await expect(
      validateSlidesCache({
        cached: { ...payload, extractorVersion: undefined },
        source,
        settings,
      }),
    ).resolves.toBeNull();
    await expect(
      validateSlidesCache({ cached: { ...payload, extractorVersion: 0 }, source, settings }),
    ).resolves.toBeNull();
    expect(cached?.slides[0]?.imagePath).toBe(imagePath);
    expect(cached?.slidesDirId).toBe(buildSlidesDirId(slidesDir));
  });

  it("rejects cache outside expected output dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-store-"));
    const settings = resolveSlideSettings({ slides: true, cwd: root });
    expect(settings).not.toBeNull();
    if (!settings) return;

    const source = {
      url: "https://example.com/video.mp4",
      kind: "direct" as const,
      sourceId: "video-xyz",
    };

    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-other-"));
    const imagePath = path.join(otherDir, "slide_0001.png");
    await fs.writeFile(imagePath, "fake");

    const cached: SlideExtractionResult = {
      extractorVersion: SLIDE_EXTRACTION_VERSION,
      sourceUrl: source.url,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      slidesDir: otherDir,
      slidesDirId: buildSlidesDirId(otherDir),
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      autoTune: {
        enabled: false,
        chosenThreshold: settings.sceneThreshold,
        confidence: 0,
        strategy: "none",
      },
      maxSlides: settings.maxSlides,
      minSlideDuration: settings.minDurationSeconds,
      ocrRequested: settings.ocr,
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 1.2, imagePath }],
      warnings: [],
    };

    const validated = await validateSlidesCache({ cached, source, settings });
    expect(validated).toBeNull();
  });

  it("rejects image paths outside slides dir", () => {
    const slidesDir = "/tmp/summarize-slides";
    const resolved = resolveSlideImagePath(slidesDir, "../escape.png");
    expect(resolved).toBeNull();
  });

  it("keeps child paths whose names start with dot-dot text", () => {
    const slidesDir = "/tmp/summarize-slides";
    const imagePath = path.join(slidesDir, "...", "slide.png");

    expect(resolveSlideImagePath(slidesDir, ".../slide.png")).toBe(imagePath);
    expect(serializeSlideImagePath(slidesDir, imagePath)).toBe(".../slide.png");
  });

  it("rejects traversal source ids before reading slides json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-store-"));
    const settings = resolveSlideSettings({ slides: true, cwd: root });
    expect(settings).not.toBeNull();
    if (!settings) return;

    const source = {
      url: "https://example.com/video.mp4",
      kind: "direct" as const,
      sourceId: "../outside",
    };
    const outsideDir = path.resolve(settings.outputDir, "..", "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "slides.json"), "{not json", "utf8");

    await expect(readSlidesCacheIfValid({ source, settings })).resolves.toBeNull();
  });

  it("rejects symlinked slide images outside the slides dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-store-"));
    const settings = resolveSlideSettings({ slides: true, cwd: root });
    expect(settings).not.toBeNull();
    if (!settings) return;

    const source = {
      url: "https://example.com/video.mp4",
      kind: "direct" as const,
      sourceId: "video-symlink",
    };
    const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId);
    await fs.mkdir(slidesDir, { recursive: true });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-outside-"));
    const outsideImage = path.join(outsideDir, "secret.png");
    await fs.writeFile(outsideImage, "fake");
    const linkPath = path.join(slidesDir, "slide_0001.png");
    await fs.symlink(outsideImage, linkPath);

    const cached: SlideExtractionResult = {
      extractorVersion: SLIDE_EXTRACTION_VERSION,
      sourceUrl: source.url,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      slidesDir,
      slidesDirId: buildSlidesDirId(slidesDir),
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      autoTune: {
        enabled: false,
        chosenThreshold: settings.sceneThreshold,
        confidence: 0,
        strategy: "none",
      },
      maxSlides: settings.maxSlides,
      minSlideDuration: settings.minDurationSeconds,
      ocrRequested: settings.ocr,
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 1.2, imagePath: "slide_0001.png" }],
      warnings: [],
    };

    await expect(validateSlidesCache({ cached, source, settings })).resolves.toBeNull();
    await expect(resolveValidSlideImagePath(slidesDir, "slide_0001.png")).resolves.toBeNull();
  });
});
