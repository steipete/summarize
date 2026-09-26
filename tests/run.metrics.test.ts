import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunMetrics } from "../src/application/metrics.js";

describe("run metrics cost estimation", () => {
  it("estimates GPT-6 costs and limits without a pricing cache or network call", async () => {
    const fetchImpl = vi.fn();
    const metrics = createRunMetrics({ env: {}, fetchImpl, maxOutputTokensArg: 200_000 });
    metrics.llmCalls.push({
      provider: "openai",
      model: "openai/gpt-6-sol",
      usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      purpose: "summary",
    });
    await expect(metrics.estimateCostUsd()).resolves.toBeCloseTo(0.003);
    await expect(metrics.resolveMaxInputTokensForCall("openai/gpt-6-sol")).resolves.toBe(922_000);
    await expect(metrics.resolveMaxOutputTokensForCall("openai/gpt-6-sol")).resolves.toBe(128_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps the total unknown when any billable call lacks usage and an explicit cost", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push(
        {
          provider: "cli",
          model: "cli/codex",
          usage: null,
          costUsd: 0.25,
          purpose: "summary",
        },
        {
          provider: "openai",
          model: "openai/gpt-5.5",
          usage: null,
          purpose: "speaker-identification",
        },
      );

      await expect(metrics.estimateCostUsd()).resolves.toBeNull();
      metrics.llmCalls.pop();
      await expect(metrics.estimateCostUsd()).resolves.toBe(0.25);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps Ollama calls unknown without an explicit verified cost", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push({
        provider: "ollama",
        model: "ollama/llama3.2",
        usage: null,
        purpose: "summary",
      });
      metrics.setTranscriptionCost(0.4, "$0.40 tx");

      await expect(metrics.estimateCostUsd()).resolves.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses an explicit verified zero cost for free-model calls", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push({
        provider: "openai",
        model: "openai/xiaomi/mimo-v2-flash:free",
        usage: null,
        costUsd: 0,
        purpose: "summary",
      });
      metrics.setTranscriptionCost(0.4, "$0.40 tx");

      await expect(metrics.estimateCostUsd()).resolves.toBe(0.4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the total unknown when a free call accompanies an unpriced paid call", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    const addCalls = (metrics: ReturnType<typeof createRunMetrics>) => {
      metrics.llmCalls.push(
        {
          provider: "ollama",
          model: "ollama/llama3.2",
          usage: null,
          costUsd: 0,
          purpose: "summary",
        },
        {
          provider: "openai",
          model: "openai/model-not-in-catalog",
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          purpose: "speaker-identification",
        },
      );
      metrics.setTranscriptionCost(0.4, "$0.40 tx");
    };
    try {
      const withoutCatalog = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      addCalls(withoutCatalog);
      await expect(withoutCatalog.estimateCostUsd()).resolves.toBeNull();

      const cacheDir = join(home, ".summarize", "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "litellm-model_prices_and_context_window.json"), "{}");
      const missingFromCatalog = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      addCalls(missingFromCatalog);
      await expect(missingFromCatalog.estimateCostUsd()).resolves.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
