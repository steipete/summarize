import { describe, expect, it, vi } from "vitest";
import { parseRequestedModelId } from "../src/model-spec.js";
import { discardStream as sink } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  createLlmMarkdownConverters: vi.fn(() => ({
    html: async () => "# Converted",
    transcript: async () => "# Converted",
  })),
}));

vi.mock("../src/llm/markdown-converters.js", () => ({
  createLlmMarkdownConverters: mocks.createLlmMarkdownConverters,
}));

import { createMarkdownConverters } from "../src/run/flows/url/markdown.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

describe("URL markdown Ollama routing", () => {
  it("allows llm markdown with fixed Ollama models and forwards the Ollama base URL", () => {
    const fixedModel = parseRequestedModelId("ollama/qwen3:0.6b");
    if (fixedModel.kind !== "fixed" || fixedModel.transport !== "native") {
      throw new Error("expected fixed native Ollama model");
    }

    const ctx = {
      io: {
        env: {},
        envForRun: {},
        stdout: sink(),
        stderr: sink(),
        fetch: globalThis.fetch.bind(globalThis),
        execFileImpl: vi.fn(),
      },
      flags: {
        format: "markdown",
        markdownMode: "llm",
        transcriptTimestamps: false,
        preprocessMode: "off",
        retries: 0,
        verbose: false,
        verboseColor: false,
      },
      model: {
        requestedModel: fixedModel,
        fixedModelSpec: fixedModel,
        apiStatus: {
          xaiApiKey: null,
          googleApiKey: null,
          apiKey: "sk-openai",
          anthropicApiKey: null,
          openrouterApiKey: null,
          openrouterConfigured: false,
          googleConfigured: false,
          anthropicConfigured: false,
          zaiApiKey: null,
          zaiBaseUrl: "",
          nvidiaApiKey: null,
          nvidiaBaseUrl: "",
          ollamaBaseUrl: "http://ollama-box:11434/v1",
          providerBaseUrls: {
            openai: null,
            anthropic: null,
            google: null,
            xai: null,
          },
        },
        openaiUseChatCompletions: false,
        openaiRequestOptions: undefined,
        openaiRequestOptionsOverride: undefined,
        llmCalls: [],
        summaryEngine: {
          providerRuntime: {
            apiKeys: { ollama: null },
            baseUrls: { ollama: "http://ollama-box:11434/v1" },
          },
          envHasKeyFor: () => true,
        },
      },
    } as unknown as UrlFlowContext;

    const converters = createMarkdownConverters(ctx, { isYoutubeUrl: false });

    expect(converters.markdownProvider).toBe("ollama");
    expect(converters.convertHtmlToMarkdown).not.toBeNull();
    expect(mocks.createLlmMarkdownConverters).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "ollama/qwen3:0.6b",
        openaiApiKey: null,
        openaiBaseUrlOverride: "http://ollama-box:11434/v1",
        ollamaBaseUrlOverride: "http://ollama-box:11434/v1",
        forceChatCompletions: true,
      }),
    );
  });
});
