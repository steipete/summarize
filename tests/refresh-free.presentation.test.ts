import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { BenchmarkedOpenRouterModel } from "../src/refresh-free/benchmark.js";
import {
  formatRefreshFreeDuration,
  RefreshFreeReporter,
} from "../src/refresh-free/presentation.js";

function createCaptureStream(isTTY = false) {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = isTTY;
  return { stream, output: () => output };
}

function model(): BenchmarkedOpenRouterModel {
  return {
    openrouterModelId: "vendor/model:free",
    initialLatencyMs: 100,
    medianLatencyMs: 100,
    totalLatencyMs: 300,
    successCount: 3,
    contextLength: 131_072,
    maxCompletionTokens: 8192,
    supportedParametersCount: 2,
    modality: "text",
    inferredParamB: 70,
  };
}

describe("refresh-free presentation", () => {
  it("preserves provider errors and model IDs in Turkish mode", () => {
    const capture = createCaptureStream();
    const reporter = new RefreshFreeReporter({
      stderr: capture.stream,
      env: { SUMMARIZE_LOCALE: "tr" },
      verbose: true,
    });
    reporter.benchmarkFailure({
      modelId: "old:free",
      kind: "providerError",
      message: "Copy failed: /Projects (old)/cache.json",
    });
    expect(capture.output()).toContain(
      "old:free (providerError): Copy failed: /Projects (old)/cache.json",
    );
  });

  it("formats benchmark durations", () => {
    expect(formatRefreshFreeDuration(149)).toBe("149ms");
    expect(formatRefreshFreeDuration(1550)).toBe("1.6s");
    expect(formatRefreshFreeDuration(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  it("reports filters, benchmark results, and selected metadata", () => {
    const capture = createCaptureStream();
    const reporter = new RefreshFreeReporter({
      stderr: capture.stream,
      env: {},
      verbose: true,
    });

    reporter.fetchingCatalog();
    reporter.filteredOldModels({ count: 1, total: 3, maxAgeDays: 180, ids: ["old:free"] });
    reporter.filteredSmallModels({ count: 1, total: 2, minParamB: 27, ids: ["small:free"] });
    reporter.benchmarkStarting({ modelCount: 1, totalRuns: 2, concurrency: 4, timeoutMs: 10_000 });
    reporter.benchmarkSuccess({ modelId: "vendor/model:free", latencyMs: 100 });
    reporter.benchmarkFailure({
      modelId: "broken:free",
      kind: "providerError",
      message: "failed",
    });
    reporter.benchmarkResults({
      workingCount: 1,
      testedCount: 2,
      failureCounts: {
        empty: 0,
        rateLimitMin: 1,
        rateLimitDay: 1,
        noProviders: 0,
        timeout: 0,
        providerError: 0,
        other: 0,
      },
    });
    reporter.selected(1);
    reporter.selectedModels(["vendor/model:free"], [model()]);

    expect(capture.output()).toContain("skip old:free");
    expect(capture.output()).toContain("fail broken:free (providerError): failed");
    expect(capture.output()).toContain("rateLimitMin=1");
    expect(capture.output()).toContain("per-day free-model quota");
    expect(capture.output()).toContain("~70B ctx=128k out=8k text");
  });

  it("uses TTY redraws and color when forced", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const capture = createCaptureStream(true);
      const reporter = new RefreshFreeReporter({
        stderr: capture.stream,
        env: { FORCE_COLOR: "1" },
        verbose: false,
      });

      reporter.benchmarkProgress({ done: 1, total: 2, okCount: 1, elapsedMs: 1000 });
      reporter.cooldown(65_000);
      reporter.benchmarkFinished();

      expect(capture.output()).toContain("\u001b[2K\rRefresh Free: tested");
      expect(capture.output()).toContain("\u001b[2m");
    } finally {
      vi.useRealTimers();
    }
  });
});
