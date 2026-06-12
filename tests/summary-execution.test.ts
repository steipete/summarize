import { describe, expect, it, vi } from "vitest";
import type { CacheStore } from "../src/cache.js";
import { executeSummaryAttempts } from "../src/run/summary-execution.js";
import type { ModelAttempt } from "../src/run/types.js";

const attempt: ModelAttempt = {
  transport: "native",
  userModelId: "test/model",
  llmModelId: "test/model",
  openrouterProviders: null,
  forceOpenRouter: false,
  requiredEnv: "OPENAI_API_KEY",
};

describe("executeSummaryAttempts", () => {
  it("normalizes cache hits without writing them back", async () => {
    const setText = vi.fn();
    const setJson = vi.fn();
    const store = {
      getText: vi.fn(() => "cached summary"),
      getJson: vi.fn(() => null),
      setText,
      setJson,
    } as unknown as CacheStore;
    const normalizeResult = vi.fn((result: { summary: string }) => ({
      summary: `${result.summary} normalized`,
    }));
    const runAttempt = vi.fn();

    const execution = await executeSummaryAttempts({
      attempts: [attempt],
      isFallbackModel: false,
      isNamedModelSelection: false,
      wantsFreeNamedModel: false,
      requestedModelInput: attempt.userModelId,
      envHasKeyFor: () => true,
      formatMissingModelError: () => "missing",
      cache: {
        store,
        ttlMs: 1000,
        contentHash: "content",
        promptHash: "prompt",
        lengthKey: "medium",
        languageKey: "auto",
        autoSelectionModel: null,
      },
      verbose: () => {},
      buildCachedResult: (_attempt, summary) => ({ summary }),
      runAttempt,
      normalizeResult,
      fetchImpl: fetch,
      timeoutMs: 1000,
    });

    expect(execution).toMatchObject({
      result: { summary: "cached summary normalized" },
      usedAttempt: attempt,
      summaryFromCache: true,
    });
    expect(normalizeResult).toHaveBeenCalledWith({ summary: "cached summary" }, attempt);
    expect(runAttempt).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(setJson).not.toHaveBeenCalled();
  });
});
