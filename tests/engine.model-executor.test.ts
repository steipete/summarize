import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFixedModelAttempt } from "../src/application/model-attempts.js";
import { hasEngineErrorCode } from "../src/engine/errors.js";
import { createModelExecutor } from "../src/engine/model-executor.js";
import type { ModelAttempt } from "../src/engine/types.js";
import type { Prompt } from "../src/llm/prompt.js";
import { parseRequestedModelId } from "../src/model-spec.js";

const mocks = vi.hoisted(() => ({
  resolveModelIdForLlmCall: vi.fn(),
  summarizeWithModelId: vi.fn(),
  streamTextWithModelId: vi.fn(),
}));

vi.mock("../src/llm/generate-text.js", () => ({
  streamTextWithModelId: mocks.streamTextWithModelId,
}));

vi.mock("../src/engine/model-call.js", () => ({
  resolveModelIdForLlmCall: mocks.resolveModelIdForLlmCall,
  summarizeWithModelId: mocks.summarizeWithModelId,
}));

function createTestModelExecutor(
  openaiUseChatCompletions: boolean | undefined,
  streamingEnabled = false,
) {
  return createModelExecutor({
    env: {},
    envForRun: {},
    execFileImpl: vi.fn(),
    timeoutMs: 1000,
    retries: 0,
    streamingEnabled,
    cliConfigForRun: null,
    cliAvailability: {},
    trackedFetch: globalThis.fetch.bind(globalThis),
    resolveMaxOutputTokensForCall: async () => null,
    resolveMaxInputTokensForCall: async () => null,
    llmCalls: [],
    providerRuntime: {
      apiKeys: {
        xai: null,
        openai: "oa-key",
        google: null,
        anthropic: null,
        zai: null,
        nvidia: null,
        minimax: "minimax-key",
        "github-copilot": null,
        ollama: null,
      },
      baseUrls: {
        xai: null,
        openai: null,
        google: null,
        anthropic: null,
        zai: "https://api.z.ai/api/paas/v4",
        nvidia: "https://integrate.api.nvidia.com/v1",
        minimax: "https://minimax.example.com/v1",
        "github-copilot": null,
        ollama: "http://localhost:11434/v1",
      },
      openaiUseChatCompletions,
    },
    openrouterApiKey: "or-key",
  });
}

async function runAttempt(attempt: ModelAttempt, openaiUseChatCompletions: boolean | undefined) {
  const engine = createTestModelExecutor(openaiUseChatCompletions);
  return engine.runSummaryAttempt({
    attempt,
    prompt: { userText: "Summarize this." } as Prompt,
    allowStreaming: false,
  });
}

function resolveTestFixedAttempt(
  engine: ReturnType<typeof createTestModelExecutor>,
  modelId: string,
): ModelAttempt {
  const requestedModel = parseRequestedModelId(modelId);
  if (requestedModel.kind !== "fixed") {
    throw new Error(`expected fixed model: ${modelId}`);
  }
  return resolveFixedModelAttempt({
    requestedModel,
    providerRuntime: engine.providerRuntime,
  });
}

