import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Tool } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeAgentResponse, streamAgentResponse } from "../src/daemon/agent.js";
import { runCliModel } from "../src/llm/cli.js";
import * as modelAuto from "../src/model-auto.js";
import { makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const { mockCompleteSimple, mockGetModel, mockStreamSimple } = vi.hoisted(() => ({
  mockCompleteSimple: vi.fn(),
  mockGetModel: vi.fn(),
  mockStreamSimple: vi.fn(),
}));

vi.mock("../src/llm/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/cli.js")>();
  return {
    ...actual,
    runCliModel: vi.fn(async () => ({ text: "cli agent", usage: null, costUsd: null })),
  };
});

vi.mock("@mariozechner/pi-ai", () => {
  return {
    completeSimple: mockCompleteSimple,
    getModel: mockGetModel,
    streamSimple: mockStreamSimple,
  };
});

const buildAssistant = (
  provider: string,
  model: string,
  api: "openai-completions" | "openai-responses" = "openai-completions",
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api,
  provider,
  model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const makeModel = (provider: string, modelId: string) => ({
  id: modelId,
  name: modelId,
  provider,
  api: (provider === "openai" ? "openai-responses" : "openai-completions") as const,
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
});

const makeTempHome = () => mkdtempSync(join(tmpdir(), "summarize-daemon-agent-"));

const makeFakeCliBin = (binary: string) => {
  const dir = mkdtempSync(join(tmpdir(), `summarize-daemon-cli-${binary}-`));
  const file = join(dir, binary);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return { dir, file };
};

beforeEach(() => {
  mockCompleteSimple.mockReset();
  mockGetModel.mockReset();
  mockStreamSimple.mockReset();
  vi.mocked(runCliModel).mockReset();
  vi.mocked(runCliModel).mockResolvedValue({ text: "cli agent", usage: null, costUsd: null });
  mockGetModel.mockImplementation((provider: string, modelId: string) =>
    makeModel(provider, modelId),
  );
  mockCompleteSimple.mockImplementation(
    async (model: {
      provider: string;
      id: string;
      api?: "openai-completions" | "openai-responses";
    }) => buildAssistant(model.provider, model.id, model.api),
  );
  mockStreamSimple.mockImplementation(
    (model: { provider: string; id: string; api?: "openai-completions" | "openai-responses" }) =>
      makeTextDeltaStream(["ok"], buildAssistant(model.provider, model.id, model.api)),
  );
});

describe("daemon/agent", () => {
  it("passes openrouter api key to pi-ai when using openrouter models", async () => {
    const home = makeTempHome();
    await completeAgentResponse({
      env: { HOME: home, OPENROUTER_API_KEY: "or-key" },
      pageUrl: "https://example.com",
      pageTitle: "Example",
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openrouter/openai/gpt-5-mini",
      tools: [],
      automationEnabled: false,
    });

    const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string };
    expect(options.apiKey).toBe("or-key");
  });

  it("passes openai api key to pi-ai for openai models", async () => {
    const home = makeTempHome();
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: [],
      automationEnabled: false,
    });

    const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string };
    expect(options.apiKey).toBe("sk-openai");
  });

  it("forces chat completions for streaming agent responses via OPENAI_USE_CHAT_COMPLETIONS", async () => {
    const home = makeTempHome();
    const chunks: string[] = [];

    await streamAgentResponse({
      env: {
        HOME: home,
        OPENAI_API_KEY: "sk-openai",
        OPENAI_USE_CHAT_COMPLETIONS: "1",
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: [],
      automationEnabled: false,
      onChunk: (text) => chunks.push(text),
      onAssistant: () => {},
    });

    const model = mockStreamSimple.mock.calls[0]?.[0] as { api?: string };
    expect(model.api).toBe("openai-completions");
    expect(chunks.join("")).toBe("ok");
  });

  it("forces chat completions for agent responses via config", async () => {
    const home = makeTempHome();
    const configDir = join(home, ".summarize");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ openai: { useChatCompletions: true } }),
      "utf8",
    );

    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: [],
      automationEnabled: false,
    });

    const model = mockCompleteSimple.mock.calls[0]?.[0] as { api?: string };
    expect(model.api).toBe("openai-completions");
  });

  it("uses chat completions for custom OpenAI-compatible base URLs", async () => {
    const home = makeTempHome();

    await completeAgentResponse({
      env: {
        HOME: home,
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "http://127.0.0.1:1234/v1",
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: [],
      automationEnabled: false,
    });

    const model = mockCompleteSimple.mock.calls[0]?.[0] as { api?: string; baseUrl?: string };
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("throws a helpful error when openrouter key is missing", async () => {
    const home = makeTempHome();
    await expect(
      completeAgentResponse({
        env: { HOME: home },
        pageUrl: "https://example.com",
        pageTitle: null,
        pageContent: "Hello world",
        messages: [{ role: "user", content: "Hi" }],
        modelOverride: "openrouter/openai/gpt-5-mini",
        tools: [],
        automationEnabled: false,
      }),
    ).rejects.toThrow(/Missing OPENROUTER_API_KEY/);
  });

  it("includes summarize tool definitions when automation is enabled", async () => {
    const home = makeTempHome();
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: ["summarize"],
      automationEnabled: true,
    });

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] };
    expect(context.tools?.some((tool) => tool.name === "summarize")).toBe(true);
  });

  it("exposes artifacts tool definitions when automation is enabled", async () => {
    const home = makeTempHome();
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: ["artifacts"],
      automationEnabled: true,
    });

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] };
    const artifacts = context.tools?.find((tool) => tool.name === "artifacts");
    expect(artifacts).toBeTruthy();
    const properties = (artifacts?.parameters as { properties?: Record<string, unknown> })
      ?.properties;
    const content = properties?.content as { type?: unknown; description?: string } | undefined;
    expect(content?.type).toBe("string");
    expect(content?.description).toMatch(/serialized JSON as a string/i);
  });

  it("navigate tool exposes listTabs and switchToTab parameters", async () => {
    const home = makeTempHome();
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      tools: ["navigate"],
      automationEnabled: true,
    });

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] };
    const navigate = context.tools?.find((tool) => tool.name === "navigate");
    const properties = (navigate?.parameters as { properties?: Record<string, unknown> })
      ?.properties;
    expect(properties && "listTabs" in properties).toBe(true);
    expect(properties && "switchToTab" in properties).toBe(true);
  });

  it("accepts legacy OpenRouter env mapping for auto fallback attempts", async () => {
    const home = makeTempHome();
    const autoSpy = vi.spyOn(modelAuto, "buildAutoModelAttempts").mockReturnValue([
      {
        transport: "openrouter",
        userModelId: "openrouter/openai/gpt-5-mini",
        llmModelId: "openai/openai/gpt-5-mini",
        openrouterProviders: null,
        forceOpenRouter: true,
        requiredEnv: "OPENROUTER_API_KEY",
        debug: "test",
      },
    ]);

    try {
      await completeAgentResponse({
        env: {
          HOME: home,
          OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
          OPENAI_API_KEY: "sk-openrouter-via-openai",
        },
        pageUrl: "https://example.com",
        pageTitle: null,
        pageContent: "Hello world",
        messages: [{ role: "user", content: "Hi" }],
        modelOverride: null,
        tools: [],
        automationEnabled: false,
      });

      const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string };
      expect(options.apiKey).toBe("sk-openrouter-via-openai");
    } finally {
      autoSpy.mockRestore();
    }
  });

  it("runs fixed CLI agent models through the CLI transport", async () => {
    const home = makeTempHome();

    const assistant = await completeAgentResponse({
      env: { HOME: home },
      pageUrl: "https://example.com",
      pageTitle: "Example",
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "cli/codex/gpt-5.2",
      tools: [],
      automationEnabled: false,
    });

    expect(runCliModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.2",
        allowTools: false,
      }),
    );
    const args = vi.mocked(runCliModel).mock.calls[0]?.[0] as { prompt: string };
    expect(args.prompt).toContain("You are Summarize Chat, not Claude.");
    expect(args.prompt).toContain("User: Hi");
    expect(mockCompleteSimple).not.toHaveBeenCalled();
    expect(assistant.content).toBe("cli agent");
  });

  it("falls back to CLI auto attempts when no API-key agent model is available", async () => {
    const home = makeTempHome();
    const fakeCodex = makeFakeCliBin("codex");
    const autoSpy = vi.spyOn(modelAuto, "buildAutoModelAttempts").mockReturnValue([
      {
        transport: "cli",
        userModelId: "cli/codex/gpt-5.2",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_CODEX",
        debug: "cli fallback",
      },
    ]);

    try {
      const assistant = await completeAgentResponse({
        env: { HOME: home, PATH: fakeCodex.dir },
        pageUrl: "https://example.com",
        pageTitle: null,
        pageContent: "Hello world",
        messages: [{ role: "user", content: "Hi" }],
        modelOverride: null,
        tools: [],
        automationEnabled: false,
      });

      expect(runCliModel).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "codex",
          model: "gpt-5.2",
        }),
      );
      expect(mockCompleteSimple).not.toHaveBeenCalled();
      expect(assistant.content).toBe("cli agent");
    } finally {
      autoSpy.mockRestore();
    }
  });

  it("explains missing env and CLI availability when no auto agent model is usable", async () => {
    const home = makeTempHome();
    const autoSpy = vi.spyOn(modelAuto, "buildAutoModelAttempts").mockReturnValue([
      {
        transport: "native",
        userModelId: "google/gemini-3-flash",
        llmModelId: "google/gemini-3-flash",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "GEMINI_API_KEY",
        debug: "google first",
      },
      {
        transport: "cli",
        userModelId: "cli/codex/gpt-5.2",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_CODEX",
        debug: "cli fallback",
      },
    ]);

    try {
      await expect(
        completeAgentResponse({
          env: { HOME: home, PATH: "" },
          pageUrl: "https://example.com",
          pageTitle: null,
          pageContent: "Hello world",
          messages: [{ role: "user", content: "Hi" }],
          modelOverride: null,
          tools: [],
          automationEnabled: false,
        }),
      ).rejects.toThrow(
        /No model available for agent\..*Checked: google\/gemini-3-flash, cli\/codex\/gpt-5\.2\..*Missing env: GEMINI_API_KEY\..*CLI unavailable: codex\..*Restart or reinstall the daemon/i,
      );
    } finally {
      autoSpy.mockRestore();
    }
  });
});
