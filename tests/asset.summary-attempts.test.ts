import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAutoModelAttempts: vi.fn(),
  buildPathSummaryPrompt: vi.fn(() => "prompt"),
  ensureCliAttachmentPath: vi.fn(async () => "/tmp/assets/file.png"),
}));

vi.mock("../src/model-auto.js", () => ({
  buildAutoModelAttempts: mocks.buildAutoModelAttempts,
}));
vi.mock("../src/prompts/index.js", () => ({
  buildPathSummaryPrompt: mocks.buildPathSummaryPrompt,
}));
vi.mock("../src/run/attachments.js", () => ({
  ensureCliAttachmentPath: mocks.ensureCliAttachmentPath,
}));
import {
  buildAssetCliContext,
  buildAssetModelAttempts,
  filterUnsafeRemoteAssetCliAttempts,
} from "../src/run/flows/asset/summary-attempts.js";

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    isFallbackModel: true,
    getLiteLlmCatalog: vi.fn(async () => ({ catalog: [] })),
    desiredOutputTokens: 800,
    envForAuto: { OPENAI_API_KEY: "x" },
    configForModelSelection: null,
    cliAvailability: { gemini: true },
    isImplicitAutoSelection: true,
    allowAutoCliFallback: true,
    requestedModel: { kind: "auto" },
    summaryEngine: {
      providerRuntime: {
        apiKeys: {
          openai: "x",
          zai: "zai-key",
          nvidia: "nv-key",
          ollama: null,
        },
        baseUrls: {
          openai: "https://openai.example/v1",
          zai: "https://z.ai",
          nvidia: "https://nvidia",
          ollama: "http://ollama:11434/v1",
        },
      },
    },
    summaryStream: null,
    fixedModelSpec: null,
    apiStatus: {
      zaiApiKey: "zai-key",
      zaiBaseUrl: "https://z.ai",
      nvidiaApiKey: "nv-key",
      nvidiaBaseUrl: "https://nvidia",
      ollamaBaseUrl: "http://ollama:11434/v1",
    },
    outputLanguage: { kind: "auto" },
    promptOverride: null,
    lengthInstruction: null,
    languageInstruction: null,
    ...overrides,
  };
}

