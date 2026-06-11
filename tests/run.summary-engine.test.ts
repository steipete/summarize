import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prompt } from "../src/llm/prompt.js";
import { createSummaryEngine } from "../src/run/summary-engine.js";
import type { ModelAttempt } from "../src/run/types.js";

const mocks = vi.hoisted(() => ({
  resolveModelIdForLlmCall: vi.fn(),
  summarizeWithModelId: vi.fn(),
}));

vi.mock("../src/run/summary-llm.js", () => ({
  resolveModelIdForLlmCall: mocks.resolveModelIdForLlmCall,
  summarizeWithModelId: mocks.summarizeWithModelId,
}));

function collectStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function createTestSummaryEngine(openaiUseChatCompletions: boolean | undefined) {
  return createSummaryEngine({
    env: {},
    envForRun: {},
    stdout: collectStream(),
    stderr: collectStream(),
    execFileImpl: vi.fn(),
    timeoutMs: 1000,
    retries: 0,
    streamingEnabled: false,
    plain: true,
    verbose: false,
    verboseColor: false,
    openaiUseChatCompletions,
    cliConfigForRun: null,
    cliAvailability: {},
    trackedFetch: globalThis.fetch.bind(globalThis),
    resolveMaxOutputTokensForCall: async () => null,
    resolveMaxInputTokensForCall: async () => null,
    llmCalls: [],
    clearProgressForStdout: () => {},
    apiKeys: {
      xaiApiKey: null,
      openaiApiKey: "oa-key",
      googleApiKey: null,
      anthropicApiKey: null,
      openrouterApiKey: "or-key",
    },
    keyFlags: {
      googleConfigured: false,
      anthropicConfigured: false,
      openrouterConfigured: true,
    },
    zai: {
      apiKey: null,
      baseUrl: "https://api.z.ai/api/paas/v4",
    },
    nvidia: {
      apiKey: null,
      baseUrl: "https://integrate.api.nvidia.com/v1",
    },
    ollama: {
      baseUrl: "http://localhost:11434/v1",
    },
    providerBaseUrls: {
      openai: null,
      anthropic: null,
      google: null,
      xai: null,
    },
  });
}

async function runAttempt(attempt: ModelAttempt, openaiUseChatCompletions: boolean | undefined) {
  const engine = createTestSummaryEngine(openaiUseChatCompletions);
  return engine.runSummaryAttempt({
    attempt,
    prompt: { userText: "Summarize this." } as Prompt,
    allowStreaming: false,
  });
}

beforeEach(() => {
  mocks.resolveModelIdForLlmCall.mockReset();
  mocks.summarizeWithModelId.mockReset();
  mocks.resolveModelIdForLlmCall.mockImplementation(
    async ({ parsedModel }: { parsedModel: { canonical: string } }) => ({
      modelId: parsedModel.canonical,
      note: null,
      forceStreamOff: false,
    }),
  );
  mocks.summarizeWithModelId.mockResolvedValue({
    text: "Summary.",
    provider: "openai",
    canonicalModelId: "openai/gpt-5.4",
    usage: null,
  });
});

describe("summary engine OpenAI chat-completions routing", () => {
  it("passes explicit false through for native OpenAI-compatible gateways", async () => {
    await runAttempt(
      {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
        openaiBaseUrlOverride: "https://gateway.example/v1",
      },
      false,
    );

    const call = mocks.summarizeWithModelId.mock.calls[0]?.[0] as {
      forceChatCompletions?: boolean;
      openaiBaseUrlOverride?: string | null;
    };
    expect(call.openaiBaseUrlOverride).toBe("https://gateway.example/v1");
    expect(call.forceChatCompletions).toBe(false);
  });

  it("does not apply the OpenAI chat-completions toggle to OpenRouter attempts", async () => {
    await runAttempt(
      {
        transport: "openrouter",
        userModelId: "openrouter/openai/gpt-5.4",
        llmModelId: "openai/openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: true,
        requiredEnv: "OPENROUTER_API_KEY",
      },
      false,
    );

    const call = mocks.summarizeWithModelId.mock.calls[0]?.[0] as {
      forceChatCompletions?: boolean;
      forceOpenRouter?: boolean;
    };
    expect(call.forceOpenRouter).toBe(true);
    expect(call.forceChatCompletions).toBeUndefined();
  });
});
