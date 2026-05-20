import { rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath, sep as pathSep } from "node:path";

function normalizeAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = resolvePath(trimmed);
  return isAbsolute(resolved) ? resolved : null;
}

export function cleanupSlidesPayload(
  raw: string,
  options?: { preservePaths?: Set<string>; preserveNewerThanMs?: number | null },
) {
  const paths = collectSlidesPayloadArtifactPaths(raw);
  const shouldPreserveNewer = (target: string) => {
    const threshold = options?.preserveNewerThanMs;
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) return false;
    try {
      return statSync(target).mtimeMs > threshold + 10;
    } catch {
      return false;
    }
  };
  const safeRemove = (target: string) => {
    try {
      rmSync(target, { force: true });
    } catch {
      // ignore
    }
  };
  for (const target of paths) {
    if (options?.preservePaths?.has(target)) continue;
    if (shouldPreserveNewer(target)) continue;
    safeRemove(target);
  }
}

export function collectSlidesPayloadArtifactPaths(raw: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object") return [];
  const slidesDir = normalizeAbsolutePath((payload as { slidesDir?: unknown }).slidesDir);
  const slides = Array.isArray((payload as { slides?: unknown }).slides)
    ? ((payload as { slides?: unknown }).slides as Array<{ imagePath?: unknown }>)
    : [];
  if (!slidesDir) return [];
  const dirPrefix = slidesDir.endsWith(pathSep) ? slidesDir : `${slidesDir}${pathSep}`;
  const paths = new Set<string>();
  for (const slide of slides) {
    const imagePath =
      typeof slide?.imagePath === "string" && !isAbsolute(slide.imagePath)
        ? normalizeAbsolutePath(join(slidesDir, slide.imagePath))
        : normalizeAbsolutePath(slide?.imagePath);
    if (!imagePath) continue;
    if (!imagePath.startsWith(dirPrefix)) continue;
    paths.add(imagePath);
  }
  paths.add(join(slidesDir, "slides.json"));
  return Array.from(paths);
}
