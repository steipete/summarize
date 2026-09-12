import { describe, expect, it } from "vitest";
import { createVitestConfig, resolveMaxThreads } from "../vitest.config.js";

describe("vitest config", () => {
  it("uses positive integer thread overrides", () => {
    expect(resolveMaxThreads("1", 16)).toBe(1);
    expect(resolveMaxThreads(" 3 ", 16)).toBe(3);
  });

  it.each(["", "0", "-1", "1.5", "1e2", "0x10", "2 threads", "999999999999999999999"])(
    "ignores invalid VITEST_MAX_THREADS=%j",
    (raw) => {
      expect(resolveMaxThreads(raw, 16)).toBe(8);
    },
  );

  it.each([1, 2, 3])("does not oversubscribe a %i-CPU machine by default", (availableCpus) => {
    expect(resolveMaxThreads(undefined, availableCpus)).toBe(availableCpus);
    expect(resolveMaxThreads("invalid", availableCpus)).toBe(availableCpus);
  });

  it("wires VITEST_MAX_THREADS into maxWorkers", () => {
    const config = createVitestConfig({
      env: { VITEST_MAX_THREADS: "1" },
      availableCpus: 16,
    });

    expect(config.test?.maxWorkers).toBe(1);
    expect("poolOptions" in config).toBe(false);
  });

  it("uses the provided env for CI coverage reporters", () => {
    expect(createVitestConfig({ env: {} }).test?.coverage?.reporter).toEqual([
      "text",
      "json-summary",
    ]);
    expect(createVitestConfig({ env: { CI: "1" } }).test?.coverage?.reporter).toEqual([
      "text",
      "json-summary",
      "html",
    ]);
  });

  it("collects coverage from CLI and core package sources", () => {
    expect(createVitestConfig({ env: {} }).test?.coverage?.include).toEqual([
      "src/**/*.ts",
      "packages/core/src/**/*.ts",
    ]);
  });

  it("excludes browser content scripts from node coverage", () => {
    const exclude = createVitestConfig({ env: {} }).test?.coverage?.exclude;
    expect(exclude).toContain("apps/chrome-extension/**");
  });

  it("excludes generated and external-process adapters from unit coverage", () => {
    const exclude = createVitestConfig({ env: {} }).test?.coverage?.exclude;
    expect(exclude).toContain("packages/core/src/ffmpeg-wasm/run-generated.ts");
    expect(exclude).toContain("packages/core/src/content/dns-pinned-fetch.ts");
    expect(exclude).toContain("packages/core/src/transcription/onnx-cli.ts");
    expect(exclude).toContain("packages/core/src/transcription/whisper/gemini.ts");
    expect(exclude).toContain("src/slides/scene-detection.ts");
  });

  it("enforces 85 percent global coverage", () => {
    expect(createVitestConfig({ env: {} }).test?.coverage?.thresholds).toEqual({
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85,
    });
  });
});
