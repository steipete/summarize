import { afterEach, describe, expect, it, vi } from "vitest";
import * as metricsModule from "../src/application/metrics.js";
import { createSummarizeModelResources } from "../src/application/model-runtime.js";
import { resolveSummarizeRun } from "../src/application/run-spec.js";
import * as executorModule from "../src/engine/model-executor.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";

afterEach(() => vi.restoreAllMocks());

describe("application model runtime", () => {
  it.each([false, true])(
    "shares resources with explicit metrics environment: %s",
    (explicitMetrics) => {
      const env = { OPENAI_API_KEY: "openai-key" };
      const metricsEnv = explicitMetrics ? { SUMMARIZE_DISABLE_PRICING: "1" } : undefined;
      const createMetrics = vi.spyOn(metricsModule, "createRunMetrics");
      const createExecutor = vi.spyOn(executorModule, "createModelExecutor");
      const resolvedRun = resolveSummarizeRun({
        env,
        request: {
          input: {
            kind: "visible-page",
            url: "https://example.com",
            title: null,
            text: "",
            truncated: false,
          },
          modelOverride: "openai/gpt-5.4",
          promptOverride: null,
          lengthRaw: "medium",
          languageRaw: null,
          format: "text",
          extractOnly: false,
          slides: null,
          overrides: {
            ...createEmptyRunOverrides(),
            timeoutMs: 1_000,
            retries: 2,
            maxOutputTokensArg: 512,
            autoCliFallbackEnabled: true,
            transcriber: "parakeet",
          },
        },
      });
      expect(createMetrics).not.toHaveBeenCalled();
      expect(createExecutor).not.toHaveBeenCalled();
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const execFileImpl = vi.fn();
      const summaryStream = { onChunk: vi.fn(), onReset: vi.fn() };
      const requestOptions = {
        openaiRequestOptions: { serviceTier: "fast" as const },
        cliReasoningEffortOverride: "high" as const,
      };
      const resources = createSummarizeModelResources({
        resolvedRun,
        env,
        metricsEnv,
        fetchImpl,
        execFileImpl,
        streamingEnabled: true,
        summaryStream,
        requestOptions,
      });
      const { model, runtime } = resources;
      expect(resources.context).toBe(resolvedRun.bindings.context);
      expect(resources.envForRun).toBe(resolvedRun.bindings.envForRun);
      expect(resources.envForRun.SUMMARIZE_TRANSCRIBER).toBe("parakeet");
      expect(createMetrics).toHaveBeenCalledExactlyOnceWith({
        env: metricsEnv ?? env,
        fetchImpl,
        maxOutputTokensArg: 512,
      });
      expect(createExecutor).toHaveBeenCalledTimes(1);
      expect(createExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          env,
          envForRun: resources.envForRun,
          execFileImpl,
          timeoutMs: 1_000,
          retries: 2,
          streamingEnabled: true,
          ...requestOptions,
          trackedFetch: runtime.metrics.trackedFetch,
          llmCalls: runtime.metrics.llmCalls,
        }),
      );
      expect(model.requestedModel).toMatchObject({ kind: "fixed", userModelId: "openai/gpt-5.4" });
      expect(model.requestedModel).toBe(resolvedRun.bindings.model.requestedModel);
      expect(model.fixedModelSpec).toBe(model.requestedModel);
      expect(model.desiredOutputTokens).toBe(512);
      expect(model).toMatchObject({ ...requestOptions, allowAutoCliFallback: true });
      expect(model.summaryStream).toBe(summaryStream);
      expect(model.apiStatus).toBe(runtime.apiStatus);
      expect(model.apiStatus.apiKey).toBe("openai-key");
      expect(model.summaryEngine).toBe(runtime.summaryEngine);
      expect(model.summaryEngine.envHasKeyFor("OPENAI_API_KEY")).toBe(true);
      expect(model.getLiteLlmCatalog).toBe(runtime.metrics.getLiteLlmCatalog);
      expect(model.llmCalls).toBe(runtime.metrics.llmCalls);
      expect(model.llmCalls).toEqual([]);
    },
  );
});