describe("asset summary attempts", () => {
  it("maps fallback auto attempts for native and cli transports", async () => {
    mocks.buildAutoModelAttempts.mockReturnValueOnce([
      {
        transport: "native",
        userModelId: "openai/gpt-5.4",
        llmModelId: "gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
      },
      {
        transport: "cli",
        userModelId: "cli/gemini/gemini-3-flash",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_GEMINI",
      },
    ]);

    const ctx = createContext();
    const attempts = await buildAssetModelAttempts({
      ctx: ctx as never,
      kind: "file",
      promptTokensForAuto: 1200,
      requiresVideoUnderstanding: false,
      lastSuccessfulCliProvider: "gemini",
    });

    expect(mocks.buildAutoModelAttempts).toHaveBeenCalled();
    expect(attempts[0]).toMatchObject({
      userModelId: "openai/gpt-5.4",
      openaiBaseUrlOverride: "https://openai.example/v1",
    });
    expect(attempts[1]).toMatchObject({
      transport: "cli",
      cliProvider: "gemini",
      cliModel: "gemini-3-flash",
    });
  });

  it("throws when a fixed spec is required but missing", async () => {
    await expect(
      buildAssetModelAttempts({
        ctx: createContext({ isFallbackModel: false, fixedModelSpec: null }) as never,
        kind: "file",
        promptTokensForAuto: null,
        requiresVideoUnderstanding: false,
        lastSuccessfulCliProvider: null,
      }),
    ).rejects.toThrow("Internal error: missing fixed model spec");
  });

  it("returns fixed cli attempts directly", async () => {
    const attempts = await buildAssetModelAttempts({
      ctx: createContext({
        isFallbackModel: false,
        fixedModelSpec: {
          transport: "cli",
          userModelId: "gemini/gemini-3-flash",
          cliProvider: "gemini",
          cliModel: "gemini-3-flash",
          requiredEnv: "GEMINI_API_KEY",
        },
      }) as never,
      kind: "image",
      promptTokensForAuto: null,
      requiresVideoUnderstanding: false,
      lastSuccessfulCliProvider: null,
    });

    expect(attempts).toEqual([
      {
        transport: "cli",
        userModelId: "gemini/gemini-3-flash",
        llmModelId: null,
        cliProvider: "gemini",
        cliModel: "gemini-3-flash",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "GEMINI_API_KEY",
      },
    ]);
  });

  it("routes fixed Z.ai, NVIDIA, and Ollama specs through runtime overrides", async () => {
    const zaiAttempts = await buildAssetModelAttempts({
      ctx: createContext({
        isFallbackModel: false,
        fixedModelSpec: {
          transport: "native",
          userModelId: "zai/gpt-oss",
          llmModelId: "zai/gpt-oss",
          provider: "zai",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "Z_AI_API_KEY",
        },
      }) as never,
      kind: "file",
      promptTokensForAuto: null,
      requiresVideoUnderstanding: false,
      lastSuccessfulCliProvider: null,
    });
    expect(zaiAttempts[0]).toMatchObject({
      userModelId: "zai/gpt-oss",
      openaiApiKeyOverride: "zai-key",
      openaiBaseUrlOverride: "https://z.ai",
      forceChatCompletions: true,
    });

    const nvidiaAttempts = await buildAssetModelAttempts({
      ctx: createContext({
        isFallbackModel: false,
        fixedModelSpec: {
          transport: "native",
          userModelId: "nvidia/llama",
          llmModelId: "nvidia/llama",
          provider: "nvidia",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "NVIDIA_API_KEY",
        },
      }) as never,
      kind: "file",
      promptTokensForAuto: null,
      requiresVideoUnderstanding: false,
      lastSuccessfulCliProvider: null,
    });
    expect(nvidiaAttempts[0]).toMatchObject({
      userModelId: "nvidia/llama",
      openaiApiKeyOverride: "nv-key",
      openaiBaseUrlOverride: "https://nvidia",
      forceChatCompletions: true,
    });

    const ollamaAttempts = await buildAssetModelAttempts({
      ctx: createContext({
        isFallbackModel: false,
        fixedModelSpec: {
          transport: "native",
          userModelId: "ollama/qwen3:0.6b",
          llmModelId: "ollama/qwen3:0.6b",
          provider: "ollama",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "OLLAMA_BASE_URL",
        },
      }) as never,
      kind: "file",
      promptTokensForAuto: null,
      requiresVideoUnderstanding: false,
      lastSuccessfulCliProvider: null,
    });
    expect(ollamaAttempts[0]).toMatchObject({
      userModelId: "ollama/qwen3:0.6b",
      openaiApiKeyOverride: null,
      openaiBaseUrlOverride: "http://ollama:11434/v1",
      forceChatCompletions: true,
    });
  });

  it("returns null cli context when cli transport or attachments are not eligible", async () => {
    const ctx = createContext();
    const baseArgs = {
      sourceKind: "file",
      sourceLabel: "/tmp/file.txt",
      attachment: {
        kind: "text",
        filename: "file.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array([1]),
      },
    };

    await expect(
      buildAssetCliContext({
        ctx: ctx as never,
        args: baseArgs as never,
        attempts: [{ transport: "native" }] as never,
        attachmentsCount: 1,
        summaryLengthTarget: { maxCharacters: 500 },
      }),
    ).resolves.toBeNull();
    await expect(
      buildAssetCliContext({
        ctx: ctx as never,
        args: baseArgs as never,
        attempts: [{ transport: "cli" }] as never,
        attachmentsCount: 0,
        summaryLengthTarget: { maxCharacters: 500 },
      }),
    ).resolves.toBeNull();
    await expect(
      buildAssetCliContext({
        ctx: ctx as never,
        args: baseArgs as never,
        attempts: [{ transport: "cli" }] as never,
        attachmentsCount: 1,
        summaryLengthTarget: { maxCharacters: 500 },
      }),
    ).resolves.toBeNull();
  });

  it("builds image cli context with provider-specific extra args", async () => {
    const ctx = createContext({
      promptOverride: "Override",
      lengthInstruction: "Short",
      languageInstruction: "German",
    });

    const result = await buildAssetCliContext({
      ctx: ctx as never,
      args: {
        sourceKind: "file",
        sourceLabel: "/tmp/file.png",
        attachment: {
          kind: "image",
          filename: "file.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
        },
      } as never,
      attempts: [{ transport: "cli" }] as never,
      attachmentsCount: 1,
      summaryLengthTarget: { maxCharacters: 900 },
    });

    expect(mocks.ensureCliAttachmentPath).toHaveBeenCalled();
    expect(mocks.buildPathSummaryPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kindLabel: "image",
        filePath: "/tmp/assets/file.png",
        outputLanguage: { kind: "auto" },
      }),
    );
    expect(result).toEqual({
      promptOverride: "prompt",
      allowTools: true,
      cwd: "/tmp/assets",
      extraArgsByProvider: {
        gemini: ["--include-directories", "/tmp/assets"],
        codex: ["-i", "/tmp/assets/file.png"],
        opencode: ["--file", "/tmp/assets/file.png"],
      },
    });
  });

  it("removes unsafe CLI providers and tool approval for remote binary attachments", async () => {
    const attempts = filterUnsafeRemoteAssetCliAttempts({
      attempts: [
        {
          transport: "native",
          userModelId: "openai/gpt-5.4",
          llmModelId: "gpt-5.4",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "OPENAI_API_KEY",
        },
        {
          transport: "cli",
          userModelId: "cli/claude/sonnet",
          llmModelId: null,
          cliProvider: "claude",
          cliModel: "sonnet",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "CLI_CLAUDE",
        },
        {
          transport: "cli",
          userModelId: "cli/codex/gpt-5.5",
          llmModelId: null,
          cliProvider: "codex",
          cliModel: "gpt-5.5",
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "CLI_CODEX",
        },
        {
          transport: "cli",
          userModelId: "cli/opencode",
          llmModelId: null,
          cliProvider: "opencode",
          cliModel: null,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: "CLI_OPENCODE",
        },
      ] as never,
      args: {
        sourceKind: "asset-url",
        sourceLabel: "https://example.com/file.png",
        attachment: {
          kind: "image",
          filename: "file.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
        },
      } as never,
    });

    expect(attempts.map((attempt) => attempt.userModelId)).toEqual([
      "openai/gpt-5.4",
      "cli/codex/gpt-5.5",
      "cli/opencode",
    ]);

    const result = await buildAssetCliContext({
      ctx: createContext() as never,
      args: {
        sourceKind: "asset-url",
        sourceLabel: "https://example.com/file.png",
        attachment: {
          kind: "image",
          filename: "file.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
        },
      } as never,
      attempts,
      attachmentsCount: 1,
      summaryLengthTarget: { maxCharacters: 900 },
    });

    expect(result).toEqual({
      promptOverride: "prompt",
      allowTools: false,
      cwd: undefined,
      extraArgsByProvider: {
        gemini: undefined,
        codex: ["-i", "/tmp/assets/file.png"],
        opencode: ["--file", "/tmp/assets/file.png"],
      },
    });
  });

  it("omits codex image args for non-image file attachments", async () => {
    const result = await buildAssetCliContext({
      ctx: createContext() as never,
      args: {
        sourceKind: "file",
        sourceLabel: "/tmp/file.pdf",
        attachment: {
          kind: "file",
          filename: "file.pdf",
          mediaType: "application/pdf",
          bytes: new Uint8Array([1]),
        },
      } as never,
      attempts: [{ transport: "cli" }] as never,
      attachmentsCount: 1,
      summaryLengthTarget: { maxCharacters: 900 },
    });

    expect(result?.extraArgsByProvider).toEqual({
      gemini: ["--include-directories", "/tmp/assets"],
      codex: undefined,
      opencode: ["--file", "/tmp/assets/file.png"],
    });
  });
});
