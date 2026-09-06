import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSlidesDirId, serializeSlideImagePath } from "./store.js";
import {
  SLIDE_EXTRACTION_VERSION,
  type SlideAutoTune,
  type SlideExtractionResult,
  type SlideImage,
  type SlideSource,
  type SlideSourceKind,
} from "./types.js";

export const SLIDES_PROGRESS = {
  PREPARE: 2,
  FETCH_VIDEO: 6,
  DOWNLOAD_VIDEO: 35,
  DETECT_SCENES: 60,
  EXTRACT_FRAMES: 90,
  OCR: 99,
  FINAL: 100,
} as const;

export type SlidesChunkMeta = {
  slidesDir: string;
  sourceUrl: string;
  sourceId: string;
  sourceKind: SlideSourceKind;
  ocrAvailable: boolean;
};

export function buildSlidesChunkMeta(args: {
  slidesDir: string;
  source: SlideSource;
  ocrAvailable: boolean;
}): SlidesChunkMeta {
  return {
    slidesDir: args.slidesDir,
    sourceUrl: args.source.url,
    sourceId: args.source.sourceId,
    sourceKind: args.source.kind,
    ocrAvailable: args.ocrAvailable,
  };
}

export function buildSlideTimeline(args: {
  source: SlideSource;
  slidesDir: string;
  sceneThreshold: number;
  autoTuneThreshold: boolean;
  autoTune: SlideAutoTune;
  maxSlides: number;
  minSlideDuration: number;
  ocrRequested: boolean;
  ocrAvailable: boolean;
  warnings: string[];
  slides: Array<SlideImage & { segment?: unknown }>;
}): SlideExtractionResult {
  return {
    extractorVersion: SLIDE_EXTRACTION_VERSION,
    sourceUrl: args.source.url,
    sourceKind: args.source.kind,
    sourceId: args.source.sourceId,
    slidesDir: args.slidesDir,
    slidesDirId: buildSlidesDirId(args.slidesDir),
    sceneThreshold: args.sceneThreshold,
    autoTuneThreshold: args.autoTuneThreshold,
    autoTune: args.autoTune,
    maxSlides: args.maxSlides,
    minSlideDuration: args.minSlideDuration,
    ocrRequested: args.ocrRequested,
    ocrAvailable: args.ocrAvailable,
    slides: args.slides.map(({ segment: _segment, ...slide }) => slide),
    warnings: args.warnings,
  };
}

export function emitPlaceholderSlides(args: {
  slides: Array<SlideImage & { segment?: unknown }>;
  meta: SlidesChunkMeta;
  onSlideChunk?: ((value: { slide: SlideImage; meta: SlidesChunkMeta }) => void) | null;
}) {
  if (!args.onSlideChunk) return;
  for (const slide of args.slides) {
    const { segment: _segment, ...payload } = slide;
    args.onSlideChunk({
      slide: { ...payload, imagePath: "" },
      meta: args.meta,
    });
  }
}

export function emitFinalSlides(args: {
  slides: SlideImage[];
  meta: SlidesChunkMeta;
  onSlideChunk?: ((value: { slide: SlideImage; meta: SlidesChunkMeta }) => void) | null;
}) {
  if (!args.onSlideChunk) return;
  for (const slide of args.slides) {
    args.onSlideChunk({ slide, meta: args.meta });
  }
}

export async function renameSlidesWithTimestamps(
  slides: SlideImage[],
  slidesDir: string,
): Promise<SlideImage[]> {
  const renamed: SlideImage[] = [];
  for (const slide of slides) {
    const timestampLabel = slide.timestamp.toFixed(2);
    const filename = `slide_${slide.index.toString().padStart(4, "0")}_${timestampLabel}s.png`;
    const nextPath = path.join(slidesDir, filename);
    if (slide.imagePath !== nextPath) {
      await fs.rename(slide.imagePath, nextPath).catch(async () => {
        await fs.copyFile(slide.imagePath, nextPath);
        await fs.rm(slide.imagePath, { force: true });
      });
    }
    renamed.push({ ...slide, imagePath: nextPath });
  }
  return renamed;
}

export async function writeSlidesJson(
  result: SlideExtractionResult,
  slidesDir: string,
): Promise<void> {
  const slidesDirId = result.slidesDirId ?? buildSlidesDirId(slidesDir);
  const payload = {
    extractorVersion: result.extractorVersion,
    sourceUrl: result.sourceUrl,
    sourceKind: result.sourceKind,
    sourceId: result.sourceId,
    slidesDir,
    slidesDirId,
    sceneThreshold: result.sceneThreshold,
    autoTuneThreshold: result.autoTuneThreshold,
    autoTune: result.autoTune,
    maxSlides: result.maxSlides,
    minSlideDuration: result.minSlideDuration,
    ocrRequested: result.ocrRequested,
    ocrAvailable: result.ocrAvailable,
    slideCount: result.slides.length,
    warnings: result.warnings,
    slides: result.slides.map((slide) => ({
      ...slide,
      imagePath: serializeSlideImagePath(slidesDir, slide.imagePath),
    })),
  };
  await fs.writeFile(path.join(slidesDir, "slides.json"), JSON.stringify(payload, null, 2), "utf8");
}
