import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseRequestedModelId } from "../src/model-spec.js";

const mocks = vi.hoisted(() => ({
  createHtmlToMarkdownConverter: vi.fn(() => async () => "# Converted"),
}));

vi.mock("../src/llm/html-to-markdown.js", () => ({
  createHtmlToMarkdownConverter: mocks.createHtmlToMarkdownConverter,
}));

import { createMarkdownConverters } from "../src/run/flows/url/markdown.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

function sink() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function buildCtx(opts: {
  openaiRequestOptions?: { reasoningEffort?: "high" };
  openaiRequestOptionsOverride?: { serviceTier?: "fast" };
  cliReasoningEffortOverride?: "xhigh";
}): UrlFlowContext {
  const fixedModel = parseRequestedModelId("anthropic/claude-sonnet-4-5");
  if (fixedModel.kind !== "fixed" || fixedModel.transport !== "native") {
    throw new Error("expected fixed native anthropic model");
  }
  return {
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
        apiKey: null,
        anthropicApiKey: "sk-test",
        openrouterApiKey: null,
        openrouterConfigured: false,
        googleConfigured: false,
        anthropicConfigured: true,
        zaiApiKey: null,
        zaiBaseUrl: "",
        nvidiaApiKey: null,
        nvidiaBaseUrl: "",
        ollamaBaseUrl: "",
        providerBaseUrls: {
          openai: null,
          anthropic: null,
          google: null,
          xai: null,
        },
      },
      openaiUseChatCompletions: false,
      openaiRequestOptions: opts.openaiRequestOptions,
      openaiRequestOptionsOverride: opts.openaiRequestOptionsOverride,
      cliReasoningEffortOverride: opts.cliReasoningEffortOverride,
      llmCalls: [],
    },
  } as unknown as UrlFlowContext;
}

describe("URL markdown anthropic routing", () => {
  it("scopes openai-only request options away from anthropic markdown calls", () => {
    mocks.createHtmlToMarkdownConverter.mockClear();
    const ctx = buildCtx({
      openaiRequestOptions: { reasoningEffort: "high" },
      openaiRequestOptionsOverride: { serviceTier: "fast" },
    });

    createMarkdownConverters(ctx, { isYoutubeUrl: false });

    expect(mocks.createHtmlToMarkdownConverter).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: expect.stringContaining("anthropic"),
        requestOptions: undefined,
      }),
    );
  });

  it("forwards an explicit CLI --thinking override to anthropic markdown calls", () => {
    mocks.createHtmlToMarkdownConverter.mockClear();
    const ctx = buildCtx({
      openaiRequestOptions: { reasoningEffort: "high" },
      cliReasoningEffortOverride: "xhigh",
    });

    createMarkdownConverters(ctx, { isYoutubeUrl: false });

    expect(mocks.createHtmlToMarkdownConverter).toHaveBeenCalledWith(
      expect.objectContaining({
        requestOptions: { reasoningEffort: "xhigh" },
      }),
    );
  });
});
