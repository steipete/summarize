import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTransformersRuntimeAssets } from "../apps/chrome-extension/scripts/transformers-runtime-assets";

describe("Chrome Transformers.js runtime assets", () => {
  it("resolves the JavaScript factory and WASM binary from the installed dependency graph", () => {
    const assets = resolveTransformersRuntimeAssets();

    expect(assets.map((asset) => asset.fileName)).toEqual([
      "ort-wasm-simd-threaded.asyncify.mjs",
      "ort-wasm-simd-threaded.asyncify.wasm",
    ]);
    for (const asset of assets) {
      expect(basename(asset.sourcePath)).toBe(asset.fileName);
      const minimumBytes = asset.fileName.endsWith(".wasm") ? 1_000_000 : 10_000;
      expect(readFileSync(asset.sourcePath).byteLength).toBeGreaterThan(minimumBytes);
    }
  });
});
