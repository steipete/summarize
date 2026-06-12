import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type TransformersRuntimeAsset = {
  fileName: string;
  sourcePath: string;
};

export function resolveTransformersRuntimeAssets(): TransformersRuntimeAsset[] {
  const transformersEntry = require.resolve("@huggingface/transformers");
  const dependencyRequire = createRequire(transformersEntry);

  return [
    {
      fileName: "ort-wasm-simd-threaded.asyncify.mjs",
      sourcePath: dependencyRequire.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
    },
    {
      fileName: "ort-wasm-simd-threaded.asyncify.wasm",
      sourcePath: dependencyRequire.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"),
    },
  ];
}