beforeEach(() => {
  mocks.resolveModelIdForLlmCall.mockReset();
  mocks.summarizeWithModelId.mockReset();
  mocks.streamTextWithModelId.mockReset();
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

describe("model executor OpenAI chat-completions routing", () => {
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

  it("applies the dedicated MiniMax key and base URL", async () => {
    const engine = createTestModelExecutor(undefined);
    const attempt = resolveTestFixedAttempt(engine, "minimax/MiniMax-M3");
    await engine.runSummaryAttempt({
      attempt,
      prompt: { userText: "Summarize this." } as Prompt,
      allowStreaming: false,
    });

    const call = mocks.summarizeWithModelId.mock.calls[0]?.[0] as {
      apiKeys?: { openaiApiKey?: string | null };
      forceChatCompletions?: boolean;
      openaiBaseUrlOverride?: string | null;
    };
    expect(call.apiKeys?.openaiApiKey).toBe("minimax-key");
    expect(call.openaiBaseUrlOverride).toBe("https://minimax.example.com/v1");
    expect(call.forceChatCompletions).toBe(true);
  });

  it("does not forward the OpenAI key to Ollama", async () => {
    const engine = createTestModelExecutor(undefined);
    const attempt = resolveTestFixedAttempt(engine, "ollama/qwen3:8b");
    await engine.runSummaryAttempt({
      attempt,
      prompt: { userText: "Summarize this." } as Prompt,
      allowStreaming: false,
    });

    const call = mocks.summarizeWithModelId.mock.calls[0]?.[0] as {
      apiKeys?: { openaiApiKey?: string | null };
      openaiBaseUrlOverride?: string | null;
    };
    expect(call.apiKeys?.openaiApiKey).toBeNull();
    expect(call.openaiBaseUrlOverride).toBe("http://localhost:11434/v1");
  });
});

describe("model executor credential availability", () => {
  it("reads gateway, OpenRouter, Ollama, and CLI availability from resolved runtime inputs", () => {
    const engine = createTestModelExecutor(undefined);

    expect(engine.envHasKeyFor("OPENAI_API_KEY")).toBe(true);
    expect(engine.envHasKeyFor("MINIMAX_API_KEY")).toBe(true);
    expect(engine.envHasKeyFor("OPENROUTER_API_KEY")).toBe(true);
    expect(engine.envHasKeyFor("OLLAMA_BASE_URL")).toBe(true);
    expect(engine.envHasKeyFor("GITHUB_TOKEN")).toBe(false);
    expect(engine.envHasKeyFor("CLI_CODEX")).toBe(false);
  });
});

describe("model executor streaming", () => {
  it("emits structured chunks without owning output", async () => {
    async function* textStream() {
      yield "Hello";
      yield " world";
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const onChunk = vi.fn(() => true);
    const onDone = vi.fn(() => false);
    const onReset = vi.fn();

    const engine = createTestModelExecutor(undefined, true);
    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
      streamHandler: { onChunk, onDone, onReset },
    });

    expect(result.summary).toBe("Hello world");
    expect(result.summaryEmitted).toBe(true);
    expect(onChunk.mock.calls.map(([chunk]) => chunk.appended)).toEqual(["Hello", " world"]);
    expect(onDone).toHaveBeenCalledWith("Hello world");
  });

  it("can consume a stream only for its final value", async () => {
    async function* textStream() {
      yield "Final";
      yield " value";
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });

    const engine = createTestModelExecutor(undefined, true);
    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
    });

    expect(result).toMatchObject({ summary: "Final value", summaryEmitted: false });
  });

  it("restores a repeated delta suffix from the authoritative final text", async () => {
    async function* textStream() {
      yield "repeat";
      yield "repeat";
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve("repeatrepeat"),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });

    const engine = createTestModelExecutor(undefined, true);
    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
    });

    expect(result).toMatchObject({ summary: "repeatrepeat", summaryEmitted: false });
  });

  it("emits authoritative final text when the stream has no deltas", async () => {
    async function* textStream() {}
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve("Recovered summary"),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const onChunk = vi.fn(() => true);
    const onDone = vi.fn(() => false);
    const onReset = vi.fn();

    const engine = createTestModelExecutor(undefined, true);
    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
      streamHandler: { onChunk, onDone, onReset },
    });

    expect(result).toMatchObject({ summary: "Recovered summary", summaryEmitted: true });
    expect(onChunk).toHaveBeenCalledWith({
      streamed: "Recovered summary",
      prevStreamed: "",
      appended: "Recovered summary",
    });
    expect(onDone).toHaveBeenCalledWith("Recovered summary");
  });

  it("emits a complete fallback after an invisible stream prefix", async () => {
    async function* textStream() {
      yield "\n";
      throw new Error("Streaming timed out");
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    mocks.summarizeWithModelId.mockResolvedValue({
      text: "Fallback summary.",
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      usage: null,
    });
    const onChunk = vi.fn(() => true);
    const onDone = vi.fn(() => false);
    const onReset = vi.fn();

    const engine = createTestModelExecutor(undefined, true);
    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
      streamHandler: { onChunk, onDone, onReset },
    });

    expect(result).toMatchObject({
      summary: "Fallback summary.",
      summaryEmitted: true,
    });
    expect(onChunk).toHaveBeenCalledWith({
      streamed: "Fallback summary.",
      prevStreamed: "",
      appended: "Fallback summary.",
    });
    expect(onDone).toHaveBeenCalledWith("Fallback summary.");
  });

  it("stops fallback after visible stream output", async () => {
    async function* textStream() {
      yield "Partial";
      throw new Error("connection closed");
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const engine = createTestModelExecutor(undefined, true);

    const error = await engine
      .runSummaryAttempt({
        attempt: {
          transport: "native",
          userModelId: "openai/gpt-5.4",
          llmModelId: "openai/gpt-5.4",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "OPENAI_API_KEY",
        },
        prompt: { userText: "Summarize this." },
        allowStreaming: true,
        streamHandler: { onChunk: vi.fn(() => true), onReset: vi.fn() },
      })
      .catch((caught) => caught);

    expect(hasEngineErrorCode(error, "SUMMARY_STREAM_INTERRUPTED")).toBe(true);
  });

  it("resets buffered output and allows model fallback before anything is emitted", async () => {
    async function* textStream() {
      yield "Buffered";
      throw new Error("connection closed");
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const onChunk = vi.fn(() => false);
    const onReset = vi.fn();
    const engine = createTestModelExecutor(undefined, true);

    await expect(
      engine.runSummaryAttempt({
        attempt: {
          transport: "native",
          userModelId: "openai/gpt-5.4",
          llmModelId: "openai/gpt-5.4",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "OPENAI_API_KEY",
        },
        prompt: { userText: "Summarize this." },
        allowStreaming: true,
        streamHandler: { onChunk, onReset },
      }),
    ).rejects.toThrow("connection closed");
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("stops model fallback when stream finalization fails", async () => {
    async function* textStream() {
      yield "Complete summary";
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const engine = createTestModelExecutor(undefined, true);

    const error = await engine
      .runSummaryAttempt({
        attempt: {
          transport: "native",
          userModelId: "openai/gpt-5.4",
          llmModelId: "openai/gpt-5.4",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "OPENAI_API_KEY",
        },
        prompt: { userText: "Summarize this." },
        allowStreaming: true,
        streamHandler: {
          onChunk: vi.fn(() => true),
          onDone: vi.fn(() => {
            throw new Error("output closed");
          }),
          onReset: vi.fn(),
        },
      })
      .catch((caught) => caught);

    expect(hasEngineErrorCode(error, "SUMMARY_STREAM_INTERRUPTED")).toBe(true);
    expect(error).toMatchObject({ message: "output closed" });
  });

  it("does not report output for a non-emitting stream handler", async () => {
    async function* textStream() {
      yield "Buffered summary";
    }
    mocks.streamTextWithModelId.mockResolvedValue({
      textStream: textStream(),
      usage: Promise.resolve(null),
      finalText: Promise.resolve(null),
      provider: "openai",
      canonicalModelId: "openai/gpt-5.4",
      lastError: () => null,
    });
    const engine = createTestModelExecutor(undefined, true);

    const result = await engine.runSummaryAttempt({
      attempt: {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      prompt: { userText: "Summarize this." },
      allowStreaming: true,
      streamHandler: { onChunk: vi.fn(() => false), onReset: vi.fn() },
    });

    expect(result).toMatchObject({
      summary: "Buffered summary",
      summaryEmitted: false,
    });
  });
});
