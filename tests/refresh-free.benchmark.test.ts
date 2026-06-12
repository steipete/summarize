import { describe, expect, it, vi } from "vitest";
import {
  benchmarkOpenRouterModels,
  classifyBenchmarkFailure,
  refineBenchmarkCandidates,
  selectBenchmarkCandidates,
  type BenchmarkedOpenRouterModel,
} from "../src/refresh-free/benchmark.js";
import type { OpenRouterModelEntry } from "../src/refresh-free/catalog.js";

function catalogModel(id: string): OpenRouterModelEntry {
  return {
    id,
    contextLength: 8192,
    maxCompletionTokens: 1024,
    supportedParametersCount: 2,
    modality: "text",
    inferredParamB: 70,
    createdAtMs: 1,
  };
}

function benchmarkModel(
  id: string,
  overrides: Partial<BenchmarkedOpenRouterModel> = {},
): BenchmarkedOpenRouterModel {
  return {
    openrouterModelId: id,
    initialLatencyMs: 100,
    medianLatencyMs: 100,
    totalLatencyMs: 100,
    successCount: 1,
    contextLength: 8192,
    maxCompletionTokens: 1024,
    supportedParametersCount: 2,
    modality: "text",
    inferredParamB: 70,
    ...overrides,
  };
}

describe("refresh-free benchmark", () => {
  it("classifies provider failures", () => {
    expect(classifyBenchmarkFailure("empty summary")).toBe("empty");
    expect(classifyBenchmarkFailure("Rate limit exceeded: per-day")).toBe("rateLimitDay");
    expect(classifyBenchmarkFailure("Rate limit exceeded")).toBe("rateLimitMin");
    expect(classifyBenchmarkFailure("No allowed providers are available")).toBe("noProviders");
    expect(classifyBenchmarkFailure("request timed out")).toBe("timeout");
    expect(classifyBenchmarkFailure("provider returned error")).toBe("providerError");
    expect(classifyBenchmarkFailure("unknown")).toBe("other");
  });

  it("benchmarks concurrently while preserving result metadata", async () => {
    let nowMs = 0;
    const generate = vi.fn(async () => {
      nowMs += 10;
      return { text: "OK" };
    });
    const progress = vi.fn();
    const success = vi.fn();

    const result = await benchmarkOpenRouterModels({
      models: [catalogModel("a:free"), catalogModel("b:free")],
      openrouterKey: "key",
      concurrency: 2,
      timeoutMs: 100,
      fetchImpl: fetch,
      generate,
      now: () => nowMs,
      onProgress: progress,
      onSuccess: success,
    });

    expect(result.working).toHaveLength(2);
    expect(result.testedCount).toBe(2);
    expect(result.failureCounts).toEqual({
      empty: 0,
      rateLimitMin: 0,
      rateLimitDay: 0,
      noProviders: 0,
      timeout: 0,
      providerError: 0,
      other: 0,
    });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenCalledTimes(2);
  });

  it("applies a global cooldown and retries per-minute limits once", async () => {
    let nowMs = 10_000;
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Rate limit exceeded"))
      .mockResolvedValueOnce({ text: "OK" });
    const cooldown = vi.fn();

    const result = await benchmarkOpenRouterModels({
      models: [catalogModel("a:free")],
      openrouterKey: "key",
      concurrency: 1,
      timeoutMs: 100,
      fetchImpl: fetch,
      cooldownMs: 65_000,
      generate,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      onCooldown: cooldown,
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(cooldown).toHaveBeenCalledWith(65_000);
    expect(result.working).toHaveLength(1);
    expect(result.failureCounts.rateLimitMin).toBe(1);
  });

  it("selects smart candidates first, then fills by reliability and speed", () => {
    const selected = selectBenchmarkCandidates(
      [
        benchmarkModel("fast", { medianLatencyMs: 1, contextLength: 100 }),
        benchmarkModel("smart", { medianLatencyMs: 20, contextLength: 1000 }),
        benchmarkModel("reliable", { medianLatencyMs: 10, successCount: 3, contextLength: 10 }),
      ],
      { smart: 1, maxCandidates: 3 },
    );

    expect(selected).toEqual(["smart", "reliable", "fast"]);
  });

  it("refines latency and success counts for selected candidates", async () => {
    let nowMs = 0;
    const generate = vi.fn(async () => {
      nowMs += 20;
      return { text: "OK" };
    });
    const working = [benchmarkModel("a:free")];

    const refined = await refineBenchmarkCandidates({
      working,
      selectedIds: ["a:free"],
      extraRuns: 2,
      openrouterKey: "key",
      timeoutMs: 100,
      fetchImpl: fetch,
      generate,
      now: () => nowMs,
    });

    expect(refined[0]).toMatchObject({
      successCount: 3,
      medianLatencyMs: 20,
      totalLatencyMs: 140,
    });
  });
});
