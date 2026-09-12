import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SlideSettings } from "./settings.js";
import { SLIDE_EXTRACTION_VERSION, type SlideExtractionResult, type SlideSource } from "./types.js";

const normalizePath = (value: string) => path.resolve(value);

export function resolveSlidesDir(outputDir: string, sourceId: string): string {
  return path.join(outputDir, sourceId);
}

export function buildSlidesDirId(slidesDir: string): string {
  return createHash("sha1").update(normalizePath(slidesDir)).digest("hex").slice(0, 8);
}

const isPathUnderRoot = (root: string, candidate: string): boolean => {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

export function resolveSlideImagePath(slidesDir: string, imagePath: string): string | null {
  if (!imagePath) return null;
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.join(slidesDir, imagePath);
  const normalizedSlidesDir = normalizePath(slidesDir);
  const normalizedResolved = normalizePath(resolved);
  if (!isPathUnderRoot(normalizedSlidesDir, normalizedResolved)) return null;
  return normalizedResolved;
}

export function serializeSlideImagePath(slidesDir: string, imagePath: string): string {
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.join(slidesDir, imagePath);
  const normalizedSlidesDir = normalizePath(slidesDir);
  const normalizedResolved = normalizePath(resolved);
  const rel = path.relative(normalizedSlidesDir, normalizedResolved);
  if (isPathUnderRoot(normalizedSlidesDir, normalizedResolved)) {
    return rel;
  }
  return imagePath;
}

export async function resolveValidSlideImagePath(
  slidesDir: string,
  imagePath: string,
): Promise<string | null> {
  const resolved = resolveSlideImagePath(slidesDir, imagePath);
  if (!resolved) return null;
  try {
    const realSlidesDir = await fs.realpath(normalizePath(slidesDir));
    const linkStat = await fs.lstat(resolved);
    if (linkStat.isSymbolicLink()) return null;
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return null;
    const realResolved = await fs.realpath(resolved);
    if (!isPathUnderRoot(realSlidesDir, realResolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export async function validateSlidesCache({
  cached,
  source,
  settings,
}: {
  cached: SlideExtractionResult;
  source: SlideSource;
  settings: SlideSettings;
}): Promise<SlideExtractionResult | null> {
  if (!cached || typeof cached !== "object") return null;
  if (cached.extractorVersion !== SLIDE_EXTRACTION_VERSION) return null;
  if (cached.sourceId !== source.sourceId) return null;
  if (cached.sourceKind !== source.kind) return null;
  if (cached.sourceUrl !== source.url) return null;

  const expectedSlidesDir = resolveSlidesDir(settings.outputDir, source.sourceId);
  const normalizedExpectedDir = normalizePath(expectedSlidesDir);
  const normalizedOutputDir = normalizePath(settings.outputDir);
  if (!isPathUnderRoot(normalizedOutputDir, normalizedExpectedDir)) return null;
  if (!cached.slidesDir || normalizePath(cached.slidesDir) !== normalizedExpectedDir) {
    return null;
  }
  const expectedDirId = buildSlidesDirId(normalizedExpectedDir);
  if (cached.slidesDirId && cached.slidesDirId !== expectedDirId) return null;

  if (cached.sceneThreshold !== settings.sceneThreshold) return null;
  if (cached.maxSlides !== settings.maxSlides) return null;
  if (cached.minSlideDuration !== settings.minDurationSeconds) return null;
  if (cached.ocrRequested !== settings.ocr) return null;
  if (!Array.isArray(cached.slides) || cached.slides.length === 0) return null;

  const slides = [];
  let realExpectedDir: string;
  try {
    const realOutputDir = await fs.realpath(normalizedOutputDir);
    const dirStat = await fs.stat(normalizedExpectedDir);
    if (!dirStat?.isDirectory()) return null;
    realExpectedDir = await fs.realpath(normalizedExpectedDir);
    if (!isPathUnderRoot(realOutputDir, realExpectedDir)) return null;
  } catch {
    return null;
  }

  for (const slide of cached.slides) {
    if (!slide?.imagePath) return null;
    const resolved = await resolveValidSlideImagePath(normalizedExpectedDir, slide.imagePath);
    if (!resolved) return null;
    slides.push({ ...slide, imagePath: resolved });
  }

  return {
    ...cached,
    slidesDir: normalizedExpectedDir,
    slidesDirId: cached.slidesDirId ?? expectedDirId,
    slides,
  };
}

export async function readSlidesCacheIfValid({
  source,
  settings,
}: {
  source: SlideSource;
  settings: SlideSettings;
}): Promise<SlideExtractionResult | null> {
  const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId);
  const normalizedOutputDir = normalizePath(settings.outputDir);
  const normalizedSlidesDir = normalizePath(slidesDir);
  if (!isPathUnderRoot(normalizedOutputDir, normalizedSlidesDir)) return null;
  const payloadPath = path.join(slidesDir, "slides.json");
  let raw: string;
  try {
    raw = await fs.readFile(payloadPath, "utf8");
  } catch {
    return null;
  }
  let parsed: SlideExtractionResult;
  try {
    parsed = JSON.parse(raw) as SlideExtractionResult;
  } catch {
    return null;
  }
  return await validateSlidesCache({ cached: parsed, source, settings });
}
